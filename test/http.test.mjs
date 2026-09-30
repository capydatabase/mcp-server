// Exercises the remote HTTP entry against a stub control plane: the lazy-auth
// gate, token checking, discovery metadata, the tool annotations the Claude
// connector directory requires, output schemas, and whole tool flows
// (create_project, import_database, the backup-schedule and notification-preference merges, the
// major-upgrade steps, preview SQL, lint, typegen, log search). Runs against the built bundle (`pnpm test`
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
  region: "eu-north-1",
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
                region: "eu-north-1",
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

// ---- 2026-09-30 API wave ------------------------------------------------------

test("the new tools are listed with the right hints", async () => {
  const response = await handler().mcp(rpc("tools/list", {}));
  const { result } = await rpcResult(response);
  const byName = new Map(result.tools.map((tool) => [tool.name, tool]));
  for (const name of [
    "list_postgres_versions",
    "get_upgrade_status",
    "get_app_role",
    "lint_schema",
    "search_logs",
    "get_notification_preferences",
    "get_status_history",
  ]) {
    assert.equal(byName.get(name)?.annotations?.readOnlyHint, true, `${name} is not read-only`);
  }
  for (const name of [
    "upgrade_postgres_major",
    "confirm_major_upgrade",
    "rollback_major_upgrade",
    "rotate_app_role",
    "run_preview_sql",
    "sync_integration_env",
  ]) {
    assert.equal(byName.get(name)?.annotations?.destructiveHint, true, `${name} is not destructive`);
  }
  for (const name of [
    "retry_provisioning",
    "enable_app_role",
    "update_notification_preferences",
  ]) {
    assert.equal(byName.get(name)?.annotations?.destructiveHint, false, `${name} has no write hint`);
  }
  // Every upgrade step needs the person's approval token.
  for (const name of ["upgrade_postgres_major", "confirm_major_upgrade", "rollback_major_upgrade"]) {
    assert.ok(byName.get(name).inputSchema.required.includes("approval_token"), name);
  }
  // A read and a write never share a tool: preview SQL has no read-only switch.
  assert.equal("read_only" in byName.get("run_preview_sql").inputSchema.properties, false);
  assert.deepEqual(byName.get("create_project").inputSchema.properties.postgres_version.enum, [
    "16",
    "17",
    "18",
    "19",
  ]);
});

test("list_regions returns ids and display details", async () => {
  route("GET /v1/regions", () => [
    200,
    {
      regions: ["eu-north-1"],
      region_details: [{ id: "eu-north-1", display_name: "EU North", location: "Helsinki, Finland" }],
    },
  ]);
  const result = await callTool("list_regions", {});
  assert.deepEqual(result.structuredContent.regions, ["eu-north-1"]);
  assert.equal(result.structuredContent.region_details[0].display_name, "EU North");
});

test("list_postgres_versions wraps the versions", async () => {
  route("GET /v1/postgres-versions", () => [
    200,
    {
      versions: [
        { version: "16", channel: "previous", default: false, production_ready: true },
        { version: "17", channel: "stable", default: true, production_ready: true },
        { version: "19", channel: "beta", default: false, production_ready: false },
      ],
    },
  ]);
  const result = await callTool("list_postgres_versions", {});
  assert.equal(result.structuredContent.versions.length, 3);
  assert.equal(result.structuredContent.versions[2].production_ready, false);
});

test("create_ephemeral_database forwards the caller's bearer only when there is one", async () => {
  const created = {
    project_id: "prj_e",
    claim_token: "eph_x",
    claim_url: "https://capydb.dev/claim/eph_x",
    ephemeral_database: {
      project_id: "prj_e",
      state: "provisioning",
      created_at: "2026-09-30T00:00:00Z",
      expires_at: "2026-10-03T00:00:00Z",
    },
  };
  route("POST /v1/ephemeral-databases", () => [201, created]);

  const signedIn = await callTool("create_ephemeral_database", { region: "eu-north-1" });
  assert.notEqual(signedIn.isError, true, signedIn.content[0].text);
  let call = seen.findLast((entry) => entry.path === "/v1/ephemeral-databases");
  assert.equal(call.headers.authorization, `Bearer ${GOOD_TOKEN}`);
  assert.deepEqual(call.body, { region: "eu-north-1" });

  const response = await handler().mcp(
    rpc("tools/call", { name: "create_ephemeral_database", arguments: {} }),
  );
  assert.equal(response.status, 200);
  const { result } = await rpcResult(response);
  assert.notEqual(result.isError, true);
  call = seen.findLast((entry) => entry.path === "/v1/ephemeral-databases");
  assert.equal(call.headers.authorization, undefined);

  // A credential the control plane refuses (a stale saved key) must not break
  // an endpoint that works without one: the call is repeated anonymously.
  route("POST /v1/ephemeral-databases", ({ auth }) =>
    auth === undefined ? [201, created] : [401, { error: "invalid api key" }],
  );
  const before = seen.length;
  const stale = await callTool("create_ephemeral_database", {});
  assert.notEqual(stale.isError, true, stale.content[0].text);
  const posts = seen.slice(before).filter((entry) => entry.path === "/v1/ephemeral-databases");
  assert.deepEqual(
    posts.map((entry) => entry.headers.authorization),
    [`Bearer ${GOOD_TOKEN}`, undefined],
  );
});

test("restore reports a clamped point-in-time target", async () => {
  route("POST /v1/projects/prj_1/restores", ({ body }) => {
    assert.equal(body.target_kind, "new_preview");
    assert.equal(body.restore_time, "2030-01-01T00:00:00Z");
    return [
      202,
      {
        job: { ...JOB, id: "job_rs", type: "restore.pitr", project_id: "prj_1" },
        pitr: {
          requested_restore_time: "2030-01-01T00:00:00Z",
          restore_time: "2026-09-30T10:00:00Z",
          restore_time_clamped: true,
        },
      },
    ];
  });
  const result = await callTool("restore", {
    project_id: "prj_1",
    restore_time: "2030-01-01T00:00:00Z",
  });
  assert.notEqual(result.isError, true, result.content[0].text);
  assert.equal(result.structuredContent.job.id, "job_rs");
  assert.equal(result.structuredContent.pitr.restore_time_clamped, true);
});

test("major upgrade steps forward the approval token", async () => {
  route("GET /v1/projects/prj_1/upgrade/major", () => [200, { upgrade: null }]);
  const status = await callTool("get_upgrade_status", { project_id: "prj_1" });
  assert.deepEqual(status.structuredContent, { upgrade: null });

  route("POST /v1/projects/prj_1/upgrade/major", ({ query }) => {
    assert.equal(query.get("target_major"), "18");
    assert.equal(query.get("approval_token"), "apr_up");
    return [202, { job: { ...JOB, id: "job_up", type: "project.upgrade_major" } }];
  });
  const upgrade = await callTool("upgrade_postgres_major", {
    project_id: "prj_1",
    target_major: 18,
    approval_token: "apr_up",
  });
  assert.equal(upgrade.structuredContent.id, "job_up");

  route("POST /v1/projects/prj_1/upgrade/major/rollback", ({ query }) => {
    assert.equal(query.get("approval_token"), "apr_rb");
    assert.equal(query.has("target_major"), false);
    return [202, { job: { ...JOB, id: "job_rb" } }];
  });
  const rollback = await callTool("rollback_major_upgrade", {
    project_id: "prj_1",
    approval_token: "apr_rb",
  });
  assert.equal(rollback.structuredContent.id, "job_rb");

  route("POST /v1/projects/prj_1/upgrade/major/confirm", () => [
    403,
    { error: "self-serve major upgrades are not enabled" },
  ]);
  const confirm = await callTool("confirm_major_upgrade", {
    project_id: "prj_1",
    approval_token: "apr_cf",
  });
  assert.equal(confirm.isError, true);
  assert.match(confirm.content[0].text, /HTTP 403.*not enabled/);
});

test("update_notification_preferences changes only the fields passed", async () => {
  const current = {
    organization_id: "org_1",
    alert_emails_enabled: true,
    alert_email_recipients: ["ops@example.com"],
    billing_email_recipients: ["finance@example.com"],
    updated_at: null,
  };
  route("GET /v1/organizations/org_1/notification-preferences", () => [
    200,
    { notification_preferences: current },
  ]);
  route("PUT /v1/organizations/org_1/notification-preferences", ({ body }) => [
    200,
    { notification_preferences: { ...current, ...body, updated_at: "2026-09-30T00:00:00Z" } },
  ]);
  const result = await callTool("update_notification_preferences", { alert_emails_enabled: false });
  assert.notEqual(result.isError, true, result.content[0].text);
  const put = seen.findLast((entry) => entry.method === "PUT");
  assert.deepEqual(put.body, {
    alert_emails_enabled: false,
    alert_email_recipients: ["ops@example.com"],
    billing_email_recipients: ["finance@example.com"],
  });

  const read = await callTool("get_notification_preferences", {});
  assert.equal(read.structuredContent.updated_at, null);

  const empty = await callTool("update_notification_preferences", {});
  assert.equal(empty.isError, true);
});

test("run_preview_sql targets the preview and tags the statement", async () => {
  route("POST /v1/preview-databases/pvw_1/sql", ({ body }) => [
    200,
    { result: { columns: [], rows: [], row_count: 3, truncated: false, body } },
  ]);
  const result = await callTool("run_preview_sql", {
    preview_id: "pvw_1",
    query: "DELETE FROM orders;",
    allow_unqualified_writes: true,
  });
  assert.notEqual(result.isError, true, result.content[0].text);
  const call = seen.findLast((entry) => entry.path === "/v1/preview-databases/pvw_1/sql");
  assert.deepEqual(call.body, {
    query: "DELETE FROM orders /*source='capydb-mcp'*/",
    allow_unqualified_writes: true,
  });
});

test("lint_schema reads the project or the preview report", async () => {
  const report = {
    lint: {
      findings: [
        {
          rule: "missing_primary_key",
          severity: "warning",
          object: "public.events",
          message: "no primary key",
        },
      ],
      skipped: [],
    },
  };
  route("GET /v1/projects/prj_1/lint", () => [200, report]);
  route("GET /v1/preview-databases/pvw_1/lint", () => [200, { lint: { findings: [], skipped: ["unused_index: too little history"] } }]);
  const project = await callTool("lint_schema", { project_id: "prj_1" });
  assert.equal(project.structuredContent.findings[0].rule, "missing_primary_key");
  const preview = await callTool("lint_schema", { project_id: "prj_1", preview_id: "pvw_1" });
  assert.equal(preview.structuredContent.skipped.length, 1);
});

test("generate_types passes the Go package and the Python style", async () => {
  route("GET /v1/projects/prj_1/schema/types", ({ query }) => [
    200,
    {
      types: {
        filename: query.get("language") === "go" ? "db.go" : "models.py",
        content: "",
        language: query.get("language"),
        style: query.get("style") ?? undefined,
      },
    },
  ]);
  await callTool("generate_types", { project_id: "prj_1", language: "go", package: "store" });
  let call = seen.findLast((entry) => entry.path === "/v1/projects/prj_1/schema/types");
  assert.equal(new URL(call.url, "http://stub").searchParams.get("package"), "store");
  const python = await callTool("generate_types", {
    project_id: "prj_1",
    language: "python",
    style: "pydantic",
  });
  assert.equal(python.structuredContent.style, "pydantic");
  call = seen.findLast((entry) => entry.path === "/v1/projects/prj_1/schema/types");
  assert.equal(new URL(call.url, "http://stub").searchParams.has("package"), false);
});

test("search_logs forwards filters and reports a disabled search as a tool error", async () => {
  route("GET /v1/projects/prj_1/logs/search", ({ query }) => {
    assert.equal(query.get("sqlstate"), "23505");
    assert.equal(query.get("q"), "orders");
    return [
      200,
      {
        search: {
          entries: [
            {
              timestamp: "2026-09-30T00:00:00Z",
              severity: "error",
              message: "duplicate key",
              sqlstate: "23505",
              cursor: "c1",
            },
          ],
          truncated: false,
        },
      },
    ];
  });
  const found = await callTool("search_logs", { project_id: "prj_1", sqlstate: "23505", q: "orders" });
  assert.equal(found.structuredContent.entries[0].sqlstate, "23505");

  route("GET /v1/projects/prj_1/logs/search", () => [503, { error: "log search is not enabled" }]);
  const disabled = await callTool("search_logs", { project_id: "prj_1" });
  assert.equal(disabled.isError, true);
  assert.match(disabled.content[0].text, /HTTP 503/);
});

test("project write tools reach their endpoints", async () => {
  const jobFor = (id) => () => [202, { job: { ...JOB, id } }];
  route("POST /v1/projects/prj_1/retry-provisioning", jobFor("job_retry"));
  route("POST /v1/projects/prj_1/roles/app", jobFor("job_app"));
  route("POST /v1/projects/prj_1/roles/app/rotate", jobFor("job_rot"));
  route("POST /v1/projects/prj_1/integrations/netlify/sync", jobFor("job_sync"));
  route("GET /v1/projects/prj_1/roles/app", () => [
    200,
    { app_role: { available: true, enabled: true, username: "app_user" } },
  ]);

  const cases = [
    ["retry_provisioning", { project_id: "prj_1" }, "job_retry"],
    ["enable_app_role", { project_id: "prj_1" }, "job_app"],
    ["rotate_app_role", { project_id: "prj_1" }, "job_rot"],
    ["sync_integration_env", { project_id: "prj_1", provider: "netlify" }, "job_sync"],
  ];
  for (const [name, args, jobId] of cases) {
    const result = await callTool(name, args);
    assert.notEqual(result.isError, true, `${name}: ${result.content[0].text}`);
    assert.equal(JSON.parse(result.content[0].text).id, jobId, name);
  }
  const role = await callTool("get_app_role", { project_id: "prj_1" });
  assert.equal(role.structuredContent.username, "app_user");
});

test("get_status_history works without an account", async () => {
  route("GET /status/history", ({ auth, query }) => {
    assert.equal(auth, undefined);
    assert.equal(query.get("days"), "7");
    return [
      200,
      {
        days: 7,
        from: "2026-09-24",
        to: "2026-09-30",
        generated_at: "2026-09-30T00:00:00Z",
        regions: [{ region: "eu-north-1", uptime_percent: 100, days: [] }],
        incidents: [],
      },
    ];
  });
  const response = await handler().mcp(
    rpc("tools/call", { name: "get_status_history", arguments: { days: 7 } }),
  );
  assert.equal(response.status, 200);
  const { result } = await rpcResult(response);
  assert.notEqual(result.isError, true, result.content[0].text);
  assert.equal(result.structuredContent.regions[0].region, "eu-north-1");
});

test("get_observability passes the wake summary through", async () => {
  route("GET /v1/projects/prj_1/observability", () => [
    200,
    {
      observability: {
        connection_count: 1,
        connection_limit: 100,
        database_size_bytes: 1,
        storage_limit_bytes: 10,
        wake: { wakes: 4, timed_wakes: 4, window_hours: 168, p50_ms: 140, p95_ms: 300, max_ms: 410 },
      },
    },
  ]);
  const result = await callTool("get_observability", { project_id: "prj_1" });
  assert.equal(result.structuredContent.wake.p95_ms, 300);
});
