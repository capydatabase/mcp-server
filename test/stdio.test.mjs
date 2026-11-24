// Exercises the stdio bin (`dist/index.js`, what `npx @capydb/mcp` runs) as a
// child process against a stub control plane: the tools only the local server
// offers, and that it serves the same annotated list as the hosted one
// otherwise. `pnpm test` builds first, so this covers what ships.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { createCapyDBHttpHandler } from "../dist/http.js";
import { assertDescriptionsAreFacts } from "./description-lint.mjs";

const API_KEY = "capy_live_stdio";
const PREFERENCES = {
  organization_id: "org_1",
  alert_emails_enabled: true,
  alert_email_recipients: ["ops@example.com"],
  billing_email_recipients: ["finance@example.com"],
  updated_at: null,
};

let controlPlane;
let child;
let home;
let instructions;
const seen = [];
const pending = new Map();
let nextId = 1;

/** Sends one JSON-RPC request to the child and resolves with its response. */
function request(method, params) {
  const id = nextId++;
  const answer = new Promise((resolve) => pending.set(id, resolve));
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return answer;
}

before(async () => {
  controlPlane = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const path = new URL(req.url, "http://stub").pathname;
    const body = raw ? JSON.parse(raw) : undefined;
    seen.push({ method: req.method, path, auth: req.headers.authorization, body });
    const routes = {
      "GET /v1/projects": [200, { projects: [{ id: "prj_1", organization_id: "org_1" }] }],
      "GET /v1/organizations/org_1/notification-preferences": [
        200,
        { notification_preferences: PREFERENCES },
      ],
      "PUT /v1/organizations/org_1/notification-preferences": [
        200,
        { notification_preferences: { ...PREFERENCES, ...body, updated_at: "2026-09-30T00:00:00Z" } },
      ],
    };
    const [status, payload] = routes[`${req.method} ${path}`] ?? [404, { error: "not found" }];
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  });
  await new Promise((resolve) => controlPlane.listen(0, "127.0.0.1", resolve));

  // An empty home: the child must never read the developer's saved CLI login.
  home = mkdtempSync(join(tmpdir(), "capydb-mcp-stdio-"));
  child = spawn(process.execPath, [fileURLToPath(new URL("../dist/index.js", import.meta.url))], {
    env: {
      PATH: process.env.PATH,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      AppData: join(home, "AppData"),
      CAPYDB_API_KEY: API_KEY,
      CAPYDB_API_URL: `http://127.0.0.1:${controlPlane.address().port}`,
    },
    stdio: ["pipe", "pipe", "ignore"],
  });
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });

  const initialized = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "stdio-test", version: "0" },
  });
  instructions = initialized.result.instructions;
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
});

after(() => {
  child.kill();
  controlPlane.close();
  rmSync(home, { recursive: true, force: true });
});

test("the stdio server offers the hosted tools plus update_notification_preferences", async () => {
  const { result } = await request("tools/list", {});
  const hosted = createCapyDBHttpHandler({
    apiUrl: "http://127.0.0.1:1",
    resourceUrl: "https://mcp.example.test/mcp",
    authorizationServerUrl: "https://auth.example.test",
    provisionTimeoutMs: 60_000,
  });
  const response = await hosted.mcp(
    new Request("https://mcp.example.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    }),
  );
  const text = await response.text();
  const hostedTools = JSON.parse(
    text.trimStart().startsWith("{")
      ? text
      : text
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join(""),
  ).result.tools;

  const names = (tools) => tools.map((tool) => tool.name).sort();
  // The hosted server's sign-in never grants organizations:write, so the tool
  // that needs it is offered only here, where an admin's key can carry it.
  assert.deepEqual(
    names(result.tools),
    [...names(hostedTools), "update_notification_preferences"].sort(),
  );
  for (const tool of result.tools) {
    assert.equal(tool.annotations.title, tool.title, tool.name);
    assert.equal(typeof tool.annotations.readOnlyHint, "boolean", tool.name);
  }
  const update = result.tools.find((tool) => tool.name === "update_notification_preferences");
  assert.equal(update.annotations.readOnlyHint, false);
  assert.equal(update.annotations.destructiveHint, false);
});

test("update_notification_preferences changes only the fields passed", async () => {
  const { result } = await request("tools/call", {
    name: "update_notification_preferences",
    arguments: { alert_emails_enabled: false },
  });
  assert.notEqual(result.isError, true, result.content[0].text);
  const put = seen.findLast((entry) => entry.method === "PUT");
  assert.equal(put.auth, `Bearer ${API_KEY}`);
  // The endpoint replaces the whole row, so the lists not passed are sent as they were.
  assert.deepEqual(put.body, {
    alert_emails_enabled: false,
    alert_email_recipients: ["ops@example.com"],
    billing_email_recipients: ["finance@example.com"],
  });

  const empty = await request("tools/call", {
    name: "update_notification_preferences",
    arguments: {},
  });
  assert.equal(empty.result.isError, true);
});

test("the stdio descriptions state facts and its instructions cover the device login", async () => {
  const { result } = await request("tools/list", {});
  assertDescriptionsAreFacts(result.tools, instructions);
  assert.match(instructions, /device-login approval URL/);
});
