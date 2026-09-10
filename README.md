# CIPP MCP Server (read-only)

MCP (Model Context Protocol) server for [CIPP](https://github.com/KelvinTegelaar/CIPP) — the CyberDrain Improved Partner Portal. Gives AI assistants **read-only**, token-efficient access to CIPP's Microsoft 365 multi-tenant data.

## Design

- **Read-only.** Every tool maps to a CIPP `List*`/`Get*` function (plus `ExecBECCheck`, which only reads). There are no create/edit/reset/offboard tools. Every tool carries `readOnlyHint: true`.
- **Filter-first.** Tools that could dump a whole tenant (`cipp_list_users`, `cipp_list_mailboxes`, `cipp_list_groups`, `cipp_list_devices`, `cipp_list_logs`, ...) require a filter and reject the call with a message naming the accepted filters. `AllTenants` is only accepted by cheap cached reports.
- **CSV by default.** List results are CSV with a curated column set per tool. Every list tool accepts `fields` (column names, dotted paths allowed), `limit` (default 100) and `format` (`csv` | `json`).
- **Hard cap.** Responses are cut at ~32 KB with a `# ...` footer explaining how to narrow the query. Single records are compact JSON with bulky sub-objects dropped.
- **Verified parameter names.** CIPP silently ignores query/body keys it does not read; every parameter sent here was checked against `ref/openapi.json` and the CIPP-API PowerShell source.

## Prerequisites

- Node.js 18+ (Docker image uses Node 22)
- A running CIPP deployment (tested against CIPP 10.10.x)
- A CIPP API client (Settings → Integrations → CIPP-API) or a static Bearer token

## Installation

```sh
git clone https://github.com/chase-vgo/cipp-mcp
cd cipp-mcp
npm install
npm run build
npm test
npm run lint:tools   # read-only / token-efficiency contract check on the built definitions
```

Docker (HTTP transport on :8080):

```sh
cp .env.example .env   # fill in CIPP_BASE_URL + credentials
docker compose up -d --build
curl -s localhost:8080/health
```

## Configuration

| Variable | Required | Description |
|---|---|---|
| `CIPP_BASE_URL` | Yes | Your CIPP deployment URL (e.g. `https://cipp.yourdomain.com`) |
| `CIPP_API_KEY` | One of | Static Bearer token. Use this **or** the OAuth trio below. |
| `CIPP_TENANT_ID` | One of | Entra tenant ID that owns the CIPP API-client app registration. |
| `CIPP_CLIENT_ID` | One of | OAuth client ID issued by CIPP's API Client Management page. |
| `CIPP_CLIENT_SECRET` | One of | OAuth client secret paired with `CIPP_CLIENT_ID`. |
| `CIPP_TOKEN_SCOPE` | No | Override OAuth scope (default `<clientId>/.default`; CIPP usually needs `api://<clientId>/.default`). |
| `CIPP_TOKEN_URL` | No | Override OAuth token endpoint (sovereign clouds only). |
| `MCP_TRANSPORT` | No | `stdio` (default) or `http` |
| `MCP_HTTP_PORT` | No | Port for HTTP mode (default: 8080) |
| `AUTH_MODE` | No | `env` (default) or `gateway` (credentials from `x-base-url` / `x-api-key` ... headers) |
| `LOG_LEVEL` | No | `error`, `warn`, `info` (default), or `debug` |

## Usage with Claude Desktop

```json
{
  "mcpServers": {
    "cipp": {
      "command": "node",
      "args": ["/path/to/cipp-mcp/dist/entry.js"],
      "env": {
        "CIPP_BASE_URL": "https://cipp.yourdomain.com",
        "CIPP_TENANT_ID": "<entra-tenant-id>",
        "CIPP_CLIENT_ID": "<client-id>",
        "CIPP_CLIENT_SECRET": "<client-secret>",
        "CIPP_TOKEN_SCOPE": "api://<client-id>/.default"
      }
    }
  }
}
```

## Tools

Filter column: **req** = at least one of the listed inputs is required. **AT** = `AllTenants` accepted.

| Category | Tool | Filter | Output |
|---|---|---|---|
| Tenants | `cipp_list_tenants` | optional `search` | CSV: name, domain, tenant ID, GDAP status, errors |
| | `cipp_get_tenant_details` | | JSON (plans omitted unless `full`) |
| | `cipp_user_counts` | | JSON: users, licensed, guests, global admins |
| Users | `cipp_list_users` | **req** `userId` \| `searchField`+`searchValue` | CSV |
| | `cipp_get_user` | `userId` | JSON |
| | `cipp_list_mfa_users` | **req** `user` \| `unregisteredOnly` | CSV |
| | `cipp_list_user_groups` | `userId` | CSV |
| | `cipp_list_user_devices` | `userId` | CSV |
| | `cipp_list_user_signin_logs` | `userId`, `top` | CSV |
| | `cipp_list_signins` | **req** `failedOnly` \| `user` \| `filter` | CSV |
| | `cipp_list_inactive_accounts` | `inactiveDays` | CSV |
| | `cipp_list_guest_users` | `staleDays`, `status` | CSV |
| | `cipp_list_roles` | `withMembersOnly`, `role` | CSV: role, member count, member UPNs |
| | `cipp_list_user_ca_policies` | `userId` | CSV |
| | `cipp_bec_check` | `userId`, `userName` | JSON (polls CIPP's async job up to 60 s) |
| Groups | `cipp_list_groups` | **req** `search` \| `groupId` (+`members`/`owners`) | CSV |
| Mailboxes | `cipp_list_mailboxes` | **req** `identity` \| `displayName` \| `type` | CSV incl. forwarding / hold state |
| | `cipp_get_user_mailbox_details` | `userId` | JSON |
| | `cipp_list_mailbox_permissions` | `upn` | CSV |
| | `cipp_list_calendar_permissions` | `upn` | CSV |
| | `cipp_list_user_mailbox_rules` | `userId` | CSV |
| | `cipp_list_mailbox_forwarding` | `externalOnly` · AT | CSV |
| | `cipp_get_out_of_office` | `userId` | JSON |
| | `cipp_message_trace` | **req** `sender` \| `recipient` \| `messageId` | CSV |
| Devices | `cipp_list_devices` | **req** `search` \| `nonCompliantOnly` \| `os` | CSV |
| | `cipp_get_device` | **req** `deviceId` \| `deviceName` \| `serial` | JSON |
| Security | `cipp_list_conditional_access_policies` | `name`, `policyId` | CSV (JSON for one policy) |
| | `cipp_list_named_locations` | | CSV |
| | `cipp_get_secure_score` | AT | CSV |
| Standards | `cipp_list_standards` | `consolidated` | CSV |
| | `cipp_list_standard_templates` | `templateId` | CSV (JSON for one template) |
| | `cipp_get_tenant_drift` | optional `tenantFilter` | CSV |
| | `cipp_get_tenant_alignment` | optional `tenantFilter`, `summary` | CSV / JSON summary |
| | `cipp_list_domain_health` | `live` | CSV from cached Domain Analyser, or live JSON |
| Licenses | `cipp_list_licenses` | `includeExcluded` · AT | CSV |
| | `cipp_list_licenses_report` | AT | CSV |
| Alerts / logs | `cipp_list_audit_logs` | `user` (required), `days`, `operation` | CSV |
| | `cipp_list_alert_queue` | | CSV |
| | `cipp_list_alert_results` | | CSV |
| | `cipp_list_service_health` | AT | CSV |
| | `cipp_list_logs` | **req** `severity` \| `tenant` \| `user` \| `api` | CSV |
| GDAP | `cipp_list_gdap_roles`, `cipp_list_gdap_invites`, `cipp_list_gdap_relationships` | | CSV |
| Scheduler | `cipp_list_scheduled_items` | `tenantFilter`, `name`, `type`, `showHidden` | CSV |
| Raw | `cipp_graph_request` | `endpoint`, `select` (recommended), `filter`, `top`, `countOnly` | CSV from `select`; one page only |
| | `cipp_exo_request` | `cmdlet` (Get-*/Search-* only), `cmdParams`, `select` (required) | CSV from `select` |
| Core | `cipp_ping`, `cipp_get_version` | | JSON |

### Output conventions

- `fields: ["displayName", "location.city", "assignedLicenses.length"]` — dotted paths, `.length` on arrays, case-insensitive segments.
- `limit: 25` — rows are cut and a footer `# showing 25 of N rows; ...` is appended.
- `format: "json"` — compact JSON array (projected to `fields` when given).
- Empty result: `# no rows`. Over the cap: `# response truncated at 32 KB (...)`.

## Authentication Setup

CIPP's API Client Management page provisions an Entra ID app registration and returns an OAuth **client ID + client secret**. The server exchanges these for a short-lived access token via the client-credentials flow and caches it until shortly before expiry.

1. In CIPP: **Settings → CIPP Settings → Integrations → CIPP-API**
2. Create a new API client and copy the **Client ID** and **Client Secret**
3. Configure:
   ```env
   CIPP_BASE_URL=https://cipp.yourdomain.com
   CIPP_TENANT_ID=<your-entra-tenant-id>
   CIPP_CLIENT_ID=<client-id-from-cipp>
   CIPP_CLIENT_SECRET=<client-secret-from-cipp>
   CIPP_TOKEN_SCOPE=api://<client-id-from-cipp>/.default
   ```

If you already have a static Bearer token, set `CIPP_API_KEY` instead. When both are provided, `CIPP_API_KEY` wins.

## Development notes

- `ref/openapi.json` is CIPP's generated OpenAPI spec (700 operations, `x-cipp-role` on each). Function-name casing in paths is case-sensitive (`ListmailboxPermissions`, `listStandardTemplates`).
- Adding a tool: definition in `src/mcp/tool.definitions.ts` (with `columns` and `rules`), a `CippService` method, and a `case` in `src/handlers/tool.handler.ts`. Verify parameter names against `Invoke-<Name>.ps1` in CIPP-API before shipping.

## License

Apache-2.0 — see [LICENSE](LICENSE). Forked from [wyre-technology/cipp-mcp](https://github.com/wyre-technology/cipp-mcp).
