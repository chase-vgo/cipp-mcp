# CIPP MCP: usage guide

Read-only access to CIPP (M365 multi-tenant data) for AI agents. In the Velocigo harness every tool is exposed as `<gateway>___<tool>`; the gateway is `cipp`, so the tool `cipp_list_mailboxes` is called as **`cipp___cipp_list_mailboxes`**. All examples below use the full harness name.

## Rules that save tokens

1. **Resolve the tenant first.** Every tenant-scoped tool needs `tenantFilter` = the tenant's default domain. Get it from `cipp___cipp_list_tenants` with `search`.
2. **Filter before you list.** Tools that could return a whole tenant refuse to run without a filter and tell you which filters they accept. Never work around this by using `cipp___cipp_graph_request` without `select` and `top`.
3. **Lists are CSV.** First line is the header. Use `fields` to pick columns (dotted paths like `location.city` or `assignedLicenses.length` work), `limit` to cap rows (default 100), `format: "json"` only when you need nested data.
4. **Read the footer.** `# showing 25 of 310 rows ...` or `# response truncated at 32 KB ...` means narrow the query, not raise the limit. `# no rows` means an empty result.
5. **`AllTenants` is only accepted** by cached reports: licenses, licenses report, secure score, mailbox forwarding, service health, alignment, drift.

## Common tasks

### Find the tenant

```json
cipp___cipp_list_tenants { "search": "access" }
```
```
displayName,defaultDomainName,customerId,delegatedPrivilegeStatus,Excluded,GraphErrorCount,RequiresRefresh
Access Combustion,accessburner.com,dc5ab786-...,granularDelegatedAdminPrivileges,false,0,false
```
Use `defaultDomainName` as `tenantFilter` from here on. `GraphErrorCount > 0` or `RequiresRefresh=true` means CIPP is having trouble reaching that tenant.

### Look up a user

```json
cipp___cipp_list_users { "tenantFilter": "accessburner.com", "searchField": "displayName", "searchValue": "Anth" }
cipp___cipp_list_users { "tenantFilter": "accessburner.com", "userId": "abarone@accessburner.com" }
cipp___cipp_get_user   { "tenantFilter": "accessburner.com", "userId": "abarone@accessburner.com" }
```
`searchField` is one of `displayName`, `userPrincipalName`, `mail`, `givenName`, `surname`; the match is a case-insensitive prefix. `cipp___cipp_get_user` returns the full record as JSON (licenses, aliases, sync state). For totals only:

```json
cipp___cipp_user_counts { "tenantFilter": "accessburner.com" }
→ {"LicUsers":26,"Guests":5,"Gas":4,"Users":43,...}
```

### "Is this user's account healthy?" (helpdesk triage)

```json
cipp___cipp_list_mfa_users            { "tenantFilter": "accessburner.com", "user": "abarone" }
cipp___cipp_list_user_signin_logs     { "tenantFilter": "accessburner.com", "userId": "abarone@accessburner.com", "top": 10 }
cipp___cipp_list_user_groups          { "tenantFilter": "accessburner.com", "userId": "abarone@accessburner.com" }
cipp___cipp_list_user_devices         { "tenantFilter": "accessburner.com", "userId": "abarone@accessburner.com" }
cipp___cipp_list_user_ca_policies     { "tenantFilter": "accessburner.com", "userId": "abarone@accessburner.com" }
cipp___cipp_get_user_mailbox_details  { "tenantFilter": "accessburner.com", "userId": "abarone@accessburner.com" }
```
`userId` accepts a UPN or object ID everywhere. Sign-in logs are resolved to the object ID automatically.

### Suspected compromise (BEC)

```json
cipp___cipp_bec_check               { "tenantFilter": "accessburner.com", "userId": "873454fd-...", "userName": "abarone@accessburner.com" }
cipp___cipp_list_user_mailbox_rules { "tenantFilter": "accessburner.com", "userId": "abarone@accessburner.com" }
cipp___cipp_list_signins            { "tenantFilter": "accessburner.com", "user": "abarone", "days": 7 }
cipp___cipp_list_signins            { "tenantFilter": "accessburner.com", "failedOnly": true, "days": 3 }
cipp___cipp_list_mailbox_forwarding { "tenantFilter": "accessburner.com", "externalOnly": true }
```
`cipp___cipp_bec_check` needs the object ID in `userId` (get it from `cipp___cipp_get_user`) and polls CIPP for up to 60 s. If it returns `{"Waiting":true,...}`, call it again with the same arguments.

### Mailboxes

```json
cipp___cipp_list_mailboxes            { "tenantFilter": "accessburner.com", "type": "SharedMailbox" }
cipp___cipp_list_mailboxes            { "tenantFilter": "accessburner.com", "displayName": "smith" }
cipp___cipp_list_mailboxes            { "tenantFilter": "accessburner.com", "identity": "team@accessburner.com" }
cipp___cipp_list_mailbox_permissions  { "tenantFilter": "accessburner.com", "upn": "team@accessburner.com" }
cipp___cipp_list_calendar_permissions { "tenantFilter": "accessburner.com", "upn": "abarone@accessburner.com" }
cipp___cipp_get_out_of_office         { "tenantFilter": "accessburner.com", "userId": "abarone@accessburner.com" }
```
Mailbox CSV includes `ForwardingSmtpAddress`, `DeliverToMailboxAndForward`, `ArchiveEnabled`, `LitigationHoldEnabled`. `type` is one of `UserMailbox`, `SharedMailbox`, `RoomMailbox`, `EquipmentMailbox`.

### "Did the email arrive?"

```json
cipp___cipp_message_trace { "tenantFilter": "accessburner.com", "recipient": "abarone@accessburner.com", "days": 2, "limit": 20 }
cipp___cipp_message_trace { "tenantFilter": "accessburner.com", "sender": "*@karldungsusa.com", "subject": "HPSV" }
cipp___cipp_message_trace { "tenantFilter": "accessburner.com", "messageId": "<SJ0PR04MB7407...@...outlook.com>" }
```
Columns: `Received,SenderAddress,RecipientAddress,Subject,Status,Size,FromIP,MessageId`. `days` defaults to 2, max 10. Add `"status": "Failed"` or `"Quarantined"` to narrow.

### Groups

```json
cipp___cipp_list_groups { "tenantFilter": "accessburner.com", "search": "sales" }
cipp___cipp_list_groups { "tenantFilter": "accessburner.com", "groupId": "2faec310-...", "members": true }
cipp___cipp_list_groups { "tenantFilter": "accessburner.com", "search": "", "groupType": "distribution" }
```
`search` matches displayName or mail. With `groupId` plus `members: true` (or `owners: true`) you get the member list instead.

### Security posture

```json
cipp___cipp_list_conditional_access_policies { "tenantFilter": "accessburner.com" }
cipp___cipp_list_conditional_access_policies { "tenantFilter": "accessburner.com", "policyId": "a4cef421-..." }
cipp___cipp_list_named_locations             { "tenantFilter": "accessburner.com" }
cipp___cipp_list_mfa_users                   { "tenantFilter": "accessburner.com", "unregisteredOnly": true }
cipp___cipp_list_roles                       { "tenantFilter": "accessburner.com" }
cipp___cipp_list_inactive_accounts           { "tenantFilter": "accessburner.com", "inactiveDays": 90 }
cipp___cipp_list_guest_users                 { "tenantFilter": "accessburner.com", "status": "stale" }
cipp___cipp_get_secure_score                 { "tenantFilter": "AllTenants", "limit": 200 }
cipp___cipp_list_domain_health               { "tenantFilter": "accessburner.com" }
```
`cipp___cipp_list_roles` returns one row per admin role with `MemberCount` and a `;`-joined `MemberUPNs`. Domain health reads CIPP's cached Domain Analyser (SPF/DMARC/DKIM/DNSSEC score per domain); add `"live": true` for fresh DNS lookups (slower, JSON).

### Devices

```json
cipp___cipp_list_devices { "tenantFilter": "accessburner.com", "nonCompliantOnly": true }
cipp___cipp_list_devices { "tenantFilter": "accessburner.com", "search": "dwood" }
cipp___cipp_get_device   { "tenantFilter": "accessburner.com", "deviceName": "BURNERJONES2025" }
```

### Standards and alignment

```json
cipp___cipp_list_standard_templates { }
cipp___cipp_list_standard_templates { "templateId": "ddb20679-..." }
cipp___cipp_get_tenant_alignment    { "tenantFilter": "accessburner.com" }
cipp___cipp_get_tenant_alignment    { "summary": true }
cipp___cipp_get_tenant_drift        { "tenantFilter": "accessburner.com" }
cipp___cipp_list_standards          { "tenantFilter": "accessburner.com" }
```
`summary: true` returns the estate roll-up (average score, buckets, lowest tenants) as JSON.

### Licenses

```json
cipp___cipp_list_licenses        { "tenantFilter": "accessburner.com" }
cipp___cipp_list_licenses_report { "tenantFilter": "AllTenants", "limit": 500 }
```

### CIPP itself (alerts, logs, GDAP, scheduler)

```json
cipp___cipp_list_alert_queue         { }
cipp___cipp_list_alert_results       { "tenantFilter": "accessburner.com" }
cipp___cipp_list_service_health      { "tenantFilter": "accessburner.com" }
cipp___cipp_list_logs                { "severity": "Error", "days": 1, "limit": 50 }
cipp___cipp_list_logs                { "tenant": "accessburner.com", "days": 7 }
cipp___cipp_list_audit_logs          { "tenantFilter": "accessburner.com", "user": "abarone", "days": 30 }
cipp___cipp_list_gdap_relationships  { "customer": "access" }
cipp___cipp_list_gdap_invites        { }
cipp___cipp_list_scheduled_items     { "name": "vacation" }
cipp___cipp_get_version              { }
```
`cipp___cipp_list_logs` requires at least one of `severity`, `tenant`, `user`, `api` (an unfiltered day is 10k+ rows).

### Anything else: raw read-only Graph / Exchange

```json
cipp___cipp_graph_request { "tenantFilter": "accessburner.com", "endpoint": "users", "countOnly": true }
cipp___cipp_graph_request { "tenantFilter": "accessburner.com", "endpoint": "users",
                            "select": "displayName,userPrincipalName,accountEnabled",
                            "filter": "accountEnabled eq false", "top": 50 }
cipp___cipp_graph_request { "tenantFilter": "accessburner.com", "endpoint": "groups/2faec310-.../members",
                            "select": "displayName,userPrincipalName" }
cipp___cipp_exo_request   { "tenantFilter": "accessburner.com", "cmdlet": "Get-CASMailbox",
                            "cmdParams": { "Identity": "abarone@accessburner.com" },
                            "select": "Identity,PopEnabled,ImapEnabled,ActiveSyncEnabled" }
cipp___cipp_exo_request   { "tenantFilter": "accessburner.com", "cmdlet": "Get-TransportRule",
                            "select": "Name,State,Priority,Description" }
```
- Graph: `endpoint` is the path without version (`users`, `deviceManagement/managedDevices`, `groups/<id>/members`). Always pass `select`; `top` (default 50) fetches one page only. Use `countOnly: true` first to size a collection. `version: "beta"` when needed.
- Exchange: only `Get-*` / `Search-*` cmdlets are accepted. `select` is required and becomes the CSV columns.

## Output shaping cheatsheet

| Input | Effect |
|---|---|
| `"fields": ["displayName", "signInActivity.lastSignInDateTime"]` | replace default columns; dotted paths, `.length` on arrays |
| `"limit": 25` | cap rows; footer reports the total |
| `"format": "json"` | compact JSON array instead of CSV (projected to `fields` if given) |
| footer `# showing N of M rows` | rows were cut: add a filter |
| footer `# response truncated at 32 KB` | hard cap hit: add a filter or drop columns |
| `# no rows` | empty result |

## Error messages you will see

- `a filter is required to keep the response small. Provide one of: ...` : add one of the listed inputs.
- `tenantFilter='AllTenants' is not allowed for this tool` : pick one tenant via `cipp___cipp_list_tenants`.
- `cmdlet "Set-Mailbox" is not allowed` : the EXO tool is read-only; only Get-/Search- cmdlets.
- `CIPP API returned HTTP 4xx/5xx ...` : CIPP-side error (permissions, tenant not consented, feature disabled). The body is included verbatim.
