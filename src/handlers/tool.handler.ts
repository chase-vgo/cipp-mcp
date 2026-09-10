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
];

const GROUP_MEMBER_COLUMNS = ['displayName', 'userPrincipalName', 'mail', 'id', '@odata.type'];

export class CippToolHandler {
  private cippService: CippService;
  private logger: Logger;
  private mcpServer: Server | null = null;

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
      const text = await this.dispatch(def, args, out);
      return { content: [{ type: 'text', text }] };
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

      case 'cipp_list_user_signin_logs':
        return this.list(
          await svc.listUserSigninLogs(tenant, this.str(a, 'userId') as string, this.num(a, 'top') ?? 25),
          def,
          out
        );

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

      case 'cipp_bec_check':
        return this.object(
          await svc.becCheck(
            tenant,
            this.str(a, 'userId') as string,
            this.str(a, 'userName') as string,
            this.bool(a, 'overwrite') ?? false
          )
        );

      // ------------------------------------------------------------------ Groups
      case 'cipp_list_groups': {
        const groupId = this.str(a, 'groupId');
        const members = this.bool(a, 'members') ?? false;
        const owners = this.bool(a, 'owners') ?? false;
        let data = await svc.listGroups(tenant, { groupId, members, owners });
        if (groupId && (members || owners)) {
          return this.list(data, def, out, GROUP_MEMBER_COLUMNS);
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

      case 'cipp_get_user_mailbox_details':
        return this.object(await svc.getUserMailboxDetails(tenant, this.str(a, 'userId') as string));

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

      case 'cipp_get_out_of_office':
        return this.object(await svc.getOutOfOffice(tenant, this.str(a, 'userId') as string));

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
