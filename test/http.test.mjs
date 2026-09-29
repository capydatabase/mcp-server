// Exercises the remote HTTP entry against a stub control plane: the lazy-auth
// gate, token checking, discovery metadata, the tool annotations the Claude
// connector directory requires, output schemas, and whole tool flows
// (create_project, import_database, the backup-schedule merge). Runs against the built bundle (`pnpm test`
// builds first), so it covers what ships.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, afterEach, before, test } from "node:test";

import { createCapyDBHttpHandler } from "../dist/http.js";

const GOOD_TOKEN = "capy_live_good";
const REVOKED_TOKEN = "capy_live_revoked";
const RESOURCE = "https://mcp.example.test/mcp";
const ISSUER = "https://auth.example.test";

let controlPlane;
let apiUrl;
const seen = [];

/**
 * Per-test control-plane routes, keyed "METHOD /path" (the path without its
 * query). A route returns `[status, body]`; unrouted requests answer 404.
 * `baseRoutes` are the ones every test relies on; a test adds its own with
 * `route()`, and they are cleared after it.
 */
/** A project as the control plane returns it (every field the API marks required). */
const PROJECT = {
  id: "prj_1",
  name: "one",
  slug: "one",
  organization_id: "org_1",
  state: "ready",
  environment: "production",
  always_on: true,
  runtime_status: "active",
  region: "hel1",
  plan: "pro",
  postgres_version: "18",
  storage_limit_bytes: 10737418240,
  max_connections: 100,
  database_name: "one",
  role_name: "one_owner",
  direct_port: 5432,
  pooled_port: 6432,
  idle_transaction_timeout: "5min",
  statement_timeout: "0",
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T00:00:00Z",
  // The control plane may send null for an absent optional value.
  last_error: null,
};

const baseRoutes = {
  "GET /v1/me": ({ auth }) =>
    auth === `Bearer ${GOOD_TOKEN}`
      ? [200, { principal: { scopes: ["projects:read"] } }]
      : [401, { error: "unauthorized" }],
  "GET /v1/projects": ({ auth }) =>
    auth === `Bearer ${GOOD_TOKEN}`
      ? [200, { projects: [PROJECT] }]
      : [401, { error: "unauthorized" }],
};
let testRoutes = {};

function route(key, respond) {
  testRoutes[key] = respond;
}

before(async () => {
  controlPlane = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    const url = new URL(req.url, "http://stub");
    seen.push({ method: req.method, url: req.url, path: url.pathname, headers: req.headers, body });
    const auth = req.headers.authorization;
    if (url.pathname.startsWith("/v1/ephemeral-databases/")) {
      assert.equal(auth, undefined, "anonymous tools must not send a credential");
    }
    const key = `${req.method} ${url.pathname}`;
    const respond =
      testRoutes[key] ??
      baseRoutes[key] ??
      (url.pathname.startsWith("/v1/ephemeral-databases/")
        ? () => [
            200,
            {
              ephemeral_database: {
                project_id: "prj_1",
                name: "eph-1",
                region: "hel1",
                state: "ready",
                created_at: "2026-09-01T00:00:00Z",
                expires_at: "2026-09-04T00:00:00Z",
              },
              connections: { username: "eph", pooled_url: "postgres://eph@x/db" },
            },
          ]
        : () => [404, { error: "not found" }]);
    const [status, payload] = respond({ auth, body, query: url.searchParams });
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  });
  await new Promise((resolve) => controlPlane.listen(0, "127.0.0.1", resolve));
  apiUrl = `http://127.0.0.1:${controlPlane.address().port}`;
});

afterEach(() => {
  testRoutes = {};
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

/** Calls a tool with the good token and returns the JSON-RPC result. */
async function callTool(name, args, options = {}) {
  const response = await handler(options).mcp(
    rpc("tools/call", { name, arguments: args }, GOOD_TOKEN),
  );
  assert.equal(response.status, 200);
  const { result, error } = await rpcResult(response);
  assert.equal(error, undefined, `${name} answered a protocol error: ${JSON.stringify(error)}`);
  return result;
}

const SCHEDULE = {
  id: "sch_1",
  organization_id: "org_1",
  project_id: "prj_1",
  cron_hour: 3,
  cron_minute: 15,
  is_active: true,
  label: "nightly",
  retention_days: 30,
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T00:00:00Z",
};

test("update_backup_schedule changes only the fields passed", async () => {
  route("GET /v1/projects/prj_1/scheduled-backups", () => [200, { scheduled_backups: [SCHEDULE] }]);
  route("PUT /v1/projects/prj_1/scheduled-backups/default", ({ body }) => [
    200,
    { scheduled_backup: { ...SCHEDULE, ...body } },
  ]);
  const result = await callTool("update_backup_schedule", { project_id: "prj_1", cron_hour: 5 });
  assert.notEqual(result.isError, true);
  const put = seen.findLast((entry) => entry.method === "PUT");
  // The endpoint replaces the whole row; an omitted retention would become 14.
  assert.deepEqual(put.body, {
    cron_hour: 5,
    cron_minute: 15,
    is_active: true,
    retention_days: 30,
    label: "nightly",
  });
});

test("update_backup_schedule needs a time when the project has no schedule", async () => {
  route("GET /v1/projects/prj_1/scheduled-backups", () => [200, { scheduled_backups: [] }]);
  const before = seen.length;
  const result = await callTool("update_backup_schedule", { project_id: "prj_1", is_active: false });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /cron_hour and cron_minute/);
  assert.equal(
    seen.slice(before).some((entry) => entry.method === "PUT"),
    false,
  );
});

test("get_backup_schedule returns the schedule list", async () => {
  route("GET /v1/projects/prj_1/scheduled-backups", () => [200, { scheduled_backups: [SCHEDULE] }]);
  const result = await callTool("get_backup_schedule", { project_id: "prj_1" });
  assert.equal(JSON.parse(result.content[0].text).scheduled_backups[0].retention_days, 30);
});

test("list_audit_events derives the organization and forwards the limit", async () => {
  route("GET /v1/organizations/org_1/audit-events", ({ query }) => {
    assert.equal(query.get("limit"), "5");
    return [
      200,
      {
        audit_events: [
          {
            id: "aud_1",
            organization_id: "org_1",
            action: "api_key.created",
            actor_kind: "user",
            actor_id: "user_1",
            created_at: "2026-09-01T00:00:00Z",
            metadata: { name: "ci" },
          },
        ],
      },
    ];
  });
  const result = await callTool("list_audit_events", { limit: 5 });
  assert.notEqual(result.isError, true);
  assert.equal(JSON.parse(result.content[0].text).audit_events[0].action, "api_key.created");
});

test("update_project_settings patches always_on and refuses an empty change", async () => {
  route("PATCH /v1/projects/prj_1", ({ body }) => [
    200,
    { project: { id: "prj_1", name: "one", organization_id: "org_1", always_on: body.always_on } },
  ]);
  const result = await callTool("update_project_settings", { project_id: "prj_1", always_on: true });
  assert.notEqual(result.isError, true);
  assert.deepEqual(seen.findLast((entry) => entry.method === "PATCH").body, { always_on: true });

  const empty = await callTool("update_project_settings", { project_id: "prj_1" });
  assert.equal(empty.isError, true);
});

test("every read tool advertises an open object output schema", async () => {
  const response = await handler().mcp(rpc("tools/list", {}));
  const { result } = await rpcResult(response);
  const forbidsExtraKeys = (node) =>
    node !== null &&
    typeof node === "object" &&
    (node.additionalProperties === false || Object.values(node).some(forbidsExtraKeys));
  for (const tool of result.tools) {
    if (tool.annotations?.readOnlyHint !== true) continue;
    assert.equal(tool.outputSchema?.type, "object", `${tool.name} has no object output schema`);
    // A closed schema would make strict clients reject fields the control
    // plane adds later, which the SDK passes through unchanged.
    assert.equal(forbidsExtraKeys(tool.outputSchema), false, `${tool.name} forbids extra keys`);
  }
});

test("read tools return structured content that matches the text", async () => {
  const listed = await callTool("list_projects", {});
  assert.deepEqual(listed.structuredContent, { projects: [PROJECT] });
  assert.deepEqual(JSON.parse(listed.content[0].text), listed.structuredContent);

  route("GET /v1/projects/prj_1", () => [200, { project: { ...PROJECT, added_later: 1 } }]);
  const project = await callTool("get_project", { project_id: "prj_1" });
  assert.equal(project.structuredContent.always_on, true);
  assert.equal(project.structuredContent.added_later, 1);
});

// ---- create_project and import_database, end to end against the stub ----------

const JOB = {
  id: "job_1",
  type: "instance.create",
  state: "pending",
  organization_id: "org_1",
  project_id: "prj_2",
  attempts: 0,
  max_attempts: 3,
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T00:00:00Z",
};
const NEW_PROJECT = { ...PROJECT, id: "prj_2", name: "shop", slug: "shop" };

test("create_project provisions, polls the job and returns the ready project", async () => {
  route("POST /v1/projects", ({ body }) => {
    assert.deepEqual(body, { name: "shop", environment: "non_production", postgres_version: "18" });
    return [201, { project: { ...NEW_PROJECT, state: "provisioning" }, job: JOB }];
  });
  route("GET /v1/jobs/job_1", () => [200, { job: { ...JOB, state: "completed" } }]);
  route("GET /v1/projects/prj_2", () => [200, { project: NEW_PROJECT }]);

  const result = await callTool("create_project", {
    name: "shop",
    environment: "non_production",
    postgres_version: "18",
  });
  assert.notEqual(result.isError, true, result.content[0].text);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.job.state, "completed");
  assert.equal(payload.project.state, "ready");
  assert.equal(payload.note, undefined);
  assert.ok(seen.some((entry) => entry.method === "GET" && entry.path === "/v1/jobs/job_1"));
});

test("create_project hands the job back when provisioning outlasts the wait", async () => {
  route("POST /v1/projects", () => [
    201,
    { project: { ...NEW_PROJECT, state: "provisioning" }, job: JOB },
  ]);
  route("GET /v1/projects/prj_2", () => [200, { project: { ...NEW_PROJECT, state: "provisioning" } }]);

  // A zero wait skips polling entirely, so the test does not sit out a poll interval.
  const result = await callTool("create_project", { name: "shop" }, { provisionTimeoutMs: 0 });
  assert.notEqual(result.isError, true);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.job.state, "pending");
  assert.match(payload.note, /poll with get_job/);
});

test("create_project without an active plan points at billing", async () => {
  route("POST /v1/projects", () => [
    400,
    { error: "an active CAPYDB subscription is required before provisioning projects" },
  ]);
  const result = await callTool("create_project", { name: "shop" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /No active plan.*dashboard\/settings\/billing/);
});

test("import_database without confirm never reaches the import endpoint", async () => {
  const before = seen.length;
  const result = await callTool("import_database", {
    project_id: "prj_1",
    source_url: "postgres://u:p@source.example/db",
    confirm: false,
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /not confirmed/);
  // The bearer check may run; nothing is sent to the import routes.
  assert.equal(
    seen.slice(before).some((entry) => entry.path.includes("/imports")),
    false,
  );
});

test("import_database forwards the confirmed import and returns its job", async () => {
  route("POST /v1/projects/prj_1/imports/preflight", ({ body }) => {
    assert.deepEqual(body, { source_url: "postgres://u:p@source.example/db" });
    return [
      200,
      {
        preflight: {
          ok: true,
          checks: [{ name: "version", status: "pass" }],
          source: { server_version: "17.4" },
          storage_limit_bytes: 10737418240,
          target_version: "18",
        },
      },
    ];
  });
  route("POST /v1/projects/prj_1/imports", ({ body }) => [
    202,
    { job: { ...JOB, id: "job_imp", type: "project.import", project_id: "prj_1", body } },
  ]);

  const preflight = await callTool("import_preflight", {
    project_id: "prj_1",
    source_url: "postgres://u:p@source.example/db",
  });
  assert.equal(preflight.structuredContent.ok, true);

  const result = await callTool("import_database", {
    project_id: "prj_1",
    source_url: "postgres://u:p@source.example/db",
    recreate: true,
    confirm: true,
  });
  assert.notEqual(result.isError, true, result.content[0].text);
  const call = seen.findLast((entry) => entry.path === "/v1/projects/prj_1/imports");
  assert.equal(call.method, "POST");
  assert.equal(call.headers.authorization, `Bearer ${GOOD_TOKEN}`);
  assert.deepEqual(call.body, {
    source_url: "postgres://u:p@source.example/db",
    recreate: true,
    confirm: true,
  });
  assert.equal(JSON.parse(result.content[0].text).id, "job_imp");
});
