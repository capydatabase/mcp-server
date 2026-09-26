/**
 * Remote (Streamable HTTP) entry point.
 *
 * Serves the same server definition as the stdio entry to hosted MCP clients -
 * Claude (web, desktop, mobile, Cowork), Claude Code over HTTP, and any other
 * client that speaks MCP authorization. The caller authenticates with an OAuth
 * access token issued by the CapyDB control plane (its authorization server
 * lives at `/oauth/*` on the control plane); the token is a CapyDB API key, so
 * this module forwards it to the control plane unchanged and holds no state.
 *
 * Authentication is lazy: `initialize`, `tools/list` and the anonymous
 * ephemeral-database tools work without a token, and only a `tools/call` for a
 * tool that needs an account is refused - with an HTTP 401 and a
 * `WWW-Authenticate` challenge, which is what makes a client start its OAuth
 * flow and retry. A tool result cannot do that: the MCP SDK wraps whatever a
 * handler returns in a 200, which clients show the model as a tool error
 * instead of prompting the user to sign in. That is why the gate runs here, on
 * the parsed JSON-RPC body, before the SDK sees the request - and why a
 * revoked or expired token is caught here too, by asking the control plane
 * about it, rather than inside the tool that would fail with it.
 */

import { isIP } from "node:net";

import { createMcpHandler, type AuthInfo } from "@modelcontextprotocol/server";

import type { EnsureResult, ToolAuth } from "./auth.js";
import { CapyDBClient } from "./client.js";
import { createCapyDBServer } from "./server.js";
import { ANONYMOUS_TOOLS } from "./tools.js";

/**
 * The scopes a connected client asks for: exactly what the tools reach.
 * KEEP IN LOCKSTEP with `oauthScopes` in backend/internal/httpapi/oauth.go.
 */
export const OAUTH_SCOPES = [
  "projects:read",
  "projects:write",
  "credentials:read",
  "jobs:read",
  "backups:read",
  "backups:write",
  "organizations:read",
] as const;

/**
 * Only tenant API keys are forwarded. The control plane's admin and service
 * tokens never carry this prefix, so they cannot be relayed through this public
 * endpoint - the same boundary the dashboard bridge draws.
 */
const TENANT_API_KEY_PREFIX = "capy_live_";

/** How long a token the control plane accepted is trusted without asking again. */
const TOKEN_CHECK_TTL_MS = 60_000;
/** Bound on the per-instance token-check cache; it is cleared when full. */
const TOKEN_CHECK_CACHE_MAX = 10_000;

/**
 * Headers that let the control plane key its rate limits and the per-caller
 * bound on unclaimed ephemeral databases on this server's caller instead of on
 * the hosting platform's egress address.
 * KEEP IN LOCKSTEP with backend/internal/httpapi/middleware.go (requestClientIP)
 * and frontend/src/app/api/capydb/[...path]/route.ts.
 */
const CLIENT_IP_HEADER = "X-CapyDB-Client-IP";
const CLIENT_IP_SECRET_HEADER = "X-CapyDB-Bridge-Secret";

/**
 * Browser-based MCP clients (the MCP Inspector, web IDEs) need CORS to read the
 * 401 challenge and the session headers. Credentials are bearer tokens only -
 * never cookies - so answering every origin grants a page nothing it does not
 * already hold.
 */
const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers":
    "authorization, content-type, accept, last-event-id, mcp-protocol-version, mcp-session-id",
  "access-control-expose-headers": "www-authenticate, mcp-protocol-version, mcp-session-id",
  "access-control-max-age": "86400",
};

export interface CapyDBHttpOptions {
  /** Control plane base URL, called directly (e.g. `https://api.capydb.dev`). */
  apiUrl: string;
  /**
   * Public URL of the MCP endpoint, exactly as users enter it in their client
   * (e.g. `https://mcp.capydb.dev/mcp`). Clients compare it with the `resource`
   * in the protected resource metadata and send it as the OAuth `resource`.
   */
  resourceUrl: string;
  /** The OAuth issuer that mints tokens for this resource (e.g. `https://api.capydb.dev`). */
  authorizationServerUrl: string;
  /**
   * The control plane's `CAPYDB_BRIDGE_CLIENT_IP_SECRET`. Without it every
   * caller shares this server's address in the control plane's limits.
   */
  clientIpSecret?: string;
  /** How long `create_project` may wait; keep it under the platform's request limit. */
  provisionTimeoutMs: number;
}

export interface CapyDBHttpHandler {
  /** Serves the MCP endpoint. */
  mcp(request: Request): Promise<Response>;
  /** Serves the RFC 9728 protected resource metadata document. */
  protectedResourceMetadata(request: Request): Response;
}

type TokenCheck = "valid" | "invalid";

/** Tool auth for one HTTP request: the caller's bearer token, or nothing. */
class BearerAuth implements ToolAuth {
  constructor(private readonly token: string | undefined) {}

  async ensure(): Promise<EnsureResult> {
    if (this.token === undefined) {
      return {
        ok: false,
        message: "Sign in to CapyDB to use this tool: reconnect the CapyDB connector.",
      };
    }
    return { ok: true, apiKey: this.token };
  }
}

export function createCapyDBHttpHandler(options: CapyDBHttpOptions): CapyDBHttpHandler {
  const apiUrl = options.apiUrl.replace(/\/+$/, "");
  const resource = new URL(options.resourceUrl);
  const resourcePath = resource.pathname === "/" ? "" : resource.pathname;
  const metadataUrl = `${resource.origin}/.well-known/oauth-protected-resource${resourcePath}`;
  const checkedTokens = new Map<string, number>();

  const callerHeaders = (request: Request | undefined): Record<string, string> => {
    const secret = options.clientIpSecret?.trim();
    const ip = request === undefined ? undefined : callerIp(request);
    if (!secret || ip === undefined) return {};
    return { [CLIENT_IP_HEADER]: ip, [CLIENT_IP_SECRET_HEADER]: secret };
  };

  const handler = createMcpHandler(
    (ctx) => {
      const token = ctx.authInfo?.token;
      const client = new CapyDBClient({
        baseUrl: apiUrl,
        headers: callerHeaders(ctx.requestInfo),
        getApiKey: () => {
          if (token === undefined) throw new Error("CapyDB MCP request has no access token");
          return token;
        },
      });
      return createCapyDBServer(client, new BearerAuth(token), {
        deviceLogin: false,
        provisionTimeoutMs: options.provisionTimeoutMs,
      });
    },
    {
      onerror: (error) => console.error("capydb-mcp http: transport error:", error.message),
    },
  );

  const checkToken = async (token: string, request: Request): Promise<TokenCheck> => {
    if (!token.startsWith(TENANT_API_KEY_PREFIX)) return "invalid";
    const key = await sha256Hex(token);
    const now = Date.now();
    const trustedUntil = checkedTokens.get(key);
    if (trustedUntil !== undefined && trustedUntil > now) return "valid";

    const response = await fetch(`${apiUrl}/v1/me`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        ...callerHeaders(request),
      },
    });
    // Drain the body so the connection can be reused; its content is not needed.
    await response.arrayBuffer();
    if (response.status === 401 || response.status === 403) {
      checkedTokens.delete(key);
      return "invalid";
    }
    if (!response.ok) {
      throw new Error(`CapyDB token check failed: HTTP ${response.status}`);
    }
    if (checkedTokens.size >= TOKEN_CHECK_CACHE_MAX) checkedTokens.clear();
    checkedTokens.set(key, now + TOKEN_CHECK_TTL_MS);
    return "valid";
  };

  const challenge = (error?: { code: string; description: string }): Response => {
    const params = [
      ...(error === undefined
        ? []
        : [`error="${error.code}"`, `error_description="${error.description}"`]),
      `resource_metadata="${metadataUrl}"`,
      `scope="${OAUTH_SCOPES.join(" ")}"`,
    ];
    const body =
      error === undefined
        ? { error: "invalid_token", error_description: "Sign in to CapyDB to use this tool" }
        : { error: error.code, error_description: error.description };
    return withCors(
      Response.json(body, {
        status: 401,
        headers: { "www-authenticate": `Bearer ${params.join(", ")}` },
      }),
    );
  };

  return {
    async mcp(request) {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }

      let parsedBody: unknown;
      let hasParsedBody = false;
      if (request.method === "POST") {
        try {
          parsedBody = await request.clone().json();
          hasParsedBody = true;
        } catch {
          // Not JSON: the MCP handler answers it with the protocol's own error.
        }
      }

      const token = bearerToken(request);
      if (token !== undefined) {
        let check: TokenCheck;
        try {
          check = await checkToken(token, request);
        } catch (error) {
          console.error("capydb-mcp http:", error instanceof Error ? error.message : String(error));
          return withCors(
            Response.json(
              {
                jsonrpc: "2.0",
                error: {
                  code: -32603,
                  message: "CapyDB is temporarily unreachable; retry shortly.",
                },
                id: null,
              },
              { status: 503 },
            ),
          );
        }
        if (check === "invalid") {
          return challenge({
            code: "invalid_token",
            description: "The access token is expired, revoked or not a CapyDB token",
          });
        }
      } else if (hasParsedBody && callsAccountTool(parsedBody)) {
        return challenge();
      }

      const authInfo: AuthInfo | undefined =
        token === undefined
          ? undefined
          : { token, clientId: "capydb-oauth", scopes: [...OAUTH_SCOPES], resource };
      const response = await handler.fetch(request, {
        ...(authInfo === undefined ? {} : { authInfo }),
        ...(hasParsedBody ? { parsedBody } : {}),
      });
      return withCors(response);
    },

    protectedResourceMetadata(request) {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }
      return withCors(
        Response.json(
          {
            resource: resource.href,
            authorization_servers: [options.authorizationServerUrl.replace(/\/+$/, "")],
            scopes_supported: [...OAUTH_SCOPES],
            bearer_methods_supported: ["header"],
            resource_name: "CapyDB",
            resource_documentation: "https://docs.capydb.dev/docs/guides/integrations/claude",
          },
          { headers: { "cache-control": "public, max-age=300" } },
        ),
      );
    },
  };
}

/** True when any JSON-RPC message in the body calls a tool that needs an account. */
function callsAccountTool(body: unknown): boolean {
  const messages = Array.isArray(body) ? body : [body];
  return messages.some((message) => {
    if (typeof message !== "object" || message === null) return false;
    if ((message as { method?: unknown }).method !== "tools/call") return false;
    const name = (message as { params?: { name?: unknown } }).params?.name;
    // A call that names no tool is not refused here; the SDK rejects it itself.
    return typeof name === "string" && !ANONYMOUS_TOOLS.has(name);
  });
}

function bearerToken(request: Request): string | undefined {
  const header = request.headers.get("authorization");
  if (header === null) return undefined;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match?.[1];
}

/**
 * The caller's address as the hosting platform reports it. Vercel overwrites
 * `x-forwarded-for` with the connecting client rather than passing a
 * client-supplied value through; anything that is not an IP is dropped.
 */
function callerIp(request: Request): string | undefined {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const candidate = forwarded || request.headers.get("x-real-ip")?.trim();
  return candidate && isIP(candidate) !== 0 ? candidate : undefined;
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(CORS_HEADERS)) headers.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
