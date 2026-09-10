// CIPP API Service
// Wraps all HTTP calls to the CIPP Azure Function App.
// All endpoints live at {baseUrl}/api/{FunctionName} and are authenticated
// with a Bearer token supplied in the Authorization header.
//
// This service is READ-ONLY: every method maps to a CIPP List*/Get* function
// (or ExecBECCheck, which only reads). Parameter names are verified against
// the CIPP-API source (`Invoke-<Name>.ps1`) because CIPP silently ignores
// query/body keys it does not read. Function-name casing in the path is
// load-bearing (e.g. `ListmailboxPermissions`, `listStandardTemplates`).

import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { Logger } from '../utils/logger.js';
import { TokenProvider } from './token.service.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Supported HTTP methods for the internal request helper. */
type HttpMethod = 'GET' | 'POST';

/** Shape of the config slice consumed by {@link CippService}. */
interface CippServiceConfig {
  cipp: {
    baseUrl?: string;
    apiKey?: string;
    tenantId?: string;
    clientId?: string;
    clientSecret?: string;
    tokenScope?: string;
    tokenUrl?: string;
  };
}

/** Aggregated DNS health for a single domain (SPF / DMARC / DKIM). */
export interface DomainHealthCheck {
  domain: string;
  spf: unknown;
  dmarc: unknown;
  dkim: unknown;
}

/**
 * Per-check timeout (ms) for `ListDomainHealth` DNS lookups. Each check
 * resolves DNS server-side at CIPP and can be slow; bounding each one keeps
 * a single stuck lookup from hanging the whole tenant response.
 */
const DOMAIN_HEALTH_CHECK_TIMEOUT_MS = 15_000;

/** BEC check polling: interval and overall budget. */
const BEC_POLL_INTERVAL_MS = 3_000;
const BEC_POLL_BUDGET_MS = 60_000;

/** Only these Exchange verbs are accepted by the raw EXO tool. */
const EXO_READ_ONLY_CMDLET = /^(Get|Search)-[A-Za-z0-9]+$/;

function isAllTenants(tenantFilter: string): boolean {
  return tenantFilter.toLowerCase() === 'alltenants';
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * HTTP client for the CIPP Azure Function App API.
 *
 * @example
 * ```ts
 * const svc = new CippService(config, logger);
 * const tenants = await svc.listTenants();
 * ```
 */
export class CippService {
  private readonly baseUrl: string | undefined;
  private readonly apiKey: string | undefined;
  private readonly tokenProvider: TokenProvider | undefined;
  private readonly logger: Logger;

  constructor(config: CippServiceConfig, logger: Logger) {
    const { baseUrl, apiKey, tenantId, clientId, clientSecret, tokenScope, tokenUrl } = config.cipp;
    this.baseUrl = baseUrl ? baseUrl.replace(/\/$/, '') : undefined;
    this.apiKey = apiKey;
    this.logger = logger;

    // If a static apiKey was supplied, prefer it (backwards-compatible behaviour).
    // Otherwise, if OAuth client-credentials fields are present, build a token
    // provider that will mint CIPP access tokens on demand.
    if (!apiKey && tenantId && clientId && clientSecret) {
      this.tokenProvider = new TokenProvider(
        {
          tenantId,
          clientId,
          clientSecret,
          ...(tokenScope !== undefined ? { scope: tokenScope } : {}),
          ...(tokenUrl !== undefined ? { tokenUrl } : {}),
        },
        logger
      );
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Send an HTTP request to the CIPP API.
   *
   * For GET requests, `params` are serialised as query-string parameters
   * (undefined/null values are skipped). For POST, `body` is serialised as JSON.
   *
   * @throws {McpError} On HTTP errors or network failures.
   */
  private async request<T>(
    method: HttpMethod,
    path: string,
    params?: Record<string, unknown>,
    body?: Record<string, unknown>,
    timeoutMs?: number
  ): Promise<T> {
    if (!this.baseUrl) {
      throw new McpError(ErrorCode.InvalidParams, 'CIPP_BASE_URL is not configured. Set it in your environment or MCP client config.');
    }
    if (!this.apiKey && !this.tokenProvider) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'CIPP authentication is not configured. Set CIPP_API_KEY, or set CIPP_TENANT_ID + CIPP_CLIENT_ID + CIPP_CLIENT_SECRET for OAuth client-credentials auth.'
      );
    }

    const bearer = this.apiKey ?? (await this.tokenProvider!.getAccessToken());

    const url = new URL(`${this.baseUrl}/api/${path}`);

    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null && value !== '') {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${bearer}`,
      'Content-Type': 'application/json',
    };

    const requestInit: RequestInit = { method, headers };

    if (method !== 'GET' && body !== undefined) {
      requestInit.body = JSON.stringify(body);
    }

    if (timeoutMs !== undefined) {
      requestInit.signal = AbortSignal.timeout(timeoutMs);
    }

    this.logger.debug('CIPP API request', { method, url: url.toString() });

    let response: Response;
    try {
      response = await fetch(url.toString(), requestInit);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error('CIPP API network error', { method, url: url.toString(), error: message });
      throw new McpError(
        ErrorCode.InternalError,
        `Network error communicating with CIPP API (${method} ${url.toString()}): ${message}`
      );
    }

    if (!response.ok) {
      let responseBody = '';
      try {
        responseBody = await response.text();
      } catch {
        // ignore read errors; we already have the status code
      }
      this.logger.error('CIPP API HTTP error', {
        method,
        url: url.toString(),
        status: response.status,
        body: responseBody,
      });
      throw new McpError(
        ErrorCode.InternalError,
        `CIPP API returned HTTP ${response.status} for ${method} ${url.toString()}: ${responseBody}`
      );
    }

    const text = await response.text();
    if (text.trim() === '') {
      // Some CIPP endpoints legitimately return HTTP 200 with an empty body.
      return undefined as T;
    }

    try {
      return JSON.parse(text) as T;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to parse CIPP API response as JSON (${method} ${url.toString()}): ${message}`
      );
    }
  }

  // -------------------------------------------------------------------------
  // Core
  // -------------------------------------------------------------------------

  /** Ping the CIPP API (`PublicPing`). */
  async ping<T = unknown>(): Promise<T> {
    return this.request<T>('GET', 'PublicPing');
  }

  /** Current CIPP version information (`GetVersion`). */
  async getVersion<T = unknown>(): Promise<T> {
    return this.request<T>('GET', 'GetVersion');
  }

  /**
   * CIPP platform logs (`ListLogs`). CIPP only applies the Severity / Tenant /
   * User / API filters when `Filter=true` is sent; `Days` widens the window.
   */
  async listLogs<T = unknown>(params: {
    severity?: string;
    tenant?: string;
    user?: string;
    api?: string;
    days?: number;
  }): Promise<T> {
    return this.request<T>('GET', 'ListLogs', {
      Filter: 'true',
      Severity: params.severity,
      Tenant: params.tenant,
      User: params.user,
      API: params.api,
      Days: params.days ?? 1,
    });
  }

  // -------------------------------------------------------------------------
  // Tenants
  // -------------------------------------------------------------------------

  /** All managed tenants (`ListTenants`). */
  async listTenants<T = unknown>(): Promise<T> {
    return this.request<T>('GET', 'ListTenants');
  }

  /** Organisation profile for one tenant (`ListTenantDetails`). */
  async getTenantDetails<T = unknown>(tenantFilter: string): Promise<T> {
    return this.request<T>('GET', 'ListTenantDetails', { tenantFilter });
  }

  /** Summary user counts for a tenant (`ListUserCounts`). */
  async userCounts<T = unknown>(tenantFilter: string): Promise<T> {
    return this.request<T>('GET', 'ListUserCounts', { tenantFilter });
  }

  // -------------------------------------------------------------------------
  // Users
  // -------------------------------------------------------------------------

  /**
   * Users in a tenant (`ListUsers`). Either a single user via `UserID`, or a
   * server-side prefix search translated to a Graph `$filter` via `graphFilter`.
   */
  async listUsers<T = unknown>(
    tenantFilter: string,
    params: { userId?: string; searchField?: string; searchValue?: string }
  ): Promise<T> {
    const query: Record<string, unknown> = { tenantFilter };
    if (params.userId) {
      query.UserID = params.userId;
    } else if (params.searchField && params.searchValue) {
      // OData string literals escape an embedded single quote by doubling it.
      const value = params.searchValue.replace(/'/g, "''");
      query.graphFilter = `startswith(${params.searchField},'${value}')`;
    }
    return this.request<T>('GET', 'ListUsers', query);
  }

  /** MFA registration status for all users in a tenant (`ListMFAUsers`). */
  async listMfaUsers<T = unknown>(tenantFilter: string): Promise<T> {
    return this.request<T>('GET', 'ListMFAUsers', {
      tenantFilter,
      UseReportDB: isAllTenants(tenantFilter) ? 'true' : undefined,
    });
  }

  /** Group memberships for a user (`ListUserGroups`). */
  async listUserGroups<T = unknown>(tenantFilter: string, userId: string): Promise<T> {
    return this.request<T>('GET', 'ListUserGroups', { tenantFilter, userId });
  }

  /** Intune devices registered to a user (`ListUserDevices`). */
  async listUserDevices<T = unknown>(tenantFilter: string, userId: string): Promise<T> {
    return this.request<T>('GET', 'ListUserDevices', { tenantFilter, UserID: userId });
  }

  /** Recent sign-ins for one user (`ListUserSigninLogs`). */
  async listUserSigninLogs<T = unknown>(tenantFilter: string, userId: string, top = 25): Promise<T> {
    return this.request<T>('GET', 'ListUserSigninLogs', { tenantFilter, UserID: userId, top });
  }

  /** Tenant sign-in log (`ListSignIns`). */
  async listSignIns<T = unknown>(
    tenantFilter: string,
    params: { days?: number; failedOnly?: boolean; filter?: string }
  ): Promise<T> {
    return this.request<T>('GET', 'ListSignIns', {
      tenantFilter,
      Days: params.days ?? 7,
      failedLogonsOnly: params.failedOnly ? 'true' : undefined,
      Filter: params.filter,
    });
  }

  /** Accounts with no sign-in for N days (`ListInactiveAccounts`). */
  async listInactiveAccounts<T = unknown>(tenantFilter: string, inactiveDays = 90): Promise<T> {
    return this.request<T>('GET', 'ListInactiveAccounts', { tenantFilter, InactiveDays: inactiveDays });
  }

  /** Guest accounts with lifecycle status (`ListGuestUsers`). */
  async listGuestUsers<T = unknown>(tenantFilter: string, staleDays = 90): Promise<T> {
    return this.request<T>('GET', 'ListGuestUsers', { tenantFilter, staleDays });
  }

  /** Entra role definitions with active members (`ListRoles`). */
  async listRoles<T = unknown>(tenantFilter: string): Promise<T> {
    return this.request<T>('GET', 'ListRoles', { tenantFilter });
  }

  /** Conditional Access policies applying to a user (`ListUserConditionalAccessPolicies`). */
  async listUserConditionalAccessPolicies<T = unknown>(tenantFilter: string, userId: string): Promise<T> {
    return this.request<T>('GET', 'ListUserConditionalAccessPolicies', { tenantFilter, UserID: userId });
  }

  /**
   * Business Email Compromise assessment (`ExecBECCheck`). CIPP queues the
   * check on first call and answers `{ GUID }` / `{ Waiting: true }`; results
   * are fetched by polling with `GUID=<userid>`. This method polls within a
   * fixed budget and returns whatever CIPP has at the end.
   */
  async becCheck<T = unknown>(
    tenantFilter: string,
    userId: string,
    userName: string,
    overwrite = false
  ): Promise<T> {
    const first = await this.request<Record<string, unknown>>('GET', 'ExecBECCheck', {
      tenantFilter,
      userid: userId,
      userName,
      overwrite: overwrite ? 'true' : undefined,
    });
    if (!this.becIsWaiting(first)) return first as T;

    const deadline = Date.now() + BEC_POLL_BUDGET_MS;
    let latest: Record<string, unknown> = first;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, BEC_POLL_INTERVAL_MS));
      latest = await this.request<Record<string, unknown>>('GET', 'ExecBECCheck', {
        tenantFilter,
        userid: userId,
        userName,
        GUID: userId,
      });
      if (!this.becIsWaiting(latest)) return latest as T;
    }
    return { Waiting: true, GUID: userId, note: 'Assessment still running; call again to fetch results.' } as T;
  }

  private becIsWaiting(payload: unknown): boolean {
    if (!payload || typeof payload !== 'object') return true;
    const obj = payload as Record<string, unknown>;
    if (obj.Waiting === true) return true;
    // First call returns only the GUID it queued under.
    const keys = Object.keys(obj);
    return keys.length === 1 && keys[0] === 'GUID';
  }

  // -------------------------------------------------------------------------
  // Groups
  // -------------------------------------------------------------------------

  /**
   * Groups in a tenant (`ListGroups`). With `groupId` and `members`/`owners`
   * the endpoint returns that group's members/owners instead of the group list.
   */
  async listGroups<T = unknown>(
    tenantFilter: string,
    params: { groupId?: string; members?: boolean; owners?: boolean }
  ): Promise<T> {
    return this.request<T>('GET', 'ListGroups', {
      tenantFilter,
      groupID: params.groupId,
      members: params.members ? 'true' : undefined,
      owners: params.owners && !params.members ? 'true' : undefined,
    });
  }

  // -------------------------------------------------------------------------
  // Mailboxes
  // -------------------------------------------------------------------------

  /**
   * Exchange mailboxes (`ListMailboxes`). CIPP maps query params onto
   * `Get-Mailbox` via an allow-list: `RecipientTypeDetails`, `Identity`, `Filter`.
   */
  async listMailboxes<T = unknown>(
    tenantFilter: string,
    params: { type?: string; identity?: string; displayName?: string }
  ): Promise<T> {
    const query: Record<string, unknown> = { tenantFilter };
    if (params.type) query.RecipientTypeDetails = params.type;
    if (params.identity) query.Identity = params.identity;
    if (params.displayName) {
      // OPATH single-quoted literals escape an embedded quote by doubling it.
      const value = params.displayName.replace(/'/g, "''");
      query.Filter = `DisplayName -like '*${value}*'`;
    }
    return this.request<T>('GET', 'ListMailboxes', query);
  }

  /** Detailed mailbox properties for one user (`ListUserMailboxDetails`). */
  async getUserMailboxDetails<T = unknown>(tenantFilter: string, userId: string): Promise<T> {
    return this.request<T>('GET', 'ListUserMailboxDetails', { tenantFilter, UserID: userId });
  }

  /** Mailbox permissions (`ListmailboxPermissions`; lowercase m is load-bearing). */
  async listMailboxPermissions<T = unknown>(tenantFilter: string, upn: string): Promise<T> {
    return this.request<T>('GET', 'ListmailboxPermissions', { tenantFilter, userId: upn });
  }

  /** Calendar folder permissions (`ListCalendarPermissions`). */
  async listCalendarPermissions<T = unknown>(tenantFilter: string, upn: string): Promise<T> {
    return this.request<T>('GET', 'ListCalendarPermissions', { tenantFilter, UserID: upn });
  }

  /** Inbox rules on one mailbox (`ListUserMailboxRules`). */
  async listUserMailboxRules<T = unknown>(tenantFilter: string, userId: string): Promise<T> {
    return this.request<T>('GET', 'ListUserMailboxRules', { tenantFilter, UserID: userId });
  }

  /** Mailboxes with forwarding configured (`ListMailboxForwarding`). */
  async listMailboxForwarding<T = unknown>(tenantFilter: string): Promise<T> {
    return this.request<T>('GET', 'ListMailboxForwarding', {
      tenantFilter,
      UseReportDB: isAllTenants(tenantFilter) ? 'true' : undefined,
    });
  }

  /** Out-of-office configuration for a mailbox (`ListOoO`). */
  async getOutOfOffice<T = unknown>(tenantFilter: string, userId: string): Promise<T> {
    return this.request<T>('GET', 'ListOoO', { tenantFilter, userid: userId });
  }

  /** Message trace (`ListMessageTrace`, POST body). */
  async messageTrace<T = unknown>(
    tenantFilter: string,
    params: { sender?: string; recipient?: string; messageId?: string; days?: number; status?: string }
  ): Promise<T> {
    const days = Math.min(Math.max(params.days ?? 2, 1), 10);
    const body: Record<string, unknown> = { tenantFilter, days };
    if (params.sender) body.sender = params.sender;
    if (params.recipient) body.recipient = params.recipient;
    if (params.messageId) body.messageId = params.messageId;
    if (params.status) body.status = params.status;
    return this.request<T>('POST', 'ListMessageTrace', undefined, body);
  }

  // -------------------------------------------------------------------------
  // Devices
  // -------------------------------------------------------------------------

  /** Intune managed devices (`ListDevices`). */
  async listDevices<T = unknown>(tenantFilter: string): Promise<T> {
    return this.request<T>('GET', 'ListDevices', { tenantFilter });
  }

  /** One device by ID, name or serial (`ListDeviceDetails`). */
  async getDeviceDetails<T = unknown>(
    tenantFilter: string,
    params: { deviceId?: string; deviceName?: string; serial?: string }
  ): Promise<T> {
    return this.request<T>('GET', 'ListDeviceDetails', {
      tenantFilter,
      DeviceID: params.deviceId,
      DeviceName: params.deviceName,
      DeviceSerial: params.serial,
    });
  }

  // -------------------------------------------------------------------------
  // Security & Conditional Access
  // -------------------------------------------------------------------------

  /** Conditional Access policies (`ListConditionalAccessPolicies`). */
  async listConditionalAccessPolicies<T = unknown>(tenantFilter: string): Promise<T> {
    return this.request<T>('GET', 'ListConditionalAccessPolicies', { tenantFilter });
  }

  /** Named locations (`ListNamedLocations`). */
  async listNamedLocations<T = unknown>(tenantFilter: string): Promise<T> {
    return this.request<T>('GET', 'ListNamedLocations', { tenantFilter });
  }

  /** Cached Secure Score per tenant (`ListSecureScoreReport`). */
  async getSecureScore<T = unknown>(tenantFilter: string): Promise<T> {
    return this.request<T>('GET', 'ListSecureScoreReport', { tenantFilter });
  }

  // -------------------------------------------------------------------------
  // Standards
  // -------------------------------------------------------------------------

  /** Standards applied to a tenant (`ListStandards`). */
  async listStandards<T = unknown>(tenantFilter: string, consolidated = false): Promise<T> {
    return this.request<T>('GET', 'ListStandards', {
      tenantFilter,
      ShowConsolidated: consolidated ? 'true' : undefined,
    });
  }

  /** Standards Templates (`listStandardTemplates`; lowercase l is load-bearing). */
  async listStandardTemplates<T = unknown>(templateId?: string): Promise<T> {
    return this.request<T>('GET', 'listStandardTemplates', templateId ? { id: templateId } : undefined);
  }

  /** Standards drift (`ListTenantDrift`), optionally scoped to one tenant. */
  async getTenantDrift<T = unknown>(tenantFilter?: string): Promise<T> {
    return this.request<T>('GET', 'ListTenantDrift', tenantFilter ? { tenantFilter } : undefined);
  }

  /**
   * Tenant alignment against Standards Templates (`ListTenantAlignment`).
   * CIPP reads only `summary` / `granular` here — it has no tenant filter —
   * so per-tenant scoping is applied by the caller on the `tenantFilter` column.
   */
  async getTenantAlignment<T = unknown>(summary = false): Promise<T> {
    return this.request<T>('GET', 'ListTenantAlignment', summary ? { summary: 'true' } : undefined);
  }

  /** Cached Domain Analyser results (`ListDomainAnalyser`). */
  async listDomainAnalyser<T = unknown>(tenantFilter: string): Promise<T> {
    return this.request<T>('GET', 'ListDomainAnalyser', { tenantFilter });
  }

  /** Verified domains in a tenant (`ListDomains`). */
  async listDomains<T = unknown>(tenantFilter: string): Promise<T> {
    return this.request<T>('GET', 'ListDomains', { tenantFilter });
  }

  /**
   * Live DNS health (SPF, DMARC, DKIM) for every domain in a tenant.
   *
   * `ListDomainHealth` is a per-domain DNS helper (requires `Action` +
   * `Domain`, ignores `tenantFilter`), so this enumerates the tenant's domains
   * via `ListDomains` first and runs the three checks per domain.
   */
  async listDomainHealth(tenantFilter: string): Promise<DomainHealthCheck[]> {
    const domains = await this.listDomains<Array<{ id?: string }>>(tenantFilter);
    const domainNames = (Array.isArray(domains) ? domains : [])
      .map((d) => d?.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
      // The .onmicrosoft.com routing domain carries no customer mail DNS.
      .filter((id) => !id.toLowerCase().endsWith('.onmicrosoft.com'));

    return Promise.all(
      domainNames.map(async (domain) => {
        const [spf, dmarc, dkim] = await Promise.all([
          this.checkDomainRecord(domain, 'ReadSpfRecord'),
          this.checkDomainRecord(domain, 'ReadDmarcPolicy'),
          this.checkDomainRecord(domain, 'ReadDkimRecord'),
        ]);
        return { domain, spf, dmarc, dkim };
      })
    );
  }

  private async checkDomainRecord(domain: string, action: string): Promise<unknown> {
    try {
      return await this.request(
        'GET',
        'ListDomainHealth',
        { Action: action, Domain: domain },
        undefined,
        DOMAIN_HEALTH_CHECK_TIMEOUT_MS
      );
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  // -------------------------------------------------------------------------
  // Licenses
  // -------------------------------------------------------------------------

  /** License SKUs and counts (`ListLicenses`). */
  async listLicenses<T = unknown>(tenantFilter: string, includeExcluded = false): Promise<T> {
    return this.request<T>('GET', 'ListLicenses', {
      tenantFilter,
      IncludeExcluded: includeExcluded ? 'true' : undefined,
    });
  }

  /** Detailed license overview (`ListLicensesReport`). */
  async listLicensesReport<T = unknown>(tenantFilter: string): Promise<T> {
    return this.request<T>('GET', 'ListLicensesReport', { tenantFilter });
  }

  // -------------------------------------------------------------------------
  // Alerts, logs & health
  // -------------------------------------------------------------------------

  /** CIPP-captured audit log entries (`ListAuditLogs`); `days` becomes `RelativeTime`. */
  async listAuditLogs<T = unknown>(tenantFilter: string, days = 7): Promise<T> {
    return this.request<T>('GET', 'ListAuditLogs', { tenantFilter, RelativeTime: `${days}d` });
  }

  /** Configured alert rules (`ListAlertsQueue`). */
  async listAlertQueue<T = unknown>(): Promise<T> {
    return this.request<T>('GET', 'ListAlertsQueue');
  }

  /** Active fired alert items (`ListAlertResults`). */
  async listAlertResults<T = unknown>(tenantFilter: string): Promise<T> {
    return this.request<T>('GET', 'ListAlertResults', { tenantFilter });
  }

  /** Microsoft 365 service health (`ListServiceHealth`). */
  async listServiceHealth<T = unknown>(tenantFilter: string): Promise<T> {
    return this.request<T>('GET', 'ListServiceHealth', { tenantFilter });
  }

  // -------------------------------------------------------------------------
  // GDAP
  // -------------------------------------------------------------------------

  /** GDAP role mappings (`ListGDAPRoles`). */
  async listGDAPRoles<T = unknown>(): Promise<T> {
    return this.request<T>('GET', 'ListGDAPRoles');
  }

  /** GDAP invites (`ListGDAPInvite`). */
  async listGDAPInvites<T = unknown>(): Promise<T> {
    return this.request<T>('GET', 'ListGDAPInvite');
  }

  /** GDAP relationships (`ListGDAPRelationships`). */
  async listGDAPRelationships<T = unknown>(): Promise<T> {
    return this.request<T>('GET', 'ListGDAPRelationships');
  }

  // -------------------------------------------------------------------------
  // Scheduler
  // -------------------------------------------------------------------------

  /** Scheduled tasks (`ListScheduledItems`). */
  async listScheduledItems<T = unknown>(params: {
    tenantFilter?: string;
    name?: string;
    type?: string;
    showHidden?: boolean;
  }): Promise<T> {
    return this.request<T>('GET', 'ListScheduledItems', {
      tenantFilter: params.tenantFilter,
      Name: params.name,
      Type: params.type,
      ShowHidden: params.showHidden ? 'true' : undefined,
    });
  }

  // -------------------------------------------------------------------------
  // Raw read-only access
  // -------------------------------------------------------------------------

  /**
   * Arbitrary Microsoft Graph GET via CIPP (`ListGraphRequest`). Always sends
   * `NoPagination=true` because CIPP otherwise follows every `@odata.nextLink`
   * and `$top` alone would not bound the result.
   */
  async graphRequest<T = unknown>(
    tenantFilter: string,
    params: {
      endpoint: string;
      select?: string;
      filter?: string;
      search?: string;
      orderby?: string;
      expand?: string;
      top?: number;
      countOnly?: boolean;
      version?: string;
    }
  ): Promise<T> {
    const top = Math.min(Math.max(params.top ?? 50, 1), 999);
    return this.request<T>('GET', 'ListGraphRequest', {
      tenantFilter,
      Endpoint: params.endpoint.replace(/^\/+/, ''),
      $select: params.select,
      $filter: params.filter,
      $search: params.search,
      $orderby: params.orderby,
      $expand: params.expand,
      $top: params.countOnly ? undefined : top,
      $count: params.search || params.countOnly ? 'true' : undefined,
      CountOnly: params.countOnly ? 'true' : undefined,
      NoPagination: 'true',
      Version: params.version,
    });
  }

  /**
   * Read-only Exchange Online cmdlet via CIPP (`ListExoRequest`). Only
   * `Get-*` / `Search-*` cmdlets are accepted; CIPP enforces the same rule
   * server-side.
   */
  async exoRequest<T = unknown>(
    tenantFilter: string,
    cmdlet: string,
    cmdParams: Record<string, unknown> | undefined,
    select: string
  ): Promise<T> {
    if (!EXO_READ_ONLY_CMDLET.test(cmdlet)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `cmdlet "${cmdlet}" is not allowed: only Get-* and Search-* Exchange cmdlets can be run through this read-only tool.`
      );
    }
    return this.request<T>('POST', 'ListExoRequest', undefined, {
      TenantFilter: tenantFilter,
      Cmdlet: cmdlet,
      cmdParams: cmdParams ?? {},
      Select: select,
    });
  }
}
