// CIPP Tool Handler
// Validates each MCP tool call, dispatches it to the matching CippService
// method, applies any client-side filters CIPP cannot do server-side, and
// formats the result (CSV for lists, compact JSON for single records).

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { CippService } from '../services/cipp.service.js';
import { Logger } from '../utils/logger.js';
import {
  McpToolDefinition,
  findToolDefinition,
  publicToolDefinitions,
} from '../mcp/tool.definitions.js';
import { validateArgs } from '../utils/validate.js';
import {
  ListOutputOptions,
  OutputFormat,
  cellValue,
  fieldContains,
  filterList,
  filterListByTerm,
  formatList,
  formatObject,
  getPath,
  mapList,
  stripHtml,
  unwrapList,
} from '../utils/format.js';

export interface McpToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

type Args = Record<string, unknown>;

/** Bulky Graph user sub-objects nobody needs in a helpdesk answer. */
const USER_DROP_KEYS = [
  'assignedPlans',
  'provisionedPlans',
  'authorizationInfo',
  'cloudRealtimeCommunicationInfo',
  'onPremisesExtensionAttributes',
  'onPremisesSipInfo',
  'onPremisesProvisioningErrors',
  'serviceProvisioningErrors',
  'identities',
  'deviceKeys',
  'infoCatalogs',
  'identityProfileIds',
  'inviteTicket',
  'employeeOrgData',
  'passwordProfile',
  '@odata.context',
  'proxyAddresses',
];

/** Keys of ListUserMailboxDetails that duplicate the summary fields in bulk. */
const MAILBOX_DETAILS_DROP_KEYS = ['Mailbox', 'MailboxActionsData'];

const GROUP_MEMBER_COLUMNS = ['displayName', 'userPrincipalName', 'mail', 'id'];

/** How long a resolved tenant list is reused before ListTenants is called again. */
const TENANT_CACHE_MS = 10 * 60 * 1000;

/** Fields kept per BEC section in the summary; sections not listed keep their scalar fields. */
const BEC_SECTION_FIELDS: Record<string, string[]> = {
  SuspectUserSignIns: ['CreatedDateTime', 'AppDisplayName', 'ClientAppUsed', 'Status', 'IPAddress', 'Country', 'City', 'ForeignLocation'],
  LastSuspectUserLogon: ['CreatedDateTime', 'AppDisplayName', 'ClientAppUsed', 'Status', 'IPAddress', 'Country', 'City', 'ForeignLocation'],
  TenantLastSignIns: ['CreatedDateTime', 'userPrincipalName', 'AppDisplayName', 'Status', 'IPAddress', 'Country', 'City'],
  SuspectUserDevices: ['DeviceFriendlyName', 'DeviceModel', 'DeviceOS', 'DeviceType', 'ClientType', 'DeviceAccessState', 'FirstSyncTime', 'LastSuccessSync'],
  IntuneDevices: ['deviceName', 'operatingSystem', 'osVersion', 'complianceState', 'lastSyncDateTime', 'enrolledDateTime'],
  AddedApps: ['displayName', 'createdDateTime', 'appId', 'MaliciousMatch'],
  MaliciousSPs: ['displayName', 'appId', 'Name', 'Categories', 'Description'],
  NewRules: ['Name', 'Enabled', 'Description', 'From', 'ForwardTo', 'ForwardAsAttachmentTo', 'RedirectTo', 'DeleteMessage', 'MoveToFolder'],
  MFADevices: ['@odata.type', 'displayName', 'createdDateTime', 'phoneNumber', 'emailAddress', 'deviceTag'],
};

/** Sections where the tenant-wide noise is high; keep fewer items. */
const BEC_SECTION_LIMITS: Record<string, number> = { TenantLastSignIns: 5 };

function becInteresting(item: unknown): number {
  const foreign = getPath(item, 'ForeignLocation') === true;
  const failed = cellValue(getPath(item, 'Status')).toLowerCase() === 'failed';
  return (foreign ? 2 : 0) + (failed ? 1 : 0);
}

/**
 * Reduce a CIPP BEC result to counts plus the most relevant items per section
 * so it fits comfortably in context. Sign-in sections are ordered foreign /
 * failed first; nested objects are dropped unless a section lists them.
 */
export function summarizeBecResult(result: unknown, itemsPerSection = 10): unknown {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(result as Record<string, unknown>)) {
    if (!Array.isArray(value)) {
      out[key] = value;
      continue;
    }
    const limit = BEC_SECTION_LIMITS[key] ?? itemsPerSection;
    const fields = BEC_SECTION_FIELDS[key];
    const ordered = [...value].sort((a, b) => becInteresting(b) - becInteresting(a));
    const items = ordered.slice(0, limit).map((item) => {
      if (!item || typeof item !== 'object') return item;
      const rec = item as Record<string, unknown>;
      if (fields) {
        const proj: Record<string, unknown> = {};
        for (const f of fields) {
          const v = getPath(rec, f);
          if (v !== undefined && v !== null && v !== '') proj[f] = v;
        }
        return proj;
      }
      const scalars: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(rec)) {
        if (v !== null && v !== '' && typeof v !== 'object') scalars[k] = v;
      }
      return scalars;
    });
    const flagged = value.filter((v) => becInteresting(v) > 0).length;
    out[key] = {
      count: value.length,
      ...(fields && key.toLowerCase().includes('signin') ? { foreignOrFailed: flagged } : {}),
      ...(value.length > items.length ? { shown: items.length } : {}),
      items,
    };
  }
  return out;
}

export class CippToolHandler {
  private cippService: CippService;
  private logger: Logger;
  private mcpServer: Server | null = null;
  private tenantCache: { at: number; rows: Record<string, unknown>[] } | undefined;

  constructor(cippService: CippService, logger: Logger) {
    this.cippService = cippService;
    this.logger = logger;
  }

  setServer(server: Server): void {
    this.mcpServer = server;
  }

  getServer(): Server | null {
    return this.mcpServer;
  }

  /** Tool definitions as advertised to clients (server-private fields stripped). */
  getToolDefinitions() {
    return publicToolDefinitions();
  }

  async handleToolCall(name: string, rawArgs: Record<string, unknown>): Promise<McpToolResult> {
    this.logger.debug(`Dispatching tool call: ${name}`, { args: rawArgs });

    const def = findToolDefinition(name);
    if (!def) {
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }

    const args = validateArgs(def, rawArgs);
    const out: ListOutputOptions = {
      fields: args.fields as string[] | undefined,
      limit: args.limit as number | undefined,
      format: args.format as OutputFormat | undefined,
    };

    try {
      let note = '';
      if (typeof args.tenantFilter === 'string' && def.name !== 'cipp_list_tenants') {
        const resolved = await this.resolveTenant(args.tenantFilter);
        if (resolved !== args.tenantFilter) {
          note = `# tenantFilter "${args.tenantFilter}" resolved to ${resolved}\n`;
          args.tenantFilter = resolved;
        }
      }
      const text = await this.dispatch(def, args, out);
      return { content: [{ type: 'text', text: note + text }] };
    } catch (error) {
      if (error instanceof McpError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Tool call failed: ${name}`, { error: message });
      throw new McpError(ErrorCode.InternalError, `Tool ${name} failed: ${message}`);
    }
  }

  // -------------------------------------------------------------------------
  // Formatting shortcuts
  // -------------------------------------------------------------------------

  private list(data: unknown, def: McpToolDefinition, out: ListOutputOptions, columns?: string[]): string {
    return formatList(data, columns ?? def.columns ?? [], out);
  }

  private object(data: unknown, dropKeys: string[] = []): string {
    return formatObject(data, dropKeys);
  }

  private str(args: Args, key: string): string | undefined {
    const v = args[key];
    return typeof v === 'string' ? v : undefined;
  }

  private bool(args: Args, key: string): boolean | undefined {
    const v = args[key];
    return typeof v === 'boolean' ? v : undefined;
  }

  private num(args: Args, key: string): number | undefined {
    const v = args[key];
    return typeof v === 'number' ? v : undefined;
  }

  /**
   * Cached CIPP tenant rows for {@link resolveTenant}. Failures return an
   * empty list so tenant resolution degrades to pass-through.
   */
  private async tenantRows(): Promise<Record<string, unknown>[]> {
    const now = Date.now();
    if (this.tenantCache && now - this.tenantCache.at < TENANT_CACHE_MS) return this.tenantCache.rows;
    try {
      const data = await this.cippService.listTenants();
      const rows = (unwrapList(data) ?? []).filter(
        (r): r is Record<string, unknown> => !!r && typeof r === 'object'
      );
      this.tenantCache = { at: now, rows };
      return rows;
    } catch (err) {
      this.logger.warn('Tenant resolution skipped: ListTenants failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /**
   * Map whatever the caller passed as tenantFilter onto the value CIPP
   * accepts (the tenant's default domain). Exact matches on default domain,
   * tenant ID or initial domain pass through; otherwise the display name or
   * the first DNS label (so "rentpeak.com" finds "RentPeak.onmicrosoft.com")
   * is tried and must be unambiguous.
   */
  private async resolveTenant(tenantFilter: string): Promise<string> {
    const lc = tenantFilter.trim().toLowerCase();
    if (!lc || lc === 'alltenants') return tenantFilter;
    const rows = await this.tenantRows();
    if (rows.length === 0) return tenantFilter;

    const val = (r: unknown, k: string) => cellValue(getPath(r, k)).toLowerCase();
    const exact = rows.find((r) =>
      ['defaultDomainName', 'customerId', 'initialDomainName'].some((k) => val(r, k) === lc)
    );
    if (exact) return cellValue(getPath(exact, 'defaultDomainName')) || tenantFilter;

    const label = lc.split('@').pop()!.split('.')[0];
    const compact = lc.replace(/[^a-z0-9]/g, '');
    const fuzzy = rows.filter((r) => {
      const name = val(r, 'displayName');
      return (
        name === lc ||
        name.replace(/[^a-z0-9]/g, '') === compact ||
        val(r, 'defaultDomainName').split('.')[0] === label ||
        val(r, 'initialDomainName').split('.')[0] === label ||
        val(r, 'domains').split(/[,;\s]+/).includes(lc)
      );
    });
    if (fuzzy.length === 1) return cellValue(getPath(fuzzy[0], 'defaultDomainName')) || tenantFilter;

    const hint =
      fuzzy.length > 1
        ? ` It is ambiguous between: ${fuzzy.map((r) => cellValue(getPath(r, 'defaultDomainName'))).join(', ')}.`
        : '';
    throw new McpError(
      ErrorCode.InvalidParams,
      `tenantFilter "${tenantFilter}" is not a tenant CIPP knows.${hint} Use cipp_list_tenants with search to find the default domain.`
    );
  }

  /**
   * CIPP's ListUserSigninLogs filters Graph on `userId eq '<guid>'`, so a UPN
   * must be resolved to the object ID first. GUIDs pass through untouched.
   */
  private async resolveUserObjectId(tenant: string, userId: string): Promise<string> {
    if (!userId.includes('@')) return userId;
    const data = await this.cippService.listUsers(tenant, { userId });
    const rows = unwrapList(data) ?? (data ? [data] : []);
    const id = rows.length > 0 ? getPath(rows[0], 'id') : undefined;
    if (typeof id !== 'string' || id.length === 0) {
      throw new McpError(ErrorCode.InvalidParams, `Could not resolve user "${userId}" to an object ID in ${tenant}.`);
    }
    return id;
  }

  // -------------------------------------------------------------------------
  // Dispatch
  // -------------------------------------------------------------------------

  private async dispatch(def: McpToolDefinition, a: Args, out: ListOutputOptions): Promise<string> {
    const svc = this.cippService;
    const tenant = this.str(a, 'tenantFilter') as string;

    switch (def.name) {
      // ----------------------------------------------------------------- Tenants
      case 'cipp_list_tenants': {
        let data = await svc.listTenants();
        if (!this.bool(a, 'includeExcluded')) {
          data = filterList(data, (r) => getPath(r, 'Excluded') !== true);
        }
        const search = this.str(a, 'search');
        if (search) {
          data = filterList(
            data,
            (r) =>
              fieldContains(r, 'displayName', search) ||
              fieldContains(r, 'defaultDomainName', search) ||
              fieldContains(r, 'initialDomainName', search) ||
              fieldContains(r, 'domains', search) ||
              fieldContains(r, 'customerId', search)
          );
        }
        return this.list(data, def, out);
      }

      case 'cipp_get_tenant_details': {
        const data = await svc.getTenantDetails(tenant);
        return this.object(data, this.bool(a, 'full') ? [] : ['assignedPlans', 'provisionedPlans']);
      }

      case 'cipp_user_counts':
        return this.object(await svc.userCounts(tenant));

      // ------------------------------------------------------------------- Users
      case 'cipp_list_users': {
        const data = await svc.listUsers(tenant, {
          userId: this.str(a, 'userId'),
          searchField: this.str(a, 'searchField'),
          searchValue: this.str(a, 'searchValue'),
        });
        return this.list(data, def, out);
      }

      case 'cipp_get_user': {
        const data = await svc.listUsers(tenant, { userId: this.str(a, 'userId') });
        const rows = unwrapList(data);
        const record = rows ? rows[0] : data;
        if (record === undefined) return '# no data';
        return this.object(record, USER_DROP_KEYS);
      }

      case 'cipp_list_mfa_users': {
        let data = await svc.listMfaUsers(tenant);
        const user = this.str(a, 'user');
        if (user) data = filterListByTerm(data, user);
        if (this.bool(a, 'unregisteredOnly')) {
          data = filterList(
            data,
            (r) =>
              getPath(r, 'MFARegistration') !== true &&
              getPath(r, 'AccountEnabled') === true &&
              getPath(r, 'isLicensed') === true
          );
        }
        return this.list(data, def, out);
      }

      case 'cipp_list_user_groups':
        return this.list(await svc.listUserGroups(tenant, this.str(a, 'userId') as string), def, out);

      case 'cipp_list_user_devices':
        return this.list(await svc.listUserDevices(tenant, this.str(a, 'userId') as string), def, out);

      case 'cipp_list_user_signin_logs': {
        const objectId = await this.resolveUserObjectId(tenant, this.str(a, 'userId') as string);
        return this.list(await svc.listUserSigninLogs(tenant, objectId, this.num(a, 'top') ?? 25), def, out);
      }

      case 'cipp_list_signins': {
        let data = await svc.listSignIns(tenant, {
          days: this.num(a, 'days'),
          failedOnly: this.bool(a, 'failedOnly'),
          filter: this.str(a, 'filter'),
        });
        const user = this.str(a, 'user');
        if (user) {
          data = filterList(
            data,
            (r) => fieldContains(r, 'userPrincipalName', user) || fieldContains(r, 'userDisplayName', user)
          );
        }
        return this.list(data, def, out);
      }

      case 'cipp_list_inactive_accounts':
        return this.list(await svc.listInactiveAccounts(tenant, this.num(a, 'inactiveDays') ?? 90), def, out);

      case 'cipp_list_guest_users': {
        let data = await svc.listGuestUsers(tenant, this.num(a, 'staleDays') ?? 90);
        const status = this.str(a, 'status');
        if (status) {
          data = filterList(data, (r) => fieldContains(r, 'status', status) || fieldContains(r, 'lifecycleStatus', status));
        }
        return this.list(data, def, out);
      }

      case 'cipp_list_roles': {
        let data = await svc.listRoles(tenant);
        data = mapList(data, (r) => {
          const members = getPath(r, 'Members');
          const upns = Array.isArray(members)
            ? members
                .map((m) => getPath(m, 'userPrincipalName') ?? getPath(m, 'displayName') ?? getPath(m, 'id'))
                .filter((v) => v !== undefined && v !== null)
                .map((v) => cellValue(v))
            : [];
          return {
            ...(r as Record<string, unknown>),
            MemberCount: getPath(r, 'MemberCount') ?? upns.length,
            MemberUPNs: upns.join(';'),
          };
        });
        if (this.bool(a, 'withMembersOnly') !== false) {
          data = filterList(data, (r) => Number(getPath(r, 'MemberCount') ?? 0) > 0);
        }
        const role = this.str(a, 'role');
        if (role) data = filterList(data, (r) => fieldContains(r, 'DisplayName', role));
        return this.list(data, def, out);
      }

      case 'cipp_list_user_ca_policies':
        return this.list(
          await svc.listUserConditionalAccessPolicies(tenant, this.str(a, 'userId') as string),
          def,
          out
        );

      case 'cipp_bec_check': {
        const rawUser = this.str(a, 'userId') as string;
        const userName = this.str(a, 'userName') ?? (rawUser.includes('@') ? rawUser : undefined);
        if (!userName) {
          throw new McpError(ErrorCode.InvalidParams, 'cipp_bec_check: userName (the UPN) is required when userId is an object ID.');
        }
        const objectId = await this.resolveUserObjectId(tenant, rawUser);
        const result = await svc.becCheck(tenant, objectId, userName, this.bool(a, 'overwrite') ?? false);
        if (this.bool(a, 'full')) return this.object(result);
        return this.object(summarizeBecResult(result, this.num(a, 'itemsPerSection') ?? 10));
      }

      // ------------------------------------------------------------------ Groups
      case 'cipp_list_groups': {
        const groupId = this.str(a, 'groupId');
        const members = this.bool(a, 'members') ?? false;
        const owners = this.bool(a, 'owners') ?? false;
        let data = await svc.listGroups(tenant, { groupId, members, owners });
        if (groupId) {
          // With groupID CIPP returns { groupInfo, members, owners, allowExternal, ... }.
          const detail = (unwrapList(data) ?? [data])[0] as Record<string, unknown> | undefined;
          if (members || owners) {
            const key = members ? 'members' : 'owners';
            const list = detail && Array.isArray(detail[key]) ? detail[key] : (detail?.[key] ?? []);
            return this.list(list, def, out, GROUP_MEMBER_COLUMNS);
          }
          const info = detail?.groupInfo ?? detail;
          return this.object(info, ['@odata.context']);
        }
        const search = this.str(a, 'search');
        if (search) {
          data = filterList(
            data,
            (r) =>
              fieldContains(r, 'displayName', search) ||
              fieldContains(r, 'mail', search) ||
              fieldContains(r, 'mailNickname', search)
          );
        }
        const groupType = this.str(a, 'groupType');
        if (groupType) {
          data = filterList(
            data,
            (r) => fieldContains(r, 'calculatedGroupType', groupType) || fieldContains(r, 'groupTypes', groupType)
          );
        }
        return this.list(data, def, out);
      }

      // --------------------------------------------------------------- Mailboxes
      case 'cipp_list_mailboxes':
        return this.list(
          await svc.listMailboxes(tenant, {
            identity: this.str(a, 'identity'),
            displayName: this.str(a, 'displayName'),
            type: this.str(a, 'type'),
          }),
          def,
          out
        );

      case 'cipp_get_user_mailbox_details': {
        const data = await svc.getUserMailboxDetails(tenant, this.str(a, 'userId') as string);
        const rows = unwrapList(data);
        const record = rows ? rows[0] : data;
        return this.object(record, this.bool(a, 'full') ? [] : MAILBOX_DETAILS_DROP_KEYS);
      }

      case 'cipp_list_mailbox_permissions':
        return this.list(await svc.listMailboxPermissions(tenant, this.str(a, 'upn') as string), def, out);

      case 'cipp_list_calendar_permissions':
        return this.list(await svc.listCalendarPermissions(tenant, this.str(a, 'upn') as string), def, out);

      case 'cipp_list_user_mailbox_rules':
        return this.list(await svc.listUserMailboxRules(tenant, this.str(a, 'userId') as string), def, out);

      case 'cipp_list_mailbox_forwarding': {
        let data = await svc.listMailboxForwarding(tenant);
        if (this.bool(a, 'externalOnly')) {
          data = filterList(data, (r) => cellValue(getPath(r, 'ForwardingSmtpAddress')).trim() !== '');
        }
        return this.list(data, def, out);
      }

      case 'cipp_get_out_of_office': {
        const data = await svc.getOutOfOffice(tenant, this.str(a, 'userId') as string);
        if (data && typeof data === 'object' && !Array.isArray(data)) {
          const copy = { ...(data as Record<string, unknown>) };
          for (const key of ['InternalMessage', 'ExternalMessage', 'DeclineMeetingMessage']) {
            if (key in copy) copy[key] = stripHtml(copy[key]);
          }
          return this.object(copy);
        }
        return this.object(data);
      }

      case 'cipp_message_trace': {
        let data = await svc.messageTrace(tenant, {
          sender: this.str(a, 'sender'),
          recipient: this.str(a, 'recipient'),
          messageId: this.str(a, 'messageId'),
          days: this.num(a, 'days'),
          status: this.str(a, 'status'),
        });
        const subject = this.str(a, 'subject');
        if (subject) {
          data = filterList(data, (r) => fieldContains(r, 'Subject', subject) || fieldContains(r, 'subject', subject));
        }
        return this.list(data, def, out);
      }

      // ----------------------------------------------------------------- Devices
      case 'cipp_list_devices': {
        let data = await svc.listDevices(tenant);
        const search = this.str(a, 'search');
        if (search) {
          data = filterList(
            data,
            (r) =>
              fieldContains(r, 'deviceName', search) ||
              fieldContains(r, 'userPrincipalName', search) ||
              fieldContains(r, 'serialNumber', search)
          );
        }
        if (this.bool(a, 'nonCompliantOnly')) {
          data = filterList(data, (r) => cellValue(getPath(r, 'complianceState')).toLowerCase() !== 'compliant');
        }
        const os = this.str(a, 'os');
        if (os) data = filterList(data, (r) => fieldContains(r, 'operatingSystem', os));
        return this.list(data, def, out);
      }

      case 'cipp_get_device':
        return this.object(
          await svc.getDeviceDetails(tenant, {
            deviceId: this.str(a, 'deviceId'),
            deviceName: this.str(a, 'deviceName'),
            serial: this.str(a, 'serial'),
          })
        );

      // ---------------------------------------------------------------- Security
      case 'cipp_list_conditional_access_policies': {
        let data = await svc.listConditionalAccessPolicies(tenant);
        const policyId = this.str(a, 'policyId');
        if (policyId) {
          const match = (unwrapList(data) ?? []).find(
            (r) => cellValue(getPath(r, 'id')).toLowerCase() === policyId.toLowerCase()
          );
          return match ? this.object(match, ['rawjson']) : `# no policy with id ${policyId}`;
        }
        const name = this.str(a, 'name');
        if (name) data = filterList(data, (r) => fieldContains(r, 'displayName', name));
        return this.list(data, def, out);
      }

      case 'cipp_list_named_locations':
        return this.list(await svc.listNamedLocations(tenant), def, out);

      case 'cipp_get_secure_score':
        return this.list(await svc.getSecureScore(tenant), def, out);

      // --------------------------------------------------------------- Standards
      case 'cipp_list_standards':
        return this.list(await svc.listStandards(tenant, this.bool(a, 'consolidated') ?? false), def, out);

      case 'cipp_list_standard_templates': {
        const templateId = this.str(a, 'templateId');
        const data = await svc.listStandardTemplates(templateId);
        if (templateId) {
          const rows = unwrapList(data);
          return this.object(rows ? rows[0] : data);
        }
        const enriched = mapList(data, (r) => {
          const tenants = getPath(r, 'tenantFilter');
          const standards = getPath(r, 'standards');
          return {
            ...(r as Record<string, unknown>),
            tenants: Array.isArray(tenants)
              ? tenants.map((t) => cellValue(getPath(t, 'label') ?? getPath(t, 'value') ?? t)).join(';')
              : cellValue(tenants),
            standardCount:
              standards && typeof standards === 'object' && !Array.isArray(standards)
                ? Object.keys(standards as Record<string, unknown>).length
                : Array.isArray(standards)
                  ? standards.length
                  : 0,
          };
        });
        return this.list(enriched, def, out);
      }

      case 'cipp_get_tenant_drift':
        return this.list(await svc.getTenantDrift(this.str(a, 'tenantFilter')), def, out);

      case 'cipp_get_tenant_alignment': {
        if (this.bool(a, 'summary')) {
          return this.object(await svc.getTenantAlignment(true));
        }
        let data = await svc.getTenantAlignment(false);
        const scope = this.str(a, 'tenantFilter');
        if (scope) {
          data = filterList(data, (r) => cellValue(getPath(r, 'tenantFilter')).toLowerCase() === scope.toLowerCase());
        }
        return this.list(data, def, out);
      }

      case 'cipp_list_domain_health': {
        if (this.bool(a, 'live')) {
          return this.object(await svc.listDomainHealth(tenant));
        }
        return this.list(await svc.listDomainAnalyser(tenant), def, out);
      }

      // ---------------------------------------------------------------- Licenses
      case 'cipp_list_licenses':
        return this.list(await svc.listLicenses(tenant, this.bool(a, 'includeExcluded') ?? false), def, out);

      case 'cipp_list_licenses_report':
        return this.list(await svc.listLicensesReport(tenant), def, out);

      // -------------------------------------------------------- Alerts & logs
      case 'cipp_list_audit_logs': {
        let data = await svc.listAuditLogs(tenant, this.num(a, 'days') ?? 7);
        data = filterListByTerm(data, this.str(a, 'user'));
        data = filterListByTerm(data, this.str(a, 'operation'));
        return this.list(data, def, out);
      }

      case 'cipp_list_alert_queue':
        return this.list(await svc.listAlertQueue(), def, out);

      case 'cipp_list_alert_results':
        return this.list(await svc.listAlertResults(tenant), def, out);

      case 'cipp_list_service_health':
        return this.list(await svc.listServiceHealth(tenant), def, out);

      case 'cipp_list_logs':
        return this.list(
          await svc.listLogs({
            severity: this.str(a, 'severity'),
            tenant: this.str(a, 'tenant'),
            user: this.str(a, 'user'),
            api: this.str(a, 'api'),
            days: this.num(a, 'days'),
          }),
          def,
          out
        );

      // -------------------------------------------------------------------- GDAP
      case 'cipp_list_gdap_roles':
        return this.list(await svc.listGDAPRoles(), def, out);

      case 'cipp_list_gdap_invites':
        return this.list(await svc.listGDAPInvites(), def, out);

      case 'cipp_list_gdap_relationships': {
        let data = await svc.listGDAPRelationships();
        const customer = this.str(a, 'customer');
        if (customer) data = filterList(data, (r) => fieldContains(r, 'customer.displayName', customer));
        const status = this.str(a, 'status');
        if (status) data = filterList(data, (r) => fieldContains(r, 'status', status));
        return this.list(data, def, out);
      }

      // --------------------------------------------------------------- Scheduler
      case 'cipp_list_scheduled_items':
        return this.list(
          await svc.listScheduledItems({
            tenantFilter: this.str(a, 'tenantFilter'),
            name: this.str(a, 'name'),
            type: this.str(a, 'type'),
            showHidden: this.bool(a, 'showHidden'),
          }),
          def,
          out
        );

      // ------------------------------------------------------------- Raw access
      case 'cipp_graph_request': {
        const countOnly = this.bool(a, 'countOnly') ?? false;
        const data = await svc.graphRequest(tenant, {
          endpoint: this.str(a, 'endpoint') as string,
          select: this.str(a, 'select'),
          filter: this.str(a, 'filter'),
          search: this.str(a, 'search'),
          orderby: this.str(a, 'orderby'),
          expand: this.str(a, 'expand'),
          top: this.num(a, 'top'),
          countOnly,
          version: this.str(a, 'version'),
        });
        if (countOnly) return this.object(data);
        const select = this.str(a, 'select');
        const columns = out.fields?.length ? out.fields : select ? splitList(select) : [];
        return this.list(data, def, out, columns);
      }

      case 'cipp_exo_request': {
        const select = this.str(a, 'select') as string;
        const data = await svc.exoRequest(
          tenant,
          this.str(a, 'cmdlet') as string,
          (a.cmdParams as Record<string, unknown> | undefined) ?? undefined,
          select
        );
        const columns = out.fields?.length ? out.fields : splitList(select);
        return this.list(data, def, out, columns);
      }

      // -------------------------------------------------------------------- Core
      case 'cipp_ping':
        return this.object(await svc.ping());

      case 'cipp_get_version':
        return this.object(await svc.getVersion(), ['VersionHistory']);

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${def.name}`);
    }
  }
}

function splitList(csv: string): string[] {
  return csv
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
