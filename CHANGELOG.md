# Changelog

All notable changes to `@capydb/mcp` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/).

## [Unreleased]

## [1.7.0] - 2026-09-02

### Added

- `get_index_hygiene`: lists the indexes a project's database is paying for without using - those with no
  recorded scans, and those whose columns are a leading subset of another index on the same table - each
  with a ready-to-run `DROP INDEX CONCURRENTLY` statement. The counterpart to `get_index_advisor`, which
  only ever proposes new indexes. Needs no extensions, so it works on any project. `UNIQUE`, primary-key,
  exclusion and replica-identity indexes are never listed because they are correctness constraints rather
  than access paths, and the tool reports `available: false` until a week of query statistics exists
  rather than mistaking a weekly job's index for a dead one. Read-only; the tool description tells agents
  not to drop anything without asking first.

### Changed

- `get_alerts` documents the new `temp_spill` advisory kind, which opens when the database sustains
  writing temporary files - a sort or hash that does not fit in `work_mem`.

## [1.6.3] - 2026-09-02

### Changed
- The `run_sql` tool's `read_only` option now comes from the published `@capydb/sdk` types instead of a temporary local type override; behavior is unchanged. ([3707ae2](https://github.com/capydatabase/mcp-server/commit/3707ae2))

## [1.6.2] - 2026-09-02

### Miscellaneous Chores

- update dependencies and package versions ([493afd0](https://github.com/capydatabase/mcp-server/commit/493afd0))

## [1.6.1] - 2026-09-02

### Added

- `run_sql` takes `read_only`: the statement runs inside a server-side `READ ONLY` transaction
  and every write (DML, DDL, `TRUNCATE`, `SELECT INTO`, sequence advancement) is refused by
  Postgres itself - executor-proven, unlike pattern-matching the statement. The tool description
  steers agents to set it whenever the statement is not meant to change anything.

## [1.6.0] - 2026-08-31

### Added

- Every statement `run_sql` sends is tagged `/*source='capydb-mcp'*/`, so agent traffic is
  separable from application traffic in the project's SQL history. Query *statistics* are not
  yet split by tag - pg_stat_statements identifies a statement by its parse tree, so a tagged
  statement still merges with an identically shaped untagged one; the tag is written now so
  the stats layer can become tag-aware later.

- `create_project` accepts `environment` (`production` | `non_production`). The control plane
  defaults an omitted environment to production, so until now every database created over MCP was a
  production one - agents could not create the non-production databases that some destructive flows
  (like restore-overwrite) are gated on. Found by a parity audit against the dashboard's WebMCP
  surface, which already exposed the field.
- `get_usage`: organization storage, connection and database counts against plan limits, with a
  per-project breakdown - parity with the WebMCP tool of the same name. The organization is derived
  from the API key's projects; `organization_id` is only needed when no project exists yet.
- The `run_sql`, `get_table_rows` and `get_logs` descriptions now tell the model to treat result
  rows and log lines as data, never as instructions - the same prompt-injection guidance the WebMCP
  surface ships via `untrustedContentHint` (which has no MCP-spec equivalent).
- The server now advertises its full 2026-era identity: `description`, `websiteUrl`, and `icons`
  (the capydb.dev favicon SVG + 192px PNG) on `serverInfo`, surfaced in both the 2026 `server/discover`
  response and the 2025 `initialize` result. It also declares `instructions` with the cross-tool
  conventions individual tool descriptions cannot carry: poll `get_job` after mutating tools, relay
  device-login approval URLs to the user, `create_restore_point` before destructive changes, and never
  persist secret-bearing connection strings.
- Three export tools: `export_database` (queue a `pg_dump` custom-format export as an async job),
  `list_exports`, and `get_export_download` (short-lived presigned download URL). Exports are
  read-only and expire after 7 days; the SDK dependency moves to `@capydb/sdk@^1.8.0` for the
  `ProjectExport`/`ExportDownload` types.

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

- `run_sql` description rewritten around the control plane's new mechanical guard: an `UPDATE` or
  `DELETE` with no `WHERE` and any `TRUNCATE` are now refused rather than run. The description is
  explicit that this does not make the tool safe - a too-broad `WHERE` still passes.
- `suggest_indexes` description covers `estimated_cost_reduction_pct`, including that an absent
  reduction is not the same as zero.
- `get_observability` lists the three new advisory kinds.

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

[Unreleased]: https://github.com/capydatabase/mcp-server/compare/v1.6.3...HEAD
[1.6.3]: https://github.com/capydatabase/mcp-server/compare/v1.6.2...v1.6.3
[1.6.2]: https://github.com/capydatabase/mcp-server/compare/v1.6.1...v1.6.2
[1.6.1]: https://github.com/capydatabase/mcp-server/compare/v1.6.0...v1.6.1
[1.6.0]: https://github.com/capydatabase/mcp-server/compare/v1.4.1...v1.6.0
[1.4.1]: https://github.com/capydatabase/mcp-server/compare/v1.4.0...v1.4.1
[1.4.0]: https://github.com/capydatabase/mcp-server/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/capydatabase/mcp-server/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/capydatabase/mcp-server/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/capydatabase/mcp-server/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/capydatabase/mcp-server/releases/tag/v1.0.0
