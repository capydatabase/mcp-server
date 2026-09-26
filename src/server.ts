/**
 * The CapyDB MCP server definition, shared by the stdio entry (`index.ts`) and
 * the remote HTTP entry (`http.ts`), so both transports always serve the same
 * tools, descriptions and instructions.
 */

import { McpServer } from "@modelcontextprotocol/server";

import { version as SERVER_VERSION } from "../package.json" with { type: "json" };
import type { ToolAuth } from "./auth.js";
import type { CapyDBClient } from "./client.js";
import { registerTools } from "./tools.js";

export { SERVER_VERSION };

export interface CapyDBServerOptions {
  /**
   * Whether a tool result can carry a device-login approval URL. True for the
   * stdio server; the HTTP server signs users in through OAuth instead.
   */
  deviceLogin: boolean;
  /** How long `create_project` waits for provisioning; see `RegisterToolsOptions`. */
  provisionTimeoutMs: number;
}

export function createCapyDBServer(
  client: CapyDBClient,
  auth: ToolAuth,
  options: CapyDBServerOptions,
): McpServer {
  const instructions = [
    "CapyDB is managed Postgres. Cross-tool conventions:",
    "- Mutating tools (create_preview_database, create_backup, restore, import_database, extension changes) return a job: poll get_job until its state is completed or failed.",
    ...(options.deviceLogin
      ? [
          "- If a tool result carries a device-login approval URL, relay that URL to the user, wait for their approval, then retry the tool.",
        ]
      : []),
    `- create_ephemeral_database, get_ephemeral_database and destroy_ephemeral_database need no account${options.deviceLogin ? " and never trigger the device login" : ""}: use them when the user wants a throwaway database right now. It is destroyed after 72 hours unless claim_ephemeral_database attaches it to their organization; when the user is done with it, destroy_ephemeral_database ends it early and frees its slot.`,
    "- Use query_sql for statements that only read; execute_sql is for statements that change data or schema.",
    "- Before destructive SQL, an import, or a restore into an existing preview, call create_restore_point first so the change is reversible.",
    "- Connection-string results embed live database credentials: never log them or write them into files, commits, or summaries.",
  ];

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
    { instructions: instructions.join("\n") },
  );
  registerTools(server, client, auth, { provisionTimeoutMs: options.provisionTimeoutMs });
  return server;
}
