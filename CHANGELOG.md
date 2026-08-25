# Changelog

All notable changes to `@capydb/mcp` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/).

## [Unreleased]

### Fixed

- The first-run device-login approval URL pointed at the API host whenever the saved CLI credential's
  `api_url` is a sibling of the dashboard rather than a path under it (e.g. `https://api.capydb.dev`),
  producing a link that 404s. Two causes: `readStoredConfig` discarded any organization entry without
  an `api_key` - which is exactly the state the device login runs in - so the saved `app_url` was
  never visible; and `dashboardUrl` re-derived the origin from the API URL instead of using it.
  Entries carrying only endpoint configuration are now kept (matching the CLI's `Active()`), and the
  dashboard origin follows the CLI's `UserConfig.AppURL()` precedence: `CAPYDB_APP_URL`, then the
  saved `app_url`, then the derivation. A saved `app_url` is dropped when `CAPYDB_API_URL` retargets
  the control plane elsewhere, so a session opened against one deployment is never advertised with
  another one's dashboard link. The resolved value is what gets persisted after a login.

### Changed

- `list_alerts` returns only OPEN alerts by default, capped at 50, with `include_resolved` and
  `limit` to widen it. The endpoint returns open alerts plus everything resolved in the last 30 days,
  unbounded - right for the dashboard's history view, but on a project with a flapping condition that
  is tens of kilobytes of resolved rows in a single tool result. One dogfood project returned 46 KB;
  the same call now returns 92 bytes. The result carries `open_count` and `total_matching` so the
  narrowing is visible rather than silent.
- `run_sql`'s description no longer tells the agent to "prefer running the statement against a
  preview database first". The tool has no `preview_id` and always targets the project's own
  database, so that advice could not be acted on; it now says so and points at the preview connection
  string, and at `get_schema`/`generate_types` which do accept `preview_id`.

- The version advertised in the MCP handshake is read from `package.json`. It was hardcoded to
  `0.2.0`, so every client saw `0.2.0` while npm shipped 1.4.1.
- `src/types.ts` re-exports every control-plane shape from `@capydb/sdk` instead of restating it.
  The local copies carried "switch back once published" notes for types the SDK had already
  shipped, and the SDK's versions are equal or stricter (it expresses the alert-kind and
  log-severity unions too). 324 lines to 67; only the two envelopes the spec models inline
  (`RegionsResponse`) stays local. Requires `@capydb/sdk` 1.6.0.
- `tsconfig.json` is a Node-library configuration again. A shared Next.js template had been applied,
  which pulled in `jsx`, the `next` language-service plugin, DOM/webworker libs and Next-only include
  paths that do not apply to a stdio MCP server.

## [1.4.1] - 2026-08-19

### Fixed

- Billing URL pointed at the wrong path.

## [1.4.0] - 2026-08-18

### Changed

- Connection-string warnings in tool output are clearer about pooled versus direct endpoints.
- Migrated to the split `@modelcontextprotocol/server@2` package and `serveStdio`, serving both wire
  eras. `zod` must stay at 4.2 or later — below that, `tools/list` fails quietly.

## [1.3.0] - 2026-08-18

### Added

- `run_sql` tool guidance covering Postgres 18 specifics, and a standing instruction to create a
  restore point before running destructive SQL.

## [1.2.0] - 2026-08-05

### Added

- `suggest_indexes`, backed by the control plane's index advisor.
- Extension management tools: `list_extensions`, `enable_extension`, `disable_extension`,
  `update_extension`.

## [1.1.0] - 2026-07-24

### Added

- `major_upgrade_preflight`, `list_alerts` and `acknowledge_alert`.

## [1.0.0] - 2026-07-16

### Added

- First release: a stdio MCP server exposing the CapyDB control plane to agents. Projects, preview
  databases, backups, restore points, restores, imports, schema and type generation, tables and rows,
  SQL, logs and observability. All diagnostics go to stderr; production-overwrite restore is
  deliberately not exposed as a tool.
