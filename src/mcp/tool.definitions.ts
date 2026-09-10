// CIPP MCP Tool Definitions
// Defines every MCP tool the CIPP MCP server exposes: name, description,
// JSON Schema for input validation, read-only annotations, the curated CSV
// column set for list results, and the filter rules enforced before dispatch.
//
// This server is READ-ONLY by design. Every tool maps to a CIPP List*/Get*
// endpoint (or ExecBECCheck, which only reads). Token efficiency is the
// governing rule: list tools default to CSV with a small column set, cap rows,
// and most require a filter so a whole-tenant dump is never the default.

import type { ToolRules } from '../utils/validate.js';

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

/**
 * A single MCP tool definition as required by the MCP protocol, plus two
 * server-private fields (`columns`, `rules`) that are stripped before the
 * definition is sent to clients.
 */
export interface McpToolDefinition {
  /** Unique, snake_case identifier for the tool. */
  name: string;
  /** Human-readable description surfaced to MCP clients and LLM tool-selectors. */
  description: string;
  /** JSON Schema (object type) describing the tool's accepted input parameters. */
  inputSchema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
  /** Behaviour hints; every tool in this server is read-only. */
  annotations: {
    title?: string;
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  /** Default CSV columns for list results (dotted paths allowed). Server-private. */
  columns?: string[];
  /** Filter rules enforced before dispatch. Server-private. */
  rules?: ToolRules;
}

// ---------------------------------------------------------------------------
// Shared snippets
// ---------------------------------------------------------------------------

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const TENANT_FILTER_PROP = {
  type: 'string',
  description:
    "Tenant default domain (e.g. contoso.com) or tenant ID. Use 'AllTenants' only where the tool says it is allowed.",
};

const USER_ID_PROP = {
  type: 'string',
  description: "Target user's Entra object ID or User Principal Name (e.g. alice@contoso.com).",
};

/** Output controls shared by every list tool. */
const LIST_OUTPUT_PROPS = {
  fields: {
    type: 'array',
    items: { type: 'string' },
    description: 'Override the default columns. Dotted paths allowed (e.g. "location.city", "assignedLicenses.length").',
  },
  limit: {
    type: 'integer',
    description: 'Max rows (default 100). A footer reports cut rows.',
  },
  format: {
    type: 'string',
    enum: ['csv', 'json'],
    description: '"csv" (default, compact) or "json" when nested structure is needed.',
  },
};

function listTool(def: Omit<McpToolDefinition, 'annotations'> & { annotations?: Partial<McpToolDefinition['annotations']> }): McpToolDefinition {
  return {
    ...def,
    inputSchema: {
      ...def.inputSchema,
      properties: { ...def.inputSchema.properties, ...LIST_OUTPUT_PROPS },
    },
    annotations: { ...READ_ONLY, ...(def.annotations ?? {}) },
  };
}

function objectTool(def: Omit<McpToolDefinition, 'annotations'> & { annotations?: Partial<McpToolDefinition['annotations']> }): McpToolDefinition {
  return { ...def, annotations: { ...READ_ONLY, ...(def.annotations ?? {}) } };
}

// ---------------------------------------------------------------------------
// Tool Definitions
// ---------------------------------------------------------------------------

export const TOOL_DEFINITIONS: McpToolDefinition[] = [
  // -------------------------------------------------------------------------
  // Tenants
  // -------------------------------------------------------------------------
  listTool({
    name: 'cipp_list_tenants',
    description:
      'List the tenants managed in CIPP (name, default domain, tenant ID, GDAP status, error count). Start here to resolve a customer name to a tenantFilter. Optional search narrows by name or domain.',
    inputSchema: {
      type: 'object',
      properties: {
        search: {
          type: 'string',
          description: 'Case-insensitive substring match on displayName or any domain.',
        },
        includeExcluded: {
          type: 'boolean',
          description: 'Include tenants marked Excluded in CIPP. Default false.',
        },
      },
    },
    columns: [
      'displayName',
      'defaultDomainName',
      'customerId',
      'delegatedPrivilegeStatus',
      'Excluded',
      'GraphErrorCount',
      'RequiresRefresh',
    ],
  }),
  objectTool({
    name: 'cipp_get_tenant_details',
    description:
      'Organisation profile for one tenant (name, address, phones, technical contacts, verified domains, sync status). Compact JSON; plan lists are omitted unless full=true.',
    inputSchema: {
      type: 'object',
      properties: {
        tenantFilter: TENANT_FILTER_PROP,
        full: { type: 'boolean', description: 'Include assignedPlans/provisionedPlans (large).' },
      },
      required: ['tenantFilter'],
    },
    rules: { rejectAllTenants: ['tenantFilter'] },
  }),
  objectTool({
    name: 'cipp_user_counts',
    description:
      'Summary counts for a tenant: total users, licensed users, guests, global admins. Use this instead of listing users when only totals are needed.',
    inputSchema: {
      type: 'object',
      properties: { tenantFilter: TENANT_FILTER_PROP },
      required: ['tenantFilter'],
    },
    rules: { rejectAllTenants: ['tenantFilter'] },
  }),

  // -------------------------------------------------------------------------
  // Users
  // -------------------------------------------------------------------------
  listTool({
    name: 'cipp_list_users',
    description:
      'Search users in a tenant. A filter is REQUIRED: either userId (one user) or searchField + searchValue (prefix match, server-side). Returns a compact CSV (name, UPN, enabled, licenses, department...). For a whole-tenant question use cipp_user_counts or cipp_list_inactive_accounts instead.',
    inputSchema: {
      type: 'object',
      properties: {
        tenantFilter: TENANT_FILTER_PROP,
        userId: { type: 'string', description: 'Entra object ID or UPN of a single user.' },
        searchField: {
          type: 'string',
          enum: ['displayName', 'userPrincipalName', 'mail', 'givenName', 'surname'],
          description: 'Attribute to search on. Must be paired with searchValue.',
        },
        searchValue: {
          type: 'string',
          description: 'Prefix to match (case-insensitive startswith).',
        },
      },
      required: ['tenantFilter'],
    },
    rules: { oneOf: [['userId'], ['searchField', 'searchValue']], rejectAllTenants: ['tenantFilter'] },
    columns: [
      'displayName',
      'userPrincipalName',
      'id',
      'mail',
      'accountEnabled',
      'userType',
      'jobTitle',
      'department',
      'usageLocation',
      'LicJoined',
      'assignedLicenses.length',
      'createdDateTime',
      'onPremisesSyncEnabled',
    ],
  }),
  objectTool({
    name: 'cipp_get_user',
    description:
      'Full directory record for one user as compact JSON (contact fields, licenses, aliases, sync state). Bulky plan arrays are omitted.',
    inputSchema: {
      type: 'object',
      properties: { tenantFilter: TENANT_FILTER_PROP, userId: USER_ID_PROP },
      required: ['tenantFilter', 'userId'],
    },
    rules: { rejectAllTenants: ['tenantFilter'] },
  }),
  listTool({
    name: 'cipp_list_mfa_users',
    description:
      'MFA registration status per user. Provide user (substring match on UPN/name) OR unregisteredOnly=true (enabled, licensed users with no MFA registered). Columns: UPN, enabled, licensed, MFA registered/capable, methods, per-user MFA state, CA/Security Defaults coverage.',
    inputSchema: {
      type: 'object',
      properties: {
        tenantFilter: TENANT_FILTER_PROP,
        user: { type: 'string', description: 'Substring match on UPN or display name.' },
        unregisteredOnly: {
          type: 'boolean',
          description: 'Only enabled, licensed users with MFARegistration=false.',
        },
      },
      required: ['tenantFilter'],
    },
    rules: { oneOf: [['user'], ['unregisteredOnly']], rejectAllTenants: ['tenantFilter'] },
    columns: [
      'UPN',
      'DisplayName',
      'AccountEnabled',
      'isLicensed',
      'MFARegistration',
      'MFACapable',
      'MFAMethods',
      'PerUser',
      'CoveredByCA',
      'CoveredBySD',
    ],
  }),
  listTool({
    name: 'cipp_list_user_groups',
    description: 'Groups a user is a member of (name, type, mail).',
    inputSchema: {
      type: 'object',
      properties: { tenantFilter: TENANT_FILTER_PROP, userId: USER_ID_PROP },
      required: ['tenantFilter', 'userId'],
    },
    rules: { rejectAllTenants: ['tenantFilter'] },
    columns: ['DisplayName', 'groupType', 'Mail', 'MailEnabled', 'SecurityGroup', 'id'],
  }),
  listTool({
    name: 'cipp_list_user_devices',
    description: 'Intune devices registered to a user (name, OS, compliance, last sync).',
    inputSchema: {
      type: 'object',
      properties: { tenantFilter: TENANT_FILTER_PROP, userId: USER_ID_PROP },
      required: ['tenantFilter', 'userId'],
    },
    rules: { rejectAllTenants: ['tenantFilter'] },
    columns: [
      'displayName',
      'deviceName',
      'operatingSystem',
      'osVersion',
      'complianceState',
      'lastSyncDateTime',
      'isManaged',
      'trustType',
      'model',
      'id',
    ],
  }),
  listTool({
    name: 'cipp_list_user_signin_logs',
    description:
      "One user's recent sign-ins (time, app, IP, location, result, client, CA status). top defaults to 25.",
    inputSchema: {
      type: 'object',
      properties: {
        tenantFilter: TENANT_FILTER_PROP,
        userId: USER_ID_PROP,
        top: { type: 'integer', description: 'Number of most-recent sign-ins to fetch (default 25).' },
      },
      required: ['tenantFilter', 'userId'],
    },
    rules: { rejectAllTenants: ['tenantFilter'] },
    columns: [
      'createdDateTime',
      'appDisplayName',
      'ipAddress',
      'location.city',
      'location.countryOrRegion',
      'status.errorCode',
      'status.failureReason',
      'clientAppUsed',
      'conditionalAccessStatus',
      'isInteractive',
      'deviceDetail.operatingSystem',
    ],
  }),
  listTool({
    name: 'cipp_list_signins',
    description:
      'Tenant sign-in log search. A filter is REQUIRED: failedOnly=true, user (substring), or filter (OData). days defaults to 7.',
    inputSchema: {
      type: 'object',
      properties: {
        tenantFilter: TENANT_FILTER_PROP,
        days: { type: 'integer', description: 'Look-back window in days (default 7).' },
        failedOnly: { type: 'boolean', description: 'Only failed sign-ins.' },
        user: { type: 'string', description: 'Substring match on userPrincipalName / display name (client-side).' },
        filter: { type: 'string', description: 'Raw OData $filter forwarded to Graph signIns.' },
      },
      required: ['tenantFilter'],
    },
    rules: { oneOf: [['failedOnly'], ['user'], ['filter']], rejectAllTenants: ['tenantFilter'] },
    columns: [
      'createdDateTime',
      'userPrincipalName',
      'appDisplayName',
      'ipAddress',
      'location.city',
      'location.countryOrRegion',
      'status.errorCode',
      'status.failureReason',
      'clientAppUsed',
      'conditionalAccessStatus',
      'riskState',
    ],
  }),
  listTool({
    name: 'cipp_list_inactive_accounts',
    description:
      'Users with no sign-in for N days (default 90): name, UPN, last sign-in, enabled, licensed.',
    inputSchema: {
      type: 'object',
      properties: {
        tenantFilter: TENANT_FILTER_PROP,
        inactiveDays: { type: 'integer', description: 'Inactivity threshold in days (default 90).' },
      },
      required: ['tenantFilter'],
    },
    rules: { rejectAllTenants: ['tenantFilter'] },
    columns: [
      'displayName',
      'userPrincipalName',
      'UPN',
      'lastSignInDateTime',
      'lastNonInteractiveSignInDateTime',
      'accountEnabled',
      'isLicensed',
      'userType',
      'createdDateTime',
    ],
  }),
  listTool({
    name: 'cipp_list_guest_users',
    description:
      'Guest accounts with a lifecycle status (Active, Pending Acceptance, Stale, Never Signed In, Disabled). staleDays defaults to 90.',
    inputSchema: {
      type: 'object',
      properties: {
        tenantFilter: TENANT_FILTER_PROP,
        staleDays: { type: 'integer', description: 'Days without sign-in before a guest is Stale (default 90).' },
        status: { type: 'string', description: 'Client-side filter on the lifecycle status (substring).' },
      },
      required: ['tenantFilter'],
    },
    rules: { rejectAllTenants: ['tenantFilter'] },
    columns: [
      'displayName',
      'mail',
      'userPrincipalName',
      'lifecycleStatus',
      'status',
      'externalUserState',
      'lastSignInDateTime',
      'createdDateTime',
    ],
  }),
  listTool({
    name: 'cipp_list_roles',
    description:
      'Entra admin roles and their active members. By default only roles with at least one member are returned; MemberUPNs is a ;-joined list.',
    inputSchema: {
      type: 'object',
      properties: {
        tenantFilter: TENANT_FILTER_PROP,
        withMembersOnly: { type: 'boolean', description: 'Omit roles with no members (default true).' },
        role: { type: 'string', description: 'Substring filter on role display name.' },
      },
      required: ['tenantFilter'],
    },
    rules: { rejectAllTenants: ['tenantFilter'] },
    columns: ['DisplayName', 'MemberCount', 'MemberUPNs'],
  }),
  listTool({
    name: 'cipp_list_user_ca_policies',
    description: 'Conditional Access policies that apply to a specific user.',
    inputSchema: {
      type: 'object',
      properties: { tenantFilter: TENANT_FILTER_PROP, userId: USER_ID_PROP },
      required: ['tenantFilter', 'userId'],
    },
    rules: { rejectAllTenants: ['tenantFilter'] },
    columns: ['displayName', 'state', 'id'],
  }),
  objectTool({
    name: 'cipp_bec_check',
    description:
      "Business Email Compromise assessment for one user (recent sign-ins with location analysis, inbox rules and rule changes, trusted/blocked sender changes, sharing activity, new app consents, MFA methods, devices). CIPP runs this asynchronously; the tool polls up to ~60 s and returns compact JSON. If it returns Waiting=true, call again with the same arguments.",
    inputSchema: {
      type: 'object',
      properties: {
        tenantFilter: TENANT_FILTER_PROP,
        userId: { type: 'string', description: "User's Entra object ID (GUID)." },
        userName: { type: 'string', description: "User's UPN (used for the Exchange-side checks)." },
        overwrite: { type: 'boolean', description: 'Force a fresh run instead of returning cached results.' },
      },
      required: ['tenantFilter', 'userId', 'userName'],
    },
    rules: { rejectAllTenants: ['tenantFilter'] },
  }),

  // -------------------------------------------------------------------------
  // Groups
  // -------------------------------------------------------------------------
  listTool({
    name: 'cipp_list_groups',
    description:
      'Find groups in a tenant. A filter is REQUIRED: search (substring on name/mail, client-side) or groupId. With groupId, set members=true or owners=true to list that group\'s members/owners instead.',
    inputSchema: {
      type: 'object',
      properties: {
        tenantFilter: TENANT_FILTER_PROP,
        search: { type: 'string', description: 'Case-insensitive substring on displayName or mail.' },
        groupId: { type: 'string', description: 'Entra object ID of one group.' },
        members: { type: 'boolean', description: 'With groupId: return the group members.' },
        owners: { type: 'boolean', description: 'With groupId: return the group owners.' },
        groupType: {
          type: 'string',
          description: 'Client-side filter on calculatedGroupType (e.g. m365, security, distribution, dynamic).',
        },
      },
      required: ['tenantFilter'],
    },
    rules: { oneOf: [['search'], ['groupId']], rejectAllTenants: ['tenantFilter'] },
    columns: [
      'displayName',
      'id',
      'mail',
      'calculatedGroupType',
      'groupTypes',
      'securityEnabled',
      'mailEnabled',
      'membershipRule',
      'visibility',
      'onPremisesSyncEnabled',
    ],
  }),

  // -------------------------------------------------------------------------
  // Mailboxes
  // -------------------------------------------------------------------------
  listTool({
    name: 'cipp_list_mailboxes',
    description:
      'Exchange mailboxes. A filter is REQUIRED: identity (one mailbox by UPN/alias/GUID), displayName (fuzzy, server-side) or type (UserMailbox, SharedMailbox, RoomMailbox, EquipmentMailbox). Columns include forwarding, archive and litigation-hold state.',
    inputSchema: {
      type: 'object',
      properties: {
        tenantFilter: TENANT_FILTER_PROP,
        identity: { type: 'string', description: 'Exact mailbox: UPN, primary SMTP, alias or GUID.' },
        displayName: { type: 'string', description: 'Substring match on display name (server-side).' },
        type: {
          type: 'string',
          enum: ['UserMailbox', 'SharedMailbox', 'RoomMailbox', 'EquipmentMailbox'],
          description: 'Recipient type filter.',
        },
      },
      required: ['tenantFilter'],
    },
    rules: { oneOf: [['identity'], ['displayName'], ['type']], rejectAllTenants: ['tenantFilter'] },
    columns: [
      'UPN',
      'displayName',
      'primarySmtpAddress',
      'recipientTypeDetails',
      'ForwardingSmtpAddress',
      'InternalForwardingAddress',
      'DeliverToMailboxAndForward',
      'ArchiveEnabled',
      'LitigationHoldEnabled',
      'HiddenFromAddressListsEnabled',
      'RetentionPolicy',
    ],
  }),
  objectTool({
    name: 'cipp_get_user_mailbox_details',
    description:
      'Detailed Exchange properties for one mailbox: size and quotas, archive, forwarding, litigation hold, protocols (POP/IMAP/EWS/ActiveSync), retention. Compact JSON.',
    inputSchema: {
      type: 'object',
      properties: { tenantFilter: TENANT_FILTER_PROP, userId: USER_ID_PROP },
      required: ['tenantFilter', 'userId'],
    },
    rules: { rejectAllTenants: ['tenantFilter'] },
  }),
  listTool({
    name: 'cipp_list_mailbox_permissions',
    description: 'Who has Full Access / Send As / Send on Behalf on a mailbox.',
    inputSchema: {
      type: 'object',
      properties: {
        tenantFilter: TENANT_FILTER_PROP,
        upn: { type: 'string', description: 'UPN or primary SMTP of the mailbox.' },
      },
      required: ['tenantFilter', 'upn'],
    },
    rules: { rejectAllTenants: ['tenantFilter'] },
    columns: ['User', 'Permissions', 'AccessRights'],
  }),
  listTool({
    name: 'cipp_list_calendar_permissions',
    description: "Calendar folder permissions on a mailbox (who can see or edit the user's calendar).",
    inputSchema: {
      type: 'object',
      properties: {
        tenantFilter: TENANT_FILTER_PROP,
        upn: { type: 'string', description: 'UPN or primary SMTP of the mailbox.' },
      },
      required: ['tenantFilter', 'upn'],
    },
    rules: { rejectAllTenants: ['tenantFilter'] },
    columns: ['User', 'AccessRights', 'FolderName', 'Identity'],
  }),
  listTool({
    name: 'cipp_list_user_mailbox_rules',
    description:
      'Inbox rules on one mailbox (name, enabled, forward/redirect/delete actions). Key BEC indicator.',
    inputSchema: {
      type: 'object',
      properties: { tenantFilter: TENANT_FILTER_PROP, userId: USER_ID_PROP },
      required: ['tenantFilter', 'userId'],
    },
    rules: { rejectAllTenants: ['tenantFilter'] },
    columns: [
      'Name',
      'Enabled',
      'Priority',
      'Description',
      'From',
      'ForwardTo',
      'ForwardAsAttachmentTo',
      'RedirectTo',
      'DeleteMessage',
      'MoveToFolder',
      'MarkAsRead',
    ],
  }),
  listTool({
    name: 'cipp_list_mailbox_forwarding',
    description:
      'Mailboxes with forwarding configured (internal ForwardingAddress or external ForwardingSmtpAddress). externalOnly=true keeps only SMTP forwards. AllTenants allowed (served from the reporting cache).',
    inputSchema: {
      type: 'object',
      properties: {
        tenantFilter: TENANT_FILTER_PROP,
        externalOnly: { type: 'boolean', description: 'Only rows with an external ForwardingSmtpAddress.' },
      },
      required: ['tenantFilter'],
    },
    columns: [
      'Tenant',
      'UserPrincipalName',
      'UPN',
      'displayName',
      'ForwardingSmtpAddress',
      'ForwardingAddress',
      'DeliverToMailboxAndForward',
    ],
  }),
  objectTool({
    name: 'cipp_get_out_of_office',
    description: 'Current automatic-reply (out of office) configuration for a mailbox. Compact JSON.',
    inputSchema: {
      type: 'object',
      properties: { tenantFilter: TENANT_FILTER_PROP, userId: USER_ID_PROP },
      required: ['tenantFilter', 'userId'],
    },
    rules: { rejectAllTenants: ['tenantFilter'] },
  }),
  listTool({
    name: 'cipp_message_trace',
    description:
      'Exchange message trace. A filter is REQUIRED: sender, recipient or messageId. days defaults to 2 (max 10). Returns time, sender, recipient, subject, status, size, source IP.',
    inputSchema: {
      type: 'object',
      properties: {
        tenantFilter: TENANT_FILTER_PROP,
        sender: { type: 'string', description: 'Sender address (wildcards allowed, e.g. *@contoso.com).' },
        recipient: { type: 'string', description: 'Recipient address.' },
        messageId: { type: 'string', description: 'Internet Message-ID.' },
        subject: { type: 'string', description: 'Subject contains (client-side).' },
        days: { type: 'integer', description: 'Look-back in days (default 2, max 10).' },
        status: {
          type: 'string',
          description: 'Delivery status filter (e.g. Delivered, Failed, Pending, Quarantined, FilteredAsSpam).',
        },
      },
      required: ['tenantFilter'],
    },
    rules: { oneOf: [['sender'], ['recipient'], ['messageId']], rejectAllTenants: ['tenantFilter'] },
    columns: [
      'Received',
      'receivedDateTime',
      'SenderAddress',
      'senderAddress',
      'RecipientAddress',
      'recipientAddress',
      'Subject',
      'subject',
      'Status',
      'status',
      'Size',
      'size',
      'FromIP',
      'fromIP',
      'MessageId',
      'messageId',
    ],
  }),

  // -------------------------------------------------------------------------
  // Devices
  // -------------------------------------------------------------------------
  listTool({
    name: 'cipp_list_devices',
    description:
      'Intune managed devices. A filter is REQUIRED: search (name/user/serial substring), nonCompliantOnly=true, or os (e.g. Windows, iOS, Android, macOS).',
    inputSchema: {
      type: 'object',
      properties: {
        tenantFilter: TENANT_FILTER_PROP,
        search: { type: 'string', description: 'Substring on deviceName, userPrincipalName or serialNumber.' },
        nonCompliantOnly: { type: 'boolean', description: 'Only devices whose complianceState is not "compliant".' },
        os: { type: 'string', description: 'Operating system substring filter.' },
      },
      required: ['tenantFilter'],
    },
    rules: { oneOf: [['search'], ['nonCompliantOnly'], ['os']], rejectAllTenants: ['tenantFilter'] },
    columns: [
      'deviceName',
      'userPrincipalName',
      'operatingSystem',
      'osVersion',
      'complianceState',
      'lastSyncDateTime',
      'model',
      'manufacturer',
      'serialNumber',
      'managementAgent',
      'id',
    ],
  }),
  objectTool({
    name: 'cipp_get_device',
    description: 'Full Intune record for one device, looked up by deviceId, deviceName or serial. Compact JSON.',
    inputSchema: {
      type: 'object',
      properties: {
        tenantFilter: TENANT_FILTER_PROP,
        deviceId: { type: 'string', description: 'Intune managed device ID.' },
        deviceName: { type: 'string', description: 'Device name.' },
        serial: { type: 'string', description: 'Serial number.' },
      },
      required: ['tenantFilter'],
    },
    rules: { oneOf: [['deviceId'], ['deviceName'], ['serial']], rejectAllTenants: ['tenantFilter'] },
  }),

  // -------------------------------------------------------------------------
  // Security
  // -------------------------------------------------------------------------
  listTool({
    name: 'cipp_list_conditional_access_policies',
    description:
      'Conditional Access policies with resolved names (state, users/groups in and out, apps, locations, controls). Pass name or policyId to get the full JSON of one policy.',
    inputSchema: {
      type: 'object',
      properties: {
        tenantFilter: TENANT_FILTER_PROP,
        name: { type: 'string', description: 'Substring filter on displayName.' },
        policyId: { type: 'string', description: 'Policy ID; returns that policy in full.' },
      },
      required: ['tenantFilter'],
    },
    rules: { rejectAllTenants: ['tenantFilter'] },
    columns: [
      'displayName',
      'state',
      'includeUsers',
      'excludeUsers',
      'includeGroups',
      'excludeGroups',
      'includeApplications',
      'excludeApplications',
      'includeLocations',
      'excludeLocations',
      'builtInControls',
      'grantControlsOperator',
      'modifiedDateTime',
      'id',
    ],
  }),
  listTool({
    name: 'cipp_list_named_locations',
    description: 'Conditional Access named locations (IP ranges and countries) with trusted flag.',
    inputSchema: {
      type: 'object',
      properties: { tenantFilter: TENANT_FILTER_PROP },
      required: ['tenantFilter'],
    },
    rules: { rejectAllTenants: ['tenantFilter'] },
    columns: ['displayName', '@odata.type', 'isTrusted', 'rangeOrLocation', 'modifiedDateTime', 'id'],
  }),
  listTool({
    name: 'cipp_get_secure_score',
    description:
      'Latest Microsoft Secure Score per tenant from the nightly cache (current, max, percentage). AllTenants allowed and cheap.',
    inputSchema: {
      type: 'object',
      properties: { tenantFilter: TENANT_FILTER_PROP },
      required: ['tenantFilter'],
    },
    columns: ['tenantFilter', 'Tenant', 'currentScore', 'maxScore', 'percentage', 'percentageVsAllTenants', 'createdDateTime'],
  }),

  // -------------------------------------------------------------------------
  // Standards
  // -------------------------------------------------------------------------
  listTool({
    name: 'cipp_list_standards',
    description: 'Standards currently applied to a tenant and their configured action (Report/Alert/Remediate).',
    inputSchema: {
      type: 'object',
      properties: {
        tenantFilter: TENANT_FILTER_PROP,
        consolidated: { type: 'boolean', description: 'Ask CIPP for the consolidated view.' },
      },
      required: ['tenantFilter'],
    },
    rules: { rejectAllTenants: ['tenantFilter'] },
    columns: ['Tenant', 'standardName', 'displayName', 'Standard', 'action', 'templateName', 'TemplateList'],
  }),
  listTool({
    name: 'cipp_list_standard_templates',
    description:
      'CIPP Standards Templates: name, GUID, assigned tenants, number of standards, last update. Pass templateId to get one template in full (large).',
    inputSchema: {
      type: 'object',
      properties: {
        templateId: { type: 'string', description: 'Template GUID; returns the full template JSON.' },
      },
    },
    columns: ['templateName', 'GUID', 'tenants', 'excludedTenants.length', 'standardCount', 'isDriftTemplate', 'runManually', 'updatedAt', 'updatedBy'],
  }),
  listTool({
    name: 'cipp_get_tenant_drift',
    description:
      'Standards drift: settings deviating from the assigned template. Omit tenantFilter for the whole estate.',
    inputSchema: {
      type: 'object',
      properties: {
        tenantFilter: { type: 'string', description: 'Optional tenant domain to scope the result.' },
      },
    },
    columns: ['tenantFilter', 'Tenant', 'standardName', 'standardDisplayName', 'state', 'Status', 'Reason', 'lastChanged', 'expectedValue', 'receivedValue'],
  }),
  listTool({
    name: 'cipp_get_tenant_alignment',
    description:
      'Alignment score of tenants against their Standards Templates (one row per tenant per template). Omit tenantFilter for all tenants; summary=true returns only the estate roll-up.',
    inputSchema: {
      type: 'object',
      properties: {
        tenantFilter: { type: 'string', description: 'Optional tenant domain to scope the result (client-side).' },
        summary: { type: 'boolean', description: 'Return the estate summary instead of rows.' },
      },
    },
    columns: [
      'tenantFilter',
      'standardName',
      'standardType',
      'alignmentScore',
      'combinedAlignmentScore',
      'LicenseMissingPercentage',
      'pendingDeviationsCount',
      'latestDataCollection',
    ],
  }),
  listTool({
    name: 'cipp_list_domain_health',
    description:
      "Mail DNS health for a tenant's domains (SPF, DMARC, DKIM, MX, DNSSEC, score). Default reads CIPP's cached Domain Analyser (one call). live=true runs fresh DNS lookups per domain and returns detailed JSON (slower).",
    inputSchema: {
      type: 'object',
      properties: {
        tenantFilter: TENANT_FILTER_PROP,
        live: { type: 'boolean', description: 'Run live per-domain SPF/DMARC/DKIM checks instead of the cache.' },
      },
      required: ['tenantFilter'],
    },
    rules: { rejectAllTenants: ['tenantFilter'] },
    columns: [
      'Domain',
      'Tenant',
      'MailProvider',
      'SPFPassAll',
      'MXPassTest',
      'DMARCPresent',
      'DMARCActionPolicy',
      'DKIMEnabled',
      'DNSSECPresent',
      'ScorePercentage',
      'ScoreExplanation',
    ],
  }),

  // -------------------------------------------------------------------------
  // Licenses
  // -------------------------------------------------------------------------
  listTool({
    name: 'cipp_list_licenses',
    description: 'License SKUs in a tenant with used/available/total counts. AllTenants allowed.',
    inputSchema: {
      type: 'object',
      properties: {
        tenantFilter: TENANT_FILTER_PROP,
        includeExcluded: { type: 'boolean', description: 'Include SKUs CIPP excludes from reporting.' },
      },
      required: ['tenantFilter'],
    },
    columns: ['Tenant', 'License', 'CountUsed', 'CountAvailable', 'TotalLicenses', 'skuPartNumber', 'skuId'],
  }),
  listTool({
    name: 'cipp_list_licenses_report',
    description: 'Detailed license overview (SKU breakdown, cost, availability) for one tenant or AllTenants.',
    inputSchema: {
      type: 'object',
      properties: { tenantFilter: TENANT_FILTER_PROP },
      required: ['tenantFilter'],
    },
    columns: ['Tenant', 'License', 'TotalLicenses', 'CountUsed', 'CountAvailable', 'EstimatedCost', 'Price', 'Term', 'skuPartNumber'],
  }),

  // -------------------------------------------------------------------------
  // Alerts, logs & health
  // -------------------------------------------------------------------------
  listTool({
    name: 'cipp_list_audit_logs',
    description:
      "CIPP-captured audit log entries for a tenant filtered to a user (substring, required). days defaults to 7; operation filters on the action name.",
    inputSchema: {
      type: 'object',
      properties: {
        tenantFilter: TENANT_FILTER_PROP,
        user: { type: 'string', description: 'Substring match on the acting/affected user (client-side).' },
        days: { type: 'integer', description: 'Look-back window in days (default 7).' },
        operation: { type: 'string', description: 'Substring filter on the operation/title (client-side).' },
      },
      required: ['tenantFilter', 'user'],
    },
    rules: { rejectAllTenants: ['tenantFilter'] },
    columns: ['Timestamp', 'Tenant', 'Title', 'Data.Operation', 'Data.UserId', 'Data.ClientIP', 'Actions', 'RowKey'],
  }),
  listTool({
    name: 'cipp_list_alert_queue',
    description: 'Configured CIPP alert rules (scripted and webhook alerts): condition, actions, schedule, tenants.',
    inputSchema: { type: 'object', properties: {} },
    columns: ['Conditions', 'Actions', 'EventType', 'LogType', 'RepeatsEvery', 'Enabled', 'Tenants.0.label', 'RowKey'],
  }),
  listTool({
    name: 'cipp_list_alert_results',
    description: 'Currently active (fired, not snoozed) alert items for a tenant from the last alert run.',
    inputSchema: {
      type: 'object',
      properties: { tenantFilter: TENANT_FILTER_PROP },
      required: ['tenantFilter'],
    },
    columns: ['Tenant', 'Alert', 'Name', 'Title', 'Count', 'LastRun', 'Preview', 'Message'],
  }),
  listTool({
    name: 'cipp_list_service_health',
    description: 'Active Microsoft 365 service health issues and advisories for a tenant (AllTenants allowed).',
    inputSchema: {
      type: 'object',
      properties: { tenantFilter: TENANT_FILTER_PROP },
      required: ['tenantFilter'],
    },
    columns: ['TenantName', 'service', 'status', 'classification', 'title', 'id', 'lastModifiedDateTime'],
  }),
  listTool({
    name: 'cipp_list_logs',
    description:
      'CIPP platform log (what CIPP itself did). A filter is REQUIRED: severity (Error, Warning, Info, Alert, Critical), tenant, user, or api. days defaults to 1. Unfiltered days hold 10k+ rows.',
    inputSchema: {
      type: 'object',
      properties: {
        severity: { type: 'string', description: 'Comma-separated severities, e.g. "Error,Warning".' },
        tenant: { type: 'string', description: 'Tenant domain as recorded in the log.' },
        user: { type: 'string', description: 'Acting user/identity.' },
        api: { type: 'string', description: 'CIPP API/function name (e.g. Standards, AddUser).' },
        days: { type: 'integer', description: 'Look-back in days (default 1).' },
      },
    },
    rules: { oneOf: [['severity'], ['tenant'], ['user'], ['api']] },
    columns: ['DateTime', 'Tenant', 'API', 'Severity', 'User', 'Message'],
  }),

  // -------------------------------------------------------------------------
  // GDAP
  // -------------------------------------------------------------------------
  listTool({
    name: 'cipp_list_gdap_roles',
    description: 'GDAP role to security-group mappings configured in CIPP.',
    inputSchema: { type: 'object', properties: {} },
    columns: ['RoleName', 'GroupName', 'GroupId', 'roleDefinitionId'],
  }),
  listTool({
    name: 'cipp_list_gdap_invites',
    description: 'Pending GDAP relationship invites (created, technician, role count, invite URL).',
    inputSchema: { type: 'object', properties: {} },
    columns: ['Timestamp', 'Technician', 'Reference', 'RoleMappings.length', 'InviteUrl', 'RowKey'],
  }),
  listTool({
    name: 'cipp_list_gdap_relationships',
    description: 'GDAP relationships with customers: customer, status, end date, auto-extend, role count. Optional customer substring filter.',
    inputSchema: {
      type: 'object',
      properties: {
        customer: { type: 'string', description: 'Substring filter on customer display name (client-side).' },
        status: { type: 'string', description: 'Status filter, e.g. active, expired, terminated (client-side).' },
      },
    },
    columns: [
      'displayName',
      'customer.displayName',
      'customer.tenantId',
      'status',
      'endDateTime',
      'autoExtendDuration',
      'accessDetails.unifiedRoles.length',
      'id',
    ],
  }),

  // -------------------------------------------------------------------------
  // Scheduler
  // -------------------------------------------------------------------------
  listTool({
    name: 'cipp_list_scheduled_items',
    description: 'Scheduled tasks in CIPP (name, command, tenant, next run, recurrence, state, last result). Optional filters.',
    inputSchema: {
      type: 'object',
      properties: {
        tenantFilter: { type: 'string', description: 'Optional tenant domain to scope the tasks.' },
        name: { type: 'string', description: 'Task name filter (server-side).' },
        type: { type: 'string', description: 'Task type filter (server-side).' },
        showHidden: { type: 'boolean', description: 'Include CIPP-internal hidden tasks.' },
      },
    },
    columns: ['Name', 'Command', 'Tenant.label', 'Tenant.value', 'ScheduledTime', 'Recurrence', 'TaskState', 'Results', 'RowKey'],
  }),

  // -------------------------------------------------------------------------
  // Raw read-only access
  // -------------------------------------------------------------------------
  listTool({
    name: 'cipp_graph_request',
    description:
      "Read-only Microsoft Graph GET through CIPP for anything without a dedicated tool. endpoint is the Graph path without version (e.g. 'users', 'groups/<id>/members', 'deviceManagement/managedDevices'). ALWAYS pass select to limit columns; top defaults to 50 and only the first page is returned. Use countOnly=true first to size a collection.",
    inputSchema: {
      type: 'object',
      properties: {
        tenantFilter: TENANT_FILTER_PROP,
        endpoint: { type: 'string', description: 'Graph path without version prefix.' },
        select: { type: 'string', description: 'Comma-separated $select. Strongly recommended.' },
        filter: { type: 'string', description: 'OData $filter.' },
        search: { type: 'string', description: 'OData $search (e.g. "displayName:john").' },
        orderby: { type: 'string', description: 'OData $orderby.' },
        expand: { type: 'string', description: 'OData $expand.' },
        top: { type: 'integer', description: 'Page size (default 50, max 999). Only one page is fetched.' },
        countOnly: { type: 'boolean', description: 'Return only the number of matching records.' },
        version: { type: 'string', enum: ['v1.0', 'beta'], description: 'Graph version (default v1.0).' },
      },
      required: ['tenantFilter', 'endpoint'],
    },
    rules: { rejectAllTenants: ['tenantFilter'] },
    columns: [],
  }),
  listTool({
    name: 'cipp_exo_request',
    description:
      'Read-only Exchange Online cmdlet through CIPP. Only Get-* and Search-* cmdlets are accepted (e.g. Get-Mailbox, Get-CASMailbox, Get-InboxRule, Get-TransportRule, Get-MobileDevice). select is REQUIRED and becomes the CSV columns. cmdParams is the parameter hashtable (e.g. {"Identity":"alice@contoso.com"}).',
    inputSchema: {
      type: 'object',
      properties: {
        tenantFilter: TENANT_FILTER_PROP,
        cmdlet: { type: 'string', description: 'Exchange cmdlet name, must start with Get- or Search-.' },
        cmdParams: { type: 'object', description: 'Cmdlet parameters as a JSON object.' },
        select: { type: 'string', description: 'Comma-separated properties to return (required).' },
      },
      required: ['tenantFilter', 'cmdlet', 'select'],
    },
    rules: { rejectAllTenants: ['tenantFilter'] },
    columns: [],
  }),

  // -------------------------------------------------------------------------
  // Core
  // -------------------------------------------------------------------------
  objectTool({
    name: 'cipp_ping',
    description: 'Check CIPP API connectivity and authentication.',
    inputSchema: { type: 'object', properties: {} },
  }),
  objectTool({
    name: 'cipp_get_version',
    description: 'CIPP frontend/API version, whether an update is available, and hosting details.',
    inputSchema: { type: 'object', properties: {} },
  }),
];

// ---------------------------------------------------------------------------
// Tool Categories
// ---------------------------------------------------------------------------

/**
 * Maps a human-readable category label to the names of all tools in that group.
 * Useful for selectively registering or describing subsets of tools.
 */
export const TOOL_CATEGORIES: Record<string, string[]> = {
  tenants: ['cipp_list_tenants', 'cipp_get_tenant_details', 'cipp_user_counts'],
  users: [
    'cipp_list_users',
    'cipp_get_user',
    'cipp_list_mfa_users',
    'cipp_list_user_groups',
    'cipp_list_user_devices',
    'cipp_list_user_signin_logs',
    'cipp_list_signins',
    'cipp_list_inactive_accounts',
    'cipp_list_guest_users',
    'cipp_list_roles',
    'cipp_list_user_ca_policies',
    'cipp_bec_check',
  ],
  groups: ['cipp_list_groups'],
  mailboxes: [
    'cipp_list_mailboxes',
    'cipp_get_user_mailbox_details',
    'cipp_list_mailbox_permissions',
    'cipp_list_calendar_permissions',
    'cipp_list_user_mailbox_rules',
    'cipp_list_mailbox_forwarding',
    'cipp_get_out_of_office',
    'cipp_message_trace',
  ],
  devices: ['cipp_list_devices', 'cipp_get_device'],
  security: ['cipp_list_conditional_access_policies', 'cipp_list_named_locations', 'cipp_get_secure_score'],
  standards: [
    'cipp_list_standards',
    'cipp_list_standard_templates',
    'cipp_get_tenant_drift',
    'cipp_get_tenant_alignment',
    'cipp_list_domain_health',
  ],
  licenses: ['cipp_list_licenses', 'cipp_list_licenses_report'],
  alerts: ['cipp_list_audit_logs', 'cipp_list_alert_queue', 'cipp_list_alert_results', 'cipp_list_service_health', 'cipp_list_logs'],
  gdap: ['cipp_list_gdap_roles', 'cipp_list_gdap_invites', 'cipp_list_gdap_relationships'],
  scheduler: ['cipp_list_scheduled_items'],
  raw: ['cipp_graph_request', 'cipp_exo_request'],
  core: ['cipp_ping', 'cipp_get_version'],
};

/**
 * Definitions as sent to MCP clients: the server-private `columns` and
 * `rules` fields are removed.
 */
export function publicToolDefinitions(): Array<Omit<McpToolDefinition, 'columns' | 'rules'>> {
  return TOOL_DEFINITIONS.map(({ columns: _columns, rules: _rules, ...pub }) => pub);
}

/** Look up a tool definition by name. */
export function findToolDefinition(name: string): McpToolDefinition | undefined {
  return TOOL_DEFINITIONS.find((t) => t.name === name);
}
