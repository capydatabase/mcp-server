/**
 * The hosted remote server at https://mcp.capydb.dev, configured from the
 * deployment's environment. `api/*.js` expose it as Vercel Functions.
 *
 * - CAPYDB_API_URL (optional) - control plane base URL, called directly;
 *   defaults to https://api.capydb.dev.
 * - CAPYDB_MCP_RESOURCE_URL (optional) - the public MCP endpoint URL; defaults
 *   to https://mcp.capydb.dev/mcp. Must equal what users enter in their client.
 * - CAPYDB_OAUTH_ISSUER (optional) - the OAuth issuer; defaults to
 *   https://api.capydb.dev. KEEP IN LOCKSTEP with the control plane's
 *   CAPYDB_OAUTH_ISSUER.
 * - CAPYDB_BRIDGE_CLIENT_IP_SECRET (recommended) - the control plane's secret of
 *   the same name, so its limits key on each caller instead of on Vercel's
 *   egress addresses.
 */

import { createCapyDBHttpHandler } from "./http.js";

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export const handler = createCapyDBHttpHandler({
  apiUrl: env("CAPYDB_API_URL") ?? "https://api.capydb.dev",
  resourceUrl: env("CAPYDB_MCP_RESOURCE_URL") ?? "https://mcp.capydb.dev/mcp",
  authorizationServerUrl: env("CAPYDB_OAUTH_ISSUER") ?? "https://api.capydb.dev",
  clientIpSecret: env("CAPYDB_BRIDGE_CLIENT_IP_SECRET"),
  // vercel.json allows the MCP function 300 seconds; leave room to answer.
  provisionTimeoutMs: 4 * 60_000,
});
