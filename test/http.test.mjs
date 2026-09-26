// Exercises the remote HTTP entry against a stub control plane: the lazy-auth
// gate, token checking, discovery metadata and the tool annotations the Claude
// connector directory requires. Runs against the built bundle (`pnpm test`
// builds first), so it covers what ships.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";

import { createCapyDBHttpHandler } from "../dist/http.js";

const GOOD_TOKEN = "capy_live_good";
const REVOKED_TOKEN = "capy_live_revoked";
const RESOURCE = "https://mcp.example.test/mcp";
const ISSUER = "https://auth.example.test";

let controlPlane;
let apiUrl;
const seen = [];

before(async () => {
  controlPlane = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    const auth = req.headers.authorization;
    const json = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/v1/me") {
      return auth === `Bearer ${GOOD_TOKEN}`
        ? json(200, { principal: { scopes: ["projects:read"] } })
        : json(401, { error: "unauthorized" });
    }
    if (req.url?.startsWith("/v1/ephemeral-databases/")) {
      assert.equal(auth, undefined, "anonymous tools must not send a credential");
      return json(200, { project_id: "prj_1", state: "ready" });
    }
    if (req.url?.startsWith("/v1/projects")) {
      return auth === `Bearer ${GOOD_TOKEN}`
        ? json(200, { projects: [{ id: "prj_1", name: "one" }] })
        : json(401, { error: "unauthorized" });
    }
    json(404, { error: "not found" });
  });
  await new Promise((resolve) => controlPlane.listen(0, "127.0.0.1", resolve));
  apiUrl = `http://127.0.0.1:${controlPlane.address().port}`;
});

after(() => controlPlane.close());

function handler(extra = {}) {
  return createCapyDBHttpHandler({
    apiUrl,
    resourceUrl: RESOURCE,
    authorizationServerUrl: ISSUER,
    provisionTimeoutMs: 60_000,
    ...extra,
  });
}

let nextId = 1;
function rpc(method, params, token, headers = {}) {
  return new Request(RESOURCE, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
}

/** Reads a JSON-RPC response whether it arrived as JSON or as one SSE event. */
async function rpcResult(response) {
  const text = await response.text();
  const payload = text.trimStart().startsWith("{")
    ? text
    : text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("");
  return JSON.parse(payload);
}

test("tools/list works without a token and every tool is annotated", async () => {
  const response = await handler().mcp(rpc("tools/list", {}));
  assert.equal(response.status, 200);
  const { result } = await rpcResult(response);
  const tools = result.tools;
  assert.ok(tools.length > 40);
  for (const tool of tools) {
    assert.ok(tool.title, `${tool.name} has no title`);
    const hints = tool.annotations ?? {};
    assert.ok(
      hints.readOnlyHint === true || typeof hints.destructiveHint === "boolean",
      `${tool.name} declares neither readOnlyHint nor destructiveHint`,
    );
    assert.ok(tool.name.length <= 64);
  }
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  assert.equal(byName.get("query_sql").annotations.readOnlyHint, true);
  assert.equal(byName.get("execute_sql").annotations.destructiveHint, true);
  assert.equal(byName.has("run_sql"), false);
  assert.equal("read_only" in byName.get("query_sql").inputSchema.properties, false);
});

test("an account tool without a token is refused with a 401 challenge", async () => {
  const response = await handler().mcp(rpc("tools/call", { name: "list_projects", arguments: {} }));
  assert.equal(response.status, 401);
  const challenge = response.headers.get("www-authenticate");
  assert.match(
    challenge,
    /resource_metadata="https:\/\/mcp\.example\.test\/\.well-known\/oauth-protected-resource\/mcp"/,
  );
  assert.match(challenge, /scope="projects:read [^"]*organizations:read"/);
  assert.equal(response.headers.get("access-control-expose-headers")?.includes("www-authenticate"), true);
});

test("an anonymous tool runs without a token", async () => {
  const response = await handler().mcp(
    rpc("tools/call", {
      name: "get_ephemeral_database",
      arguments: { project_id: "prj_1", claim_token: "eph_x" },
    }),
  );
  assert.equal(response.status, 200);
  const { result } = await rpcResult(response);
  assert.notEqual(result.isError, true);
});

test("a revoked token is refused before the SDK runs", async () => {
  const response = await handler().mcp(rpc("tools/list", {}, REVOKED_TOKEN));
  assert.equal(response.status, 401);
  assert.match(response.headers.get("www-authenticate"), /error="invalid_token"/);
});

test("a non-tenant bearer is refused without reaching the control plane", async () => {
  const before = seen.length;
  const response = await handler().mcp(rpc("tools/list", {}, "admin-token"));
  assert.equal(response.status, 401);
  assert.equal(seen.length, before);
});

test("a valid token reaches the account tools and forwards the caller's address", async () => {
  const response = await handler({ clientIpSecret: "s3cret" }).mcp(
    rpc("tools/call", { name: "list_projects", arguments: {} }, GOOD_TOKEN, {
      "x-forwarded-for": "203.0.113.7",
    }),
  );
  assert.equal(response.status, 200);
  const { result } = await rpcResult(response);
  assert.notEqual(result.isError, true);
  assert.match(result.content[0].text, /prj_1/);
  const call = seen.findLast((entry) => entry.url === "/v1/projects");
  assert.equal(call.headers["x-capydb-client-ip"], "203.0.113.7");
  assert.equal(call.headers["x-capydb-bridge-secret"], "s3cret");
});

test("protected resource metadata names the resource and the issuer", async () => {
  const response = handler().protectedResourceMetadata(new Request(`${RESOURCE}`));
  const document = await response.json();
  assert.equal(document.resource, RESOURCE);
  assert.deepEqual(document.authorization_servers, [ISSUER]);
  assert.ok(document.scopes_supported.includes("projects:write"));
});

test("CORS preflight is answered", async () => {
  const response = await handler().mcp(new Request(RESOURCE, { method: "OPTIONS" }));
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
});
