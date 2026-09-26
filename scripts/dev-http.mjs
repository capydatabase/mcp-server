// Serves the remote HTTP entry on localhost for development against a local
// control plane (backend `docker compose up`). Build first: `pnpm build`.
//
//   CAPYDB_API_URL=http://localhost:8090 node scripts/dev-http.mjs
//   claude mcp add --transport http capydb-local http://localhost:3333/mcp
//
// PORT (default 3333), CAPYDB_API_URL (default http://localhost:8090) and
// CAPYDB_OAUTH_ISSUER (default: CAPYDB_API_URL) configure it.
import { createServer } from "node:http";

import { createCapyDBHttpHandler } from "../dist/http.js";

const port = Number(process.env.PORT ?? 3333);
const apiUrl = process.env.CAPYDB_API_URL ?? "http://localhost:8090";
const origin = `http://localhost:${port}`;

const handler = createCapyDBHttpHandler({
  apiUrl,
  resourceUrl: `${origin}/mcp`,
  authorizationServerUrl: process.env.CAPYDB_OAUTH_ISSUER ?? apiUrl,
  provisionTimeoutMs: 5 * 60_000,
});

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", origin);
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
  const request = new Request(url, {
    method: req.method,
    headers: Object.entries(req.headers).flatMap(([name, value]) =>
      value === undefined ? [] : [[name, Array.isArray(value) ? value.join(", ") : value]],
    ),
    body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
  });

  let response;
  if (url.pathname === "/mcp") {
    response = await handler.mcp(request);
  } else if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
    response = handler.protectedResourceMetadata(request);
  } else {
    response = new Response("not found", { status: 404 });
  }

  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (response.body === null) {
    res.end();
    return;
  }
  for await (const chunk of response.body) res.write(chunk);
  res.end();
}).listen(port, () => {
  console.error(`capydb-mcp http dev server on ${origin}/mcp (API: ${apiUrl})`);
});
