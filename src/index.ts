#!/usr/bin/env node
/**
 * CapyDB MCP server - stdio entry point.
 *
 * Exposes CapyDB managed Postgres (projects, preview databases, backups,
 * restores, imports, SQL, observability, jobs) to MCP clients.
 *
 * Authentication (in precedence order):
 * 1. CAPYDB_API_KEY (optional) - explicit API key for headless/CI setups.
 * 2. The CapyDB CLI's saved credentials (`capydb auth login`) from the shared
 *    user config file.
 * 3. First-run browser device login: with no credential, the server still
 *    starts; the first tool call returns a one-time approval URL, and once the
 *    user approves it in the dashboard the minted key is saved for future runs.
 *
 * Other configuration:
 * - CAPYDB_API_URL (optional) - control plane base URL,
 *                    defaults to https://capydb.dev/api/capydb.
 * - CAPYDB_APP_URL (optional) - dashboard origin for approval URLs; derived
 *                    from CAPYDB_API_URL when unset. Required when the API URL
 *                    is not <dashboard>/api/capydb, or the approval link 404s.
 */

import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { version as SERVER_VERSION } from "../package.json" with { type: "json" };
import { AuthManager } from "./auth.js";
import { CapyDBClient } from "./client.js";
import { registerTools } from "./tools.js";

async function main(): Promise<void> {
  // Auth and the API client are process-scoped, not per-connection: AuthManager
  // caches the resolved credential (and any key minted by the device login), and
  // the factory below can run more than once per process - once for the pinned
  // connection, plus once for a discarded `server/discover` probe.
  const auth = await AuthManager.create();
  const client = new CapyDBClient({ getApiKey: () => auth.apiKey(), baseUrl: auth.apiUrl });

  // `serveStdio` owns the transport and picks the protocol era from the opening
  // exchange: `server/discover` pins the connection to 2026-07-28, an
  // `initialize` handshake pins it to the 2025 era. Both are served from this
  // one factory, so hosts that predate the 2026 revision keep working - do not
  // pass `legacy: 'reject'`.
  serveStdio(
    () => {
      const server = new McpServer(
        {
          name: "capydb",
          title: "CapyDB",
          version: SERVER_VERSION,
          description:
            "Official CapyDB MCP server - managed Postgres projects, preview databases, backups, restores, and SQL for AI agents.",
          websiteUrl: "https://capydb.dev",
          icons: [
            { src: "https://capydb.dev/favicon.svg", mimeType: "image/svg+xml" },
            {
              src: "https://capydb.dev/web-app-manifest-192x192.png",
              mimeType: "image/png",
              sizes: ["192x192"],
            },
          ],
        },
        {
          instructions: [
            "CapyDB is managed Postgres. Cross-tool conventions:",
            "- Mutating tools (create_preview_database, create_backup, restore, import_database, extension changes) return a job: poll get_job until its state is completed or failed.",
            "- If a tool result carries a device-login approval URL, relay that URL to the user, wait for their approval, then retry the tool.",
            "- create_ephemeral_database, get_ephemeral_database and destroy_ephemeral_database need no account and never trigger the device login: use them when the user wants a throwaway database right now. It is destroyed after 72 hours unless claim_ephemeral_database attaches it to their organization; when the user is done with it, destroy_ephemeral_database ends it early and frees its slot.",
            "- Before destructive SQL, an import, or a restore into an existing preview, call create_restore_point first so the change is reversible.",
            "- Connection-string results embed live database credentials: never log them or write them into files, commits, or summaries.",
          ].join("\n"),
        },
      );
      registerTools(server, client, auth);
      return server;
    },
    {
      // Out-of-band transport errors would otherwise be swallowed.
      onerror: (error) => console.error("capydb-mcp: transport error:", error.message),
    },
  );

  // stdout is the MCP transport; diagnostics must go to stderr.
  console.error(
    `capydb-mcp v${SERVER_VERSION} ready (API: ${auth.apiUrl}, auth: ${auth.describe()})`,
  );
}

main().catch((error: unknown) => {
  console.error("capydb-mcp: fatal:", error instanceof Error ? error.message : error);
  process.exit(1);
});
