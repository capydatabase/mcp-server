# @capydb/mcp

Official [CapyDB](https://capydb.dev) MCP server. Gives AI agents (Claude Code, Cursor, and any other
[Model Context Protocol](https://modelcontextprotocol.io) client) safe, structured access to your managed
Postgres: projects, preview databases, backups, restores, imports, SQL, and observability.
Every CapyDB project runs in its own isolated database cell - a dedicated Postgres runtime
reached with normal connection strings.

Runs over stdio and talks to the CapyDB control plane API - no local database access required.
Serves both the `2026-07-28` protocol revision and the 2025-era revisions, so it works with
current hosts and with clients that have not adopted the new revision yet.

## Install

No install needed; run it with `npx`:

```bash
npx @capydb/mcp
```

Or add it to Claude Code directly:

```bash
claude mcp add capydb -- npx @capydb/mcp
```

## Authentication

No setup is required. Credentials are resolved in this order:

1. **`CAPYDB_API_KEY`** environment variable - always wins. Use this for headless/CI setups.
2. **The CapyDB CLI's saved login** - if you have run `capydb auth login`, the MCP server reuses
   that credential (same config file, same revocation point).
3. **First-run browser approval** - with no credential at all, the server still starts. The first
   tool call returns a one-time approval URL:

   > CapyDB needs a one-time approval. Ask the user to open:
   > `https://capydb.dev/dashboard/cli/login?session=...` - then retry this tool.

   Open the link, approve in the dashboard (signing up and picking a plan inline if needed), and
   retry the tool. The minted API key is saved to the shared CLI config file (`chmod 600`) and no
   further approval is ever needed. Keys minted this way are labeled as agent-created in the
   dashboard key list, where they can be audited and revoked.

The shared config file lives at the CLI's config path: `~/Library/Application Support/capydb/config.json`
on macOS, `$XDG_CONFIG_HOME/capydb/config.json` (default `~/.config/...`) on Linux, `%AppData%\capydb\config.json`
on Windows.

## Configuration

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `CAPYDB_API_KEY` | no | - | Explicit CapyDB API key; skips the device login. Create one in the dashboard under **Organization → API Keys**. **Use a project-scoped key** for long-lived setups so the agent can only touch the project it is working on. |
| `CAPYDB_API_URL` | no | `https://capydb.dev/api/capydb` | Control plane base URL. Only change this for self-hosted / staging setups. |
| `CAPYDB_APP_URL` | no | derived from `CAPYDB_API_URL` | Dashboard origin used for device-login approval URLs. |

### Claude Code (`.mcp.json`)

```json
{
  "mcpServers": {
    "capydb": {
      "command": "npx",
      "args": ["@capydb/mcp"]
    }
  }
}
```

### Cursor (`.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "capydb": {
      "command": "npx",
      "args": ["@capydb/mcp"]
    }
  }
}
```

For headless/CI, add `"env": { "CAPYDB_API_KEY": "capy_..." }` to the server entry.

## Tools

| Tool | What it does | Notes |
| --- | --- | --- |
| `list_regions` | List regions projects can be created in | read-only |
| `create_project` | Create a Postgres project and wait for provisioning | async; waits up to 5 min |
| `list_projects` | List your Postgres projects | read-only |
| `get_project` | Get one project (state, plan, limits) | read-only |
| `get_connection_strings` | Pooled + direct URLs for a project | **secret-bearing output** |
| `create_preview_database` | Create a disposable preview/branch DB (`empty` or `clone`) | async job |
| `list_preview_databases` | List previews with state and TTL | read-only |
| `delete_preview_database` | Delete a preview and its role | **destructive**, async job |
| `reset_preview_database` | Reset a preview back to its base state | **destructive** to the preview, async job |
| `extend_preview_ttl` | Extend a preview's TTL | mutates TTL only |
| `get_preview_connection_strings` | Pooled + direct URLs for a preview | **secret-bearing output** |
| `create_backup` | On-demand backup of the project DB | async job |
| `list_extensions` | List available Postgres extensions with enablement + update state | read-only |
| `enable_extension` | Enable an extension (`CREATE EXTENSION IF NOT EXISTS`) | async job; **restarts the database** for `requires_restart` extensions (e.g. `pg_cron`) |
| `disable_extension` | Disable an extension (`DROP EXTENSION`, no CASCADE) | **destructive**, async job; **restarts the database** for `requires_restart` extensions |
| `update_extension` | Update an enabled extension to the platform-provided version | async job |
| `major_upgrade_preflight` | Check whether the DB can move to a PostgreSQL major, without changing anything | read-only, async job |
| `list_backups` | List backups incl. verification state | read-only |
| `restore` | Restore a backup / restore point / PITR timestamp **into a preview** | **destructive** to the target preview; cannot overwrite production |
| `list_restore_points` | List named restore points + the PITR window | read-only |
| `create_restore_point` | Pin an existing backup key or a PITR timestamp before a risky change | backup keys come from `list_backups` after `create_backup` completes |
| `delete_restore_point` | Delete a restore point after the change is verified | **destructive** |
| `import_preflight` | Check an external source DB before an import | read-only, connects out |
| `import_database` | Import an external database into the project | **destructive**, requires `confirm: true` |
| `run_sql` | Run a SQL statement against the live project DB | read-mostly; row-capped, 15s timeout, recorded in SQL history |
| `get_schema` | Complete schema document: tables, columns, keys, enums, extensions | read-only; prefer over catalog queries |
| `generate_types` | Generate TypeScript / Zod / Drizzle code from the live schema | read-only; `style: supabase` for supabase-js compat |
| `list_tables` | List tables and views | read-only |
| `get_table_rows` | Read rows from a table | read-only |
| `get_observability` | Live metrics: connections, size, active/slow queries, alerts | read-only |
| `get_logs` | Recent database log entries, with severity filter and tail cursor | read-only |
| `list_alerts` | Open + recently resolved project alerts (storage, connections, backups, health advisories) | read-only |
| `acknowledge_alert` | Mark an alert as seen | idempotent; does not resolve the alert |
| `get_job` | Poll an async job until `completed`/`failed` | read-only |
| `list_jobs` | List a project's async jobs | read-only |
| `list_kv_stores` | K/V stores across the organization | read-only |
| `get_kv_store` | One project's K/V store (state, capacity, eviction) | read-only; 404 = no store yet |
| `get_kv_credentials` | K/V REST + RESP endpoints | read-only; the token is never returned |
| `create_kv_store` | Provision the project's K/V store | async job; **secret-bearing output** |

`create_project` notes: the project's plan is derived from the organization's billing state and cannot
be chosen per project. If the organization has no active plan, the tool fails with a link to
`https://capydb.dev/dashboard/settings/billing` (1 month free) so the user can pick one and retry.

### Safety model

- **Production overwrite is not exposed.** The `restore` tool only targets preview databases (new or
  existing). Overwriting the production database is irreversible and requires explicit human confirmation
  plus the org admin role, so it stays in the dashboard and CLI.
- **K/V flush, rotate-token and delete are not exposed.** A K/V store keeps only a periodic snapshot -
  no backups, no point-in-time recovery - so each of those is one irreversible step away from
  unrecoverable data. They stay in the dashboard and the CLI, behind a confirmation. `create_kv_store`
  returns the plaintext token once, because that is the only response that carries it.
- Destructive tools (`delete_preview_database`, `restore`) carry the MCP `destructiveHint` annotation so
  clients can require approval.
- Connection-string tools are clearly marked secret-bearing; instruct your agent not to persist their
  output.
- `run_sql` executes against the live database. Prefer running risky SQL against a preview created with
  `create_preview_database` (mode `clone`) and its `get_preview_connection_strings`.
- **Credential hygiene:** the device-login key is org-wide, expires after 90 days, and is meant for
  interactive sessions. For long-lived or shared agent setups, create a **project-scoped key** in the
  dashboard and pass it via `CAPYDB_API_KEY` instead. Every key - including agent-minted ones - is listed
  with its provenance in the dashboard and can be revoked there at any time.

## Typical flows

**Fresh machine to running database**

1. Any tool → one-time browser approval → 2. `create_project` → 3. `get_connection_strings`.

**Branch database per task**

1. `create_preview_database` (mode `clone`) → 2. `get_job` until `completed` →
3. `get_preview_connection_strings` → work → 4. `delete_preview_database`.

**Investigate production state**

`get_observability` → `list_tables` → `run_sql` with `SELECT`s (use `max_rows` to keep results small).

**Recover data without touching production**

`list_backups` → `restore` with `backup_key` and a `preview_name` → query the preview → copy what you need.

## Development

```bash
pnpm install
pnpm typecheck   # tsgo (TypeScript native preview)
pnpm lint        # oxlint
pnpm build       # tsdown → dist/index.js
node dist/index.js   # CAPYDB_API_KEY=capy_... to skip the device login
```

The API client is hand-written against the control plane's OpenAPI spec
(`backend/internal/httpapi/openapi.json` in the CapyDB monorepo layout). For a full typed SDK, see
[`@capydb/sdk`](https://www.npmjs.com/package/@capydb/sdk).

## License

MIT
