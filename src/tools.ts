/**
 * MCP tool registrations for the CapyDB control plane.
 *
 * Conventions:
 * - Every tool carries its `title` twice, at the top level and as
 *   `annotations.title`, and states its effect in full: `readOnlyHint` is always
 *   an explicit boolean, and a tool that is not read-only also sets
 *   `destructiveHint` - `true` when it deletes or overwrites data (preview
 *   deletion/reset, restores, imports, extension removal, `execute_sql`), `false`
 *   when it only adds. That is what the Claude directory's submission portal
 *   checks on each sync: it takes the listing name from `annotations.title` (the
 *   top-level `title` alone is reported as "Missing title annotation") and asks
 *   every write tool for "title and readOnlyHint" in its annotations. Hosts use
 *   the same hints to decide which calls need the user's confirmation.
 *   `readTool` and `writeTool` below build the pair, so neither can be left out.
 * - A read and a write never share one tool: `query_sql` and
 *   `query_preview_sql` always run READ ONLY, and `execute_sql` and
 *   `execute_preview_sql` are the separate tools that may change data. The
 *   read-only guarantee is the database's: the control plane opens a READ ONLY
 *   transaction for a request that carries `read_only`, and nothing here parses
 *   the statement to decide.
 * - Descriptions state facts: what the tool does, takes and returns, its
 *   limits and its failure answers, in the third person. They give no orders
 *   and name another tool only as a fact (the counterpart, the tool that
 *   returns an id). What to do about those facts - ask first, checkpoint first,
 *   keep secrets out of logs - is said once, in the server `instructions`
 *   (`server.ts`). The directory's submission form has the owner attest to
 *   exactly that, and `test/description-lint.mjs` holds every description to it.
 * - Production overwrite restores are intentionally NOT exposed: the `restore`
 *   tool only targets preview databases.
 * - Steps that need a person's approval (major upgrade, confirm, rollback)
 *   take an `approval_token` parameter. The control plane refuses to mint one
 *   for an API key, so the agent can only carry a token the user minted in the
 *   dashboard - it cannot approve its own destructive action.
 * - K/V flush, rotate-token and delete are intentionally NOT exposed either. A
 *   K/V store has no backup and no restore path, so each of those is one
 *   irreversible step from an agent to unrecoverable customer data; they live in
 *   the dashboard and the CLI, behind a confirmation.
 * - Results are returned as pretty-printed JSON text and, for object results,
 *   as `structuredContent`. Every read tool declares an `outputSchema`
 *   (`output-schemas.ts`), so its result always has an object root.
 */

import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { sleep, type ToolAuth } from "./auth.js";
import { CapyDBApiError, type CapyDBClient } from "./client.js";
import {
  alertsSchema,
  appRoleSchema,
  auditEventsSchema,
  backupsSchema,
  connectionInfoSchema,
  databaseSchemaSchema,
  ephemeralDatabaseSchema,
  exportDownloadSchema,
  exportsSchema,
  extensionsSchema,
  generatedTypesSchema,
  importPreflightSchema,
  indexAdvisorSchema,
  indexHygieneSchema,
  jobSchema,
  jobsSchema,
  kvCredentialsSchema,
  kvStoreSchema,
  kvStoresSchema,
  lintSchema,
  logSearchSchema,
  logErrorsSchema,
  explainSchema,
  logsSchema,
  majorUpgradeStatusSchema,
  notificationPreferencesSchema,
  observabilitySchema,
  postgresVersionsSchema,
  previewDatabasesSchema,
  projectSchema,
  projectsSchema,
  regionsSchema,
  restorePointsSchema,
  scheduledBackupsSchema,
  sqlResultSchema,
  statusHistorySchema,
  tableRowsSchema,
  tablesSchema,
  usageSchema,
} from "./output-schemas.js";
import { formatExplainResult, prepareExplainQuery } from "./explain.js";
import { refuseDoAndCall } from "./sql-scan.js";
import type { Job, Project } from "./types.js";

const PROVISION_POLL_INTERVAL_MS = 3_000;
/**
 * The closing sentence of a tool that takes free-form input (the SQL tools; any
 * tool that ever takes a field named `body`). The Claude directory's portal
 * reads such a tool as a pass-through to an API and asks its description to
 * name that API's public documentation.
 */
const DOCS_REFERENCE = "Documentation: https://docs.capydb.dev/docs/guides/integrations/claude.";
const BILLING_URL = "https://capydb.dev/dashboard/settings/billing";

/**
 * The tools that work without an account. Their handlers use `runAnonymous`, and
 * the HTTP server lets calls to them through without a bearer token; every other
 * tool needs one. Keep this set and the `runAnonymous` call sites in step.
 */
export const ANONYMOUS_TOOLS: ReadonlySet<string> = new Set([
  "create_ephemeral_database",
  "get_ephemeral_database",
  "destroy_ephemeral_database",
  "get_status_history",
]);

export interface RegisterToolsOptions {
  /**
   * How long `create_project` waits for provisioning before handing the job back
   * to poll. The stdio server can wait the full five minutes; an HTTP deployment
   * must stay inside its platform's request duration limit.
   */
  provisionTimeoutMs: number;
  /**
   * Whether the server's credential can hold the `organizations:write` scope.
   * False on the hosted server: its OAuth sign-in never grants that scope
   * (`OAUTH_SCOPES` in `http.ts`), so a tool that needs it could only answer
   * 403 there and is not registered. True over stdio, where an organization
   * admin's key can carry it.
   */
  organizationWrite: boolean;
}

/**
 * A tool result: the value as pretty-printed JSON text, and - when it is an
 * object - the same value as `structuredContent`, which the SDK validates
 * against the tool's `outputSchema`. Tools with an output schema therefore
 * return an object root (lists are wrapped, e.g. `{ projects: [...] }`).
 */
function jsonResult(value: unknown): CallToolResult {
  const text: CallToolResult = {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
  return isPlainObject(value) ? { ...text, structuredContent: value } : text;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorResult(error: unknown): CallToolResult {
  const message =
    error instanceof CapyDBApiError
      ? `CapyDB API error (HTTP ${error.status}): ${error.message}`
      : error instanceof Error
        ? error.message
        : String(error);
  return { isError: true, content: [{ type: "text", text: message }] };
}

/**
 * Gates every tool on authentication before running its handler. When no API
 * key is available, the result text carries the device-login approval URL so
 * the host model relays it to the user.
 */
async function run(auth: ToolAuth, handler: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const authState = await auth.ensure();
    if (!authState.ok) {
      return { isError: true, content: [{ type: "text", text: authState.message }] };
    }
    return jsonResult(await handler());
  } catch (error) {
    return errorResult(error);
  }
}

/**
 * Runs a handler with NO authentication gate. Only the ephemeral-database create,
 * read and destroy and the public status history use it ({@link ANONYMOUS_TOOLS}):
 * their whole point is to work before (or without) an account, so triggering the
 * device login here would defeat them.
 */
async function runAnonymous(handler: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return jsonResult(await handler());
  } catch (error) {
    return errorResult(error);
  }
}

/**
 * The organization a tool acts on: the explicit id, or the organization of the
 * first project the API key can see (a tenant key belongs to one organization).
 */
async function resolveOrganizationId(
  client: CapyDBClient,
  organizationId: string | undefined,
): Promise<string> {
  if (organizationId) {
    return organizationId;
  }
  const [project] = await client.listProjects();
  if (!project) {
    throw new Error(
      "No projects visible to this API key, so the organization cannot be derived - pass organization_id explicitly.",
    );
  }
  return project.organization_id;
}

/** Hints a read tool may add to the ones every read tool carries. */
interface ReadToolHints {
  openWorldHint?: boolean;
}

/** Hints a write tool states: whether it deletes or overwrites, and the optional ones. */
interface WriteToolHints {
  destructiveHint: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/**
 * The title and annotations of a tool that changes nothing. The title is sent
 * twice - top level and `annotations.title` - because the Claude directory
 * reads the second; building both from one argument keeps them identical.
 */
function readTool(title: string, hints: ReadToolHints = {}) {
  return { title, annotations: { title, readOnlyHint: true, ...hints } };
}

/** The title and annotations of a tool that changes something; see {@link readTool}. */
function writeTool(title: string, hints: WriteToolHints) {
  return { title, annotations: { title, readOnlyHint: false, ...hints } };
}

export function registerTools(
  server: McpServer,
  client: CapyDBClient,
  auth: ToolAuth,
  options: RegisterToolsOptions,
): void {
  const provisionMinutes = Math.round(options.provisionTimeoutMs / 60_000);

  // ---- Regions ---------------------------------------------------------------

  server.registerTool(
    "list_regions",
    {
      ...readTool("List regions"),
      description:
        "Lists the regions a CapyDB Postgres project can be placed in. " +
        "regions holds the region ids (for example eu-north-1), which are the values the region parameter of create_project and create_ephemeral_database accepts; region_details holds the same regions in the same order, each with a display name and a location.",
      inputSchema: z.object({}),
      outputSchema: regionsSchema,
    },
    async () => run(auth, () => client.listRegions()),
  );

  server.registerTool(
    "list_postgres_versions",
    {
      ...readTool("List Postgres versions"),
      description:
        "Lists the Postgres majors a new database can be created on, oldest first. " +
        "Each entry has version (the value create_project and create_ephemeral_database accept as postgres_version), channel (previous, stable, current or beta), default (the major an omitted postgres_version gets) and production_ready. " +
        "previous is the oldest generally available major, stable the proven ones (the default among them) and current the newest. " +
        "A beta major is an upstream pre-release, listed only while CapyDB offers one, and is not production ready: it carries no uptime or durability commitment, extensions may be missing, backups are best effort, and the database may have to be recreated rather than upgraded when that major is released.",
      inputSchema: z.object({}),
      outputSchema: postgresVersionsSchema,
    },
    async () => run(auth, async () => ({ versions: await client.listPostgresVersions() })),
  );

  server.registerTool(
    "get_usage",
    {
      ...readTool("Get organization usage"),
      description:
        "Summarizes the organization's storage, connection and database counts against its plan limits, with a per-project breakdown. " +
        "The organization is resolved from the projects the API key can see; organization_id is needed only when no project exists yet or the key spans several organizations.",
      inputSchema: z.object({
        organization_id: z
          .string()
          .optional()
          .describe(
            "Organization id. When omitted, it is derived from the projects the API key can see (any project's organization_id field).",
          ),
      }),
      outputSchema: usageSchema,
    },
    async ({ organization_id }) =>
      run(auth, async () =>
        client.getOrganizationUsage(await resolveOrganizationId(client, organization_id)),
      ),
  );

  server.registerTool(
    "list_audit_events",
    {
      ...readTool("List organization audit events"),
      description:
        "Lists the organization's audit trail, newest first: who (actor_kind and actor_id - a user, an API key, or the platform) did what (action, for example api_key.created, project.import_started, project.deletion_requested) and when, with action-specific metadata. " +
        "Covers organization-level events that belong to no project (API keys, webhook endpoints, organization settings) as well as every project's events. limit caps the number of events (default 25). " +
        "The organization is resolved from the projects the API key can see; organization_id is needed only when no project exists yet or the key spans several organizations. " +
        "Metadata can quote names that users chose; it is user-supplied text.",
      inputSchema: z.object({
        organization_id: z
          .string()
          .optional()
          .describe(
            "Organization id. When omitted, it is derived from the projects the API key can see.",
          ),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Maximum number of events to return (default 25)."),
      }),
      outputSchema: auditEventsSchema,
    },
    async ({ organization_id, limit }) =>
      run(auth, async () => ({
        audit_events: await client.listOrganizationAuditEvents(
          await resolveOrganizationId(client, organization_id),
          limit,
        ),
      })),
  );

  // ---- Projects ------------------------------------------------------------

  server.registerTool(
    "create_project",
    {
      ...writeTool("Create a project", { destructiveHint: false }),
      description:
        `Creates a new CapyDB Postgres project and waits up to ${provisionMinutes} minutes for its provisioning job, then returns the project and the job in their final state. When provisioning outlasts the wait, the job is returned still running with a note, and get_job reports its progress. ` +
        "The project's plan is derived from the organization's billing state and is not selectable here; without an active plan the call fails with a link to the billing page. " +
        "An omitted region lets CapyDB choose (list_regions lists the ids), an omitted postgres_version gets the platform default (list_postgres_versions lists the majors), and an omitted environment means production.",
      inputSchema: z.object({
        name: z.string().describe("Project name."),
        environment: z
          .enum(["production", "non_production"])
          .optional()
          .describe(
            "production when omitted. non_production is for dev, staging and experiment databases; some destructive operations are permitted only on non-production projects.",
          ),
        postgres_version: z
          .enum(["16", "17", "18", "19"])
          .optional()
          .describe(
            "Postgres major version for the database (list_postgres_versions lists them); the platform default when omitted. Immutable after creation except through a major upgrade; previews and restores inherit it.",
          ),
        region: z
          .string()
          .optional()
          .describe(
            "Region id to place the project in, for example eu-north-1 (list_regions lists them). CapyDB picks one when omitted.",
          ),
        slug: z.string().optional().describe("URL-safe slug; derived from the name when omitted."),
      }),
    },
    async ({ name, environment, postgres_version, region, slug }) =>
      run(auth, async () => {
        let created: { project: Project; job: Job };
        try {
          created = await client.createProject({
            name,
            environment,
            postgres_version,
            region,
            slug,
          });
        } catch (error) {
          // The control plane rejects provisioning without an active plan as a
          // 400 whose message comes from ensureOrganizationCanProvision
          // (backend/internal/service/billing.go) - there is no structured
          // error code, so match the stable message text.
          if (
            error instanceof CapyDBApiError &&
            error.status === 400 &&
            (error.message.includes("subscription is required") ||
              error.message.includes("organization billing is"))
          ) {
            throw new Error(
              `No active plan. Ask the user to pick a plan (1 month free) at ${BILLING_URL} - then retry this tool.`,
            );
          }
          throw error;
        }

        let job = created.job;
        const deadline = Date.now() + options.provisionTimeoutMs;
        while (job.state !== "completed" && job.state !== "failed" && Date.now() < deadline) {
          await sleep(PROVISION_POLL_INTERVAL_MS);
          job = await client.getJob(job.id);
        }

        const project = await client.getProject(created.project.id);
        if (job.state !== "completed" && job.state !== "failed") {
          return {
            project,
            job,
            note: `Provisioning is still running after ${provisionMinutes} minutes - poll with get_job until it completes.`,
          };
        }
        return { project, job };
      }),
  );

  server.registerTool(
    "list_projects",
    {
      ...readTool("List projects"),
      description:
        "Lists the CapyDB Postgres projects visible to the API key, each with its state, plan, region and storage limits.",
      inputSchema: z.object({}),
      outputSchema: projectsSchema,
    },
    async () => run(auth, async () => ({ projects: await client.listProjects() })),
  );

  server.registerTool(
    "get_project",
    {
      ...readTool("Get a project"),
      description:
        "Returns one CapyDB project by id: provisioning state, plan and limits, and its settings - environment (production or non_production) and always_on (true: the database stays awake; false: it scales to zero when idle and wakes on the next connection). " +
        "runtime_status reports whether it is active, paused or resuming right now. " +
        "postgres_channel is the release channel of postgres_version; postgres_warning is present only when the database runs a major that is not production ready (a beta) and carries the warning text. " +
        'update_project_settings is the tool that changes the settings, and retry_provisioning applies to a project in state "failed" whose provisioning failed.',
      inputSchema: z.object({
        project_id: z.string().describe("Project id."),
      }),
      outputSchema: projectSchema,
    },
    async ({ project_id }) => run(auth, () => client.getProject(project_id)),
  );

  server.registerTool(
    "get_connection_strings",
    {
      ...readTool("Get project connection strings"),
      description:
        "Returns the project's pooled (PgBouncer) and direct Postgres connection URLs. The URLs embed live database credentials. " +
        "The top-level URLs belong to the owner login; once the split role model is enabled (enable_app_role), app holds the URLs of the app_user login, to which row-level security applies. " +
        "psql and other libpq tools need &sslrootcert=system appended to a URL (libpq 16 or newer), because libpq does not read the operating system's trust store by default; application drivers (node-postgres, postgres.js, pgx, JDBC) work with the URLs unchanged.",
      inputSchema: z.object({
        project_id: z.string().describe("Project id."),
      }),
      outputSchema: connectionInfoSchema,
    },
    async ({ project_id }) => run(auth, () => client.getProjectConnections(project_id)),
  );

  server.registerTool(
    "update_project_settings",
    {
      ...writeTool("Update project settings", { destructiveHint: false, idempotentHint: true }),
      description:
        "Changes a project's environment and sleep policy; get_project returns the current values. " +
        "always_on true keeps the database awake, so the first connection pays no wake-up delay and the database stops scaling to zero; false lets it sleep when idle and wake on the next connection. " +
        "environment non_production unlocks operations that are refused on production (overwriting restores, deletion without an approval). " +
        "Changing environment without always_on also resets always_on to that environment's default (production stays awake, non_production sleeps). A call that passes neither field is refused. " +
        "Requires an organization-wide API key or an organization admin; a project-scoped key is refused with HTTP 403. " +
        "Idempotent: repeating a call with the same values changes nothing.",
      inputSchema: z.object({
        project_id: z.string().describe("Project id."),
        always_on: z
          .boolean()
          .optional()
          .describe(
            "true: the database stays awake. false: it scales to zero when idle. Unchanged when omitted (unless environment changes).",
          ),
        environment: z
          .enum(["production", "non_production"])
          .optional()
          .describe("New environment label. Unchanged when omitted."),
      }),
    },
    async ({ project_id, always_on, environment }) =>
      run(auth, () => {
        if (always_on === undefined && environment === undefined) {
          throw new Error("Nothing to change: pass always_on, environment, or both.");
        }
        return client.updateProject(project_id, { always_on, environment });
      }),
  );

  server.registerTool(
    "retry_provisioning",
    {
      ...writeTool("Retry a failed provisioning", { destructiveHint: false, idempotentHint: true }),
      description:
        'Provisions a project again after its provisioning failed (get_project shows state "failed" and a last_error from the create): the same database, with the same credentials, is created again. ' +
        "Runs asynchronously and returns a job whose state get_job reports. " +
        "Idempotent: while a provisioning job is queued or running, that job is returned instead of a new one. " +
        "Refused with HTTP 409 for a project that is not failed, or whose failure came from a later operation after its database was provisioned; list_jobs shows that failed job. " +
        "Requires an organization-wide API key or an organization admin (HTTP 403 otherwise).",
      inputSchema: z.object({
        project_id: z.string().describe("Project id."),
      }),
    },
    async ({ project_id }) => run(auth, () => client.retryProvisioning(project_id)),
  );

  // ---- Organization notification preferences --------------------------------

  server.registerTool(
    "get_notification_preferences",
    {
      ...readTool("Get notification preferences"),
      description:
        "Returns which notification emails the organization receives and who receives them: alert_emails_enabled (usage, backup and reachability alert emails), alert_email_recipients and billing_email_recipients (extra addresses, in addition to the organization's billing email). " +
        "updated_at is null while the organization is on the defaults (alert emails on, no extra recipients). Billing notices cannot be switched off. " +
        "The organization is resolved from the projects the API key can see; organization_id is needed only when no project exists yet or the key spans several organizations. " +
        "Not available to project-scoped API keys.",
      inputSchema: z.object({
        organization_id: z
          .string()
          .optional()
          .describe(
            "Organization id. When omitted, it is derived from the projects the API key can see.",
          ),
      }),
      outputSchema: notificationPreferencesSchema,
    },
    async ({ organization_id }) =>
      run(auth, async () =>
        client.getNotificationPreferences(await resolveOrganizationId(client, organization_id)),
      ),
  );

  if (options.organizationWrite) {
    server.registerTool(
      "update_notification_preferences",
      {
        ...writeTool("Update notification preferences", {
          destructiveHint: false,
          idempotentHint: true,
        }),
        description:
          "Changes the organization's notification emails. A field that is not passed keeps its current value (get_notification_preferences returns them), and a call that passes no field is refused. " +
          "A recipient list that is passed replaces that list as a whole; each list holds at most 10 addresses and duplicates are removed. " +
          "With alert emails off, nobody is emailed about storage, backup or reachability alerts. Billing notices cannot be switched off. " +
          "Requires an organization admin, or an organization-wide API key minted by one, with the organizations:write scope (HTTP 403 otherwise). " +
          "Offered by the local CapyDB MCP server only: the hosted connector's sign-in does not grant that scope, and the dashboard's notification settings cover it there.",
        inputSchema: z.object({
          organization_id: z
            .string()
            .optional()
            .describe(
              "Organization id. When omitted, it is derived from the projects the API key can see.",
            ),
          alert_emails_enabled: z
            .boolean()
            .optional()
            .describe("false stops usage, backup and reachability alert emails."),
          alert_email_recipients: z
            .array(z.string())
            .max(10)
            .optional()
            .describe("Full list of extra alert email recipients (replaces the current list)."),
          billing_email_recipients: z
            .array(z.string())
            .max(10)
            .optional()
            .describe("Full list of extra billing notice recipients (replaces the current list)."),
        }),
      },
      async ({
        organization_id,
        alert_emails_enabled,
        alert_email_recipients,
        billing_email_recipients,
      }) =>
        run(auth, async () => {
          if (
            alert_emails_enabled === undefined &&
            alert_email_recipients === undefined &&
            billing_email_recipients === undefined
          ) {
            throw new Error(
              "Nothing to change: pass alert_emails_enabled, alert_email_recipients or billing_email_recipients.",
            );
          }
          // The endpoint replaces the whole row with every field required, so
          // merge the caller's fields onto the current preferences.
          const organizationId = await resolveOrganizationId(client, organization_id);
          const current = await client.getNotificationPreferences(organizationId);
          return client.putNotificationPreferences(organizationId, {
            alert_emails_enabled: alert_emails_enabled ?? current.alert_emails_enabled,
            alert_email_recipients: alert_email_recipients ?? current.alert_email_recipients,
            billing_email_recipients: billing_email_recipients ?? current.billing_email_recipients,
          });
        }),
    );
  }

  // ---- K/V stores ----------------------------------------------------------

  server.registerTool(
    "list_kv_stores",
    {
      ...readTool("List K/V stores"),
      description:
        "Lists every K/V store in the organization (CapyDB Knight/Valkyrie, the key-value and rate-limiting service). " +
        "A store belongs to a project and a project has at most one, so the list shows which projects have a store. " +
        "The organization is resolved from the projects the API key can see; organization_id is needed only when the key spans several organizations.",
      inputSchema: z.object({
        organization_id: z
          .string()
          .optional()
          .describe(
            "Organization id. When omitted, it is derived from the projects the API key can see.",
          ),
      }),
      outputSchema: kvStoresSchema,
    },
    async ({ organization_id }) =>
      run(auth, async () => ({
        kv_stores: await client.listKVStores(await resolveOrganizationId(client, organization_id)),
      })),
  );

  server.registerTool(
    "get_kv_store",
    {
      ...readTool("Get a project's K/V store"),
      description:
        "Returns the project's K/V store: state, capacity, eviction policy and persistence. " +
        "HTTP 404 is the normal answer for a project that has no store yet, not a failure. " +
        "maxmemory_mb is the storable capacity; mem_max_mb is the cell's memory ceiling, which is larger so that a snapshot fork has headroom, and is not usable capacity. " +
        'State "stopped" is not idle sleep: the platform stopped the store and stopped_reason says why. org_suspended means the organization is offline for a billing suspension; the store\'s data is kept and it starts again on its own once the suspension lifts, so a retry does not start it.',
      inputSchema: z.object({
        project_id: z.string().describe("Project id."),
      }),
      outputSchema: kvStoreSchema,
    },
    async ({ project_id }) => run(auth, () => client.getKVStore(project_id)),
  );

  server.registerTool(
    "get_kv_credentials",
    {
      ...readTool("Get K/V connection details"),
      description:
        "Returns the project's K/V endpoints: the Upstash-compatible REST URL and the RESP URL. " +
        "The token is not returned and cannot be: the control plane stores only its SHA-256 hash, which is why token_required is true and the RESP URL carries no password. " +
        "A lost token can only be replaced, by rotating it in the dashboard or with `capydb kv rotate-token`; this server does not expose rotation. " +
        "The REST URL is the value of CAPYKV_REST_URL, and @upstash/redis and @upstash/ratelimit work unmodified against it. " +
        "The RESP URL is published as CAPYKV_REDIS_URL. Its endpoint routes by TLS server name (SNI): ioredis needs `tls: { servername }` and redis-cli needs `--sni`, and a connection without it is refused.",
      inputSchema: z.object({
        project_id: z.string().describe("Project id."),
      }),
      outputSchema: kvCredentialsSchema,
    },
    async ({ project_id }) => run(auth, () => client.getKVCredentials(project_id)),
  );

  server.registerTool(
    "create_kv_store",
    {
      ...writeTool("Create a K/V store", { destructiveHint: false, idempotentHint: false }),
      description:
        "Provisions the project's K/V store for key-value work and rate limiting, sized from the organization's plan. " +
        "Runs asynchronously and returns a job whose state get_job reports. " +
        "A project has at most one store; creating a second answers a conflict. " +
        "The response carries the store's plaintext token exactly once: only its hash is stored, so it cannot be shown again. " +
        "A store keeps only a periodic snapshot - no backups and no point-in-time recovery - and evicts keys that have a TTL once it is full, so data that cannot be rebuilt from elsewhere is not safe in it.",
      inputSchema: z.object({
        project_id: z.string().describe("Project id."),
      }),
    },
    async ({ project_id }) => run(auth, () => client.createKVStore(project_id)),
  );

  // ---- Ephemeral databases --------------------------------------------------

  server.registerTool(
    "create_ephemeral_database",
    {
      ...writeTool("Create an ephemeral database (no account needed)", {
        destructiveHint: false,
        idempotentHint: false,
      }),
      description:
        "Creates a throwaway Postgres database without an account, a login or an API key. " +
        "It is a real database, destroyed with its data 72 hours after creation unless claim_ephemeral_database attaches it to an organization; destroy_ephemeral_database ends it earlier and frees its slot. " +
        'Provisioning is asynchronous and usually takes seconds: get_ephemeral_database, given the returned project_id and claim_token, reports the state and, once it is "ready", the connection strings. ' +
        "claim_token, and claim_url which embeds it, is the database's only credential and is returned exactly once; only its hash is stored, so it cannot be recovered. " +
        "When the caller is signed in, the call carries their credential, and the rate limit and the bound on unclaimed ephemeral databases count against their organization instead of their network address; the database still belongs to no one until it is claimed. " +
        "HTTP 429 means this caller created too many recently or already holds as many unclaimed ephemeral databases as allowed; for an anonymous caller that bound is per network address, which other users may share. " +
        "The number of unclaimed ephemeral databases is also capped platform-wide, and HTTP 503 means every slot is in use. " +
        "An omitted region lets CapyDB choose one with capacity, and an omitted postgres_version gets the platform default.",
      inputSchema: z.object({
        name: z.string().max(64).optional().describe("Display name. Defaults to a generated name."),
        region: z
          .string()
          .optional()
          .describe(
            "Region id from list_regions, for example eu-north-1. CapyDB picks one with capacity when omitted.",
          ),
        postgres_version: z
          .enum(["16", "17", "18", "19"])
          .optional()
          .describe(
            "Postgres major version (list_postgres_versions lists them); the platform default when omitted.",
          ),
      }),
    },
    async ({ name, region, postgres_version }) =>
      runAnonymous(() => client.createEphemeralDatabase({ name, region, postgres_version })),
  );

  server.registerTool(
    "get_ephemeral_database",
    {
      ...readTool("Get an ephemeral database"),
      description:
        'Reads an unclaimed ephemeral database by its claim token, without an account: its state, when it expires and, once state is "ready", its connection strings, which embed the database password. ' +
        'State "failed" means provisioning failed and this database will not become ready. ' +
        "A not-found answer means the database expired, was destroyed or has been claimed. The claim token stops working at that moment by design, and a claimed database is an ordinary project whose connection strings get_connection_strings returns. " +
        "An unclaimed database lives until expires_at unless destroy_ephemeral_database ends it earlier.",
      inputSchema: z.object({
        project_id: z.string().describe("project_id returned by create_ephemeral_database."),
        claim_token: z.string().describe("claim_token returned by create_ephemeral_database."),
      }),
      outputSchema: ephemeralDatabaseSchema,
    },
    async ({ project_id, claim_token }) =>
      runAnonymous(() => client.getEphemeralDatabase(project_id, claim_token)),
  );

  server.registerTool(
    "destroy_ephemeral_database",
    {
      ...writeTool("Destroy an ephemeral database (no account needed)", {
        destructiveHint: true,
        idempotentHint: true,
      }),
      description:
        "Destroys an unclaimed ephemeral database now, instead of at its 72-hour expiry, using its claim token and no account. " +
        "The database and all its data are deleted within seconds, and its slot on the platform-wide cap of unclaimed ephemeral databases is freed. This is irreversible: there is no backup and no restore. " +
        "Idempotent: repeating the call while the database is being destroyed succeeds again. " +
        "A not-found answer means the database is already gone or has been claimed; after claim_ephemeral_database it is an ordinary project that the claim token no longer controls.",
      inputSchema: z.object({
        project_id: z.string().describe("project_id returned by create_ephemeral_database."),
        claim_token: z.string().describe("claim_token returned by create_ephemeral_database."),
      }),
    },
    async ({ project_id, claim_token }) =>
      runAnonymous(async () => {
        await client.destroyEphemeralDatabase(project_id, claim_token);
        return { destroyed: project_id };
      }),
  );

  server.registerTool(
    "claim_ephemeral_database",
    {
      ...writeTool("Claim an ephemeral database", { destructiveHint: false, idempotentHint: true }),
      description:
        "Keeps an ephemeral database by attaching it to the signed-in user's organization, where it becomes an ordinary project on their plan: it stops expiring, gains the default nightly backup schedule and counts against the plan's project limit. " +
        "The data and the connection strings stay the same, so an app that uses the database keeps working untouched. " +
        "Requires a signed-in CapyDB account with an active subscription. " +
        "Idempotent for the organization that made the claim; a conflict means the database was claimed by someone else, has expired, or is still being created.",
      inputSchema: z.object({
        project_id: z.string().describe("project_id returned by create_ephemeral_database."),
        claim_token: z.string().describe("claim_token returned by create_ephemeral_database."),
      }),
    },
    async ({ project_id, claim_token }) =>
      run(auth, () => client.claimEphemeralDatabase(project_id, claim_token)),
  );

  // ---- Preview databases ---------------------------------------------------

  server.registerTool(
    "create_preview_database",
    {
      ...writeTool("Create a preview database", { destructiveHint: false }),
      description:
        "Creates a disposable preview (branch) database for a project. " +
        'Mode "empty" creates a blank database and "clone" copies the production data. ' +
        "Runs asynchronously and returns a job whose state get_job reports. " +
        "A preview expires after its TTL (ttl_hours, 1-168, default 24).",
      inputSchema: z.object({
        project_id: z.string().describe("Project id."),
        name: z.string().optional().describe("Preview name (e.g. a branch or PR slug)."),
        mode: z
          .enum(["empty", "clone"])
          .optional()
          .describe('Data source: "empty" (blank) or "clone" (copy of production).'),
        ttl_hours: z
          .number()
          .int()
          .min(1)
          .max(168)
          .optional()
          .describe("Time to live in hours before the preview expires (1-168, default 24)."),
      }),
    },
    async ({ project_id, name, mode, ttl_hours }) =>
      run(auth, () => client.createPreviewDatabase(project_id, { name, mode, ttl_hours })),
  );

  server.registerTool(
    "list_preview_databases",
    {
      ...readTool("List preview databases"),
      description:
        "Lists a project's preview databases, each with its state, source and TTL expiry.",
      inputSchema: z.object({
        project_id: z.string().describe("Project id."),
      }),
      outputSchema: previewDatabasesSchema,
    },
    async ({ project_id }) =>
      run(auth, async () => ({
        preview_databases: await client.listPreviewDatabases(project_id),
      })),
  );

  server.registerTool(
    "delete_preview_database",
    {
      ...writeTool("Delete a preview database", { destructiveHint: true, idempotentHint: true }),
      description:
        "Deletes a preview database and its role permanently; its data cannot be recovered. " +
        "Runs asynchronously and returns a job whose state get_job reports.",
      inputSchema: z.object({
        preview_id: z.string().describe("Preview database id."),
      }),
    },
    async ({ preview_id }) => run(auth, () => client.deletePreviewDatabase(preview_id)),
  );

  server.registerTool(
    "reset_preview_database",
    {
      ...writeTool("Reset a preview database", { destructiveHint: true }),
      description:
        'Resets a preview database to its source state: a "clone" preview is cloned again from the current production data, and an "empty" preview is wiped clean. ' +
        "The preview keeps its name and connection route, and its current data is lost. " +
        "Runs asynchronously and returns a job whose state get_job reports.",
      inputSchema: z.object({
        preview_id: z.string().describe("Preview database id."),
      }),
    },
    async ({ preview_id }) => run(auth, () => client.resetPreviewDatabase(preview_id)),
  );

  server.registerTool(
    "extend_preview_ttl",
    {
      ...writeTool("Extend a preview database's TTL", {
        destructiveHint: false,
        idempotentHint: true,
      }),
      description:
        "Sets a preview database's expiry to ttl_hours from now. " +
        "The value is an absolute new TTL, not an amount added to the remaining time: ttl_hours 24 makes the preview expire 24 hours after the call even if it had 3 days left. " +
        "Works only on a preview that is ready and not already expired. Returns the updated preview with its new ttl_expires_at.",
      inputSchema: z.object({
        preview_id: z.string().describe("Preview database id."),
        ttl_hours: z
          .number()
          .int()
          .min(1)
          .max(168)
          .describe("New TTL in hours, measured from now (1-168)."),
      }),
    },
    async ({ preview_id, ttl_hours }) =>
      run(auth, () => client.extendPreviewDatabase(preview_id, ttl_hours)),
  );

  server.registerTool(
    "get_preview_connection_strings",
    {
      ...readTool("Get preview database connection strings"),
      description:
        "Returns a preview database's pooled and direct Postgres connection URLs. The URLs embed live database credentials. " +
        "psql and other libpq tools need &sslrootcert=system appended to a URL (libpq 16 or newer), because libpq does not read the operating system's trust store by default; application drivers (node-postgres, postgres.js, pgx, JDBC) work with the URLs unchanged.",
      inputSchema: z.object({
        preview_id: z.string().describe("Preview database id."),
      }),
      outputSchema: connectionInfoSchema,
    },
    async ({ preview_id }) => run(auth, () => client.getPreviewConnections(preview_id)),
  );

  const previewSqlInput = {
    preview_id: z.string().describe("Preview database id."),
    query: z.string().describe("SQL statement to execute."),
    max_rows: z
      .number()
      .int()
      .positive()
      .max(1000)
      .optional()
      .describe("Row cap for the result (default 200, max 1000)."),
  };
  const previewSqlLimits =
    "Works only on a preview in state ready. Results are capped (default 200 rows, max 1000) and a statement times out after 15 seconds. " +
    "Executions are not recorded in the project's SQL history, which is the project database's. " +
    "Result rows are the user's own data. " +
    DOCS_REFERENCE;

  server.registerTool(
    "query_preview_sql",
    {
      ...readTool("Query SQL on a preview database (read-only)"),
      description:
        "Runs a SQL statement that does not change anything (SELECT, EXPLAIN, catalog inspection) against a preview database, not the project's database. " +
        "Every call runs inside a READ ONLY transaction, so the database itself refuses every write (DML, DDL, TRUNCATE, SELECT INTO, sequence advancement) with an ordinary error; execute_preview_sql is the counterpart that changes a preview. " +
        previewSqlLimits,
      inputSchema: z.object(previewSqlInput),
      outputSchema: sqlResultSchema,
    },
    async ({ preview_id, query, max_rows }) =>
      run(auth, () => client.runPreviewSql(preview_id, { query, max_rows, read_only: true })),
  );

  server.registerTool(
    "execute_preview_sql",
    {
      ...writeTool("Execute SQL on a preview database (may change data)", {
        destructiveHint: true,
      }),
      description:
        "Runs a SQL statement that changes data or schema (INSERT, UPDATE, DELETE, DDL) against a preview database, not the project's database - the place to rehearse a migration or a destructive statement on a clone before it runs on the project with execute_sql. query_preview_sql is the read-only counterpart. " +
        "The project runner's guard applies: an UPDATE or DELETE with no WHERE clause, and any TRUNCATE, is refused unless allow_unqualified_writes is true, which exists for rehearsing exactly such a statement on a preview. " +
        previewSqlLimits,
      inputSchema: z.object({
        ...previewSqlInput,
        allow_unqualified_writes: z
          .boolean()
          .optional()
          .describe(
            "Permits an UPDATE or DELETE without WHERE, or a TRUNCATE, for rehearsing that statement on this preview.",
          ),
      }),
    },
    async ({ preview_id, query, max_rows, allow_unqualified_writes }) =>
      run(auth, () =>
        client.runPreviewSql(preview_id, { query, max_rows, allow_unqualified_writes }),
      ),
  );

  // ---- Backups, restores, imports -------------------------------------------

  server.registerTool(
    "create_backup",
    {
      ...writeTool("Create a backup", { destructiveHint: false }),
      description:
        "Enqueues an on-demand backup of the project database, with an optional label. " +
        "Runs asynchronously and returns a job whose state get_job reports. " +
        "list_backups shows the backup and its key once it has completed.",
      inputSchema: z.object({
        project_id: z.string().describe("Project id."),
        label: z.string().optional().describe("Optional human-readable label for the backup."),
      }),
    },
    async ({ project_id, label }) => run(auth, () => client.createBackup(project_id, label)),
  );

  server.registerTool(
    "list_backups",
    {
      ...readTool("List backups"),
      description:
        "Lists a project's backups, including their verification state. " +
        'State "expired" means the backup\'s data is no longer in storage: the row is kept as a record and it cannot be restored, which leaves the completed backups as the restorable ones.',
      inputSchema: z.object({
        project_id: z.string().describe("Project id."),
      }),
      outputSchema: backupsSchema,
    },
    async ({ project_id }) =>
      run(auth, async () => ({ backups: await client.listBackups(project_id) })),
  );

  server.registerTool(
    "get_backup_schedule",
    {
      ...readTool("Get the backup schedule"),
      description:
        "Returns the project's scheduled (nightly) backup: the UTC time it runs (cron_hour, cron_minute), whether it is active, how many days its backups are kept (retention_days) and when it last ran. " +
        "An empty list means the project has no schedule. update_backup_schedule is the tool that changes it.",
      inputSchema: z.object({
        project_id: z.string().describe("Project id."),
      }),
      outputSchema: scheduledBackupsSchema,
    },
    async ({ project_id }) =>
      run(auth, async () => ({
        scheduled_backups: await client.listScheduledBackups(project_id),
      })),
  );

  server.registerTool(
    "update_backup_schedule",
    {
      ...writeTool("Update the backup schedule", { destructiveHint: true, idempotentHint: true }),
      description:
        "Changes the project's scheduled backup: when it runs (UTC), whether it is active, and how long its backups are kept. " +
        "A field that is not passed keeps its current value (get_backup_schedule returns them). " +
        "For a project with no schedule yet, cron_hour and cron_minute are required, and the schedule is created active with 14-day retention unless other values are passed. " +
        "Deactivating the schedule stops automatic backups, and a shorter retention_days lets older backups expire sooner; both reduce what can be restored.",
      inputSchema: z.object({
        project_id: z.string().describe("Project id."),
        cron_hour: z
          .number()
          .int()
          .min(0)
          .max(23)
          .optional()
          .describe("UTC hour to run at (0-23)."),
        cron_minute: z
          .number()
          .int()
          .min(0)
          .max(59)
          .optional()
          .describe("UTC minute to run at (0-59)."),
        is_active: z.boolean().optional().describe("false pauses scheduled backups."),
        retention_days: z
          .number()
          .int()
          .min(1)
          .max(365)
          .optional()
          .describe("Days to keep each scheduled backup (1-365)."),
        label: z.string().optional().describe("Label stamped on the scheduled backups."),
      }),
    },
    async ({ project_id, cron_hour, cron_minute, is_active, retention_days, label }) =>
      run(auth, async () => {
        // The endpoint replaces the whole schedule (an omitted retention_days
        // becomes 14), so merge the caller's fields onto the current one: a
        // call that only moves the time must not shorten the retention.
        const [current] = await client.listScheduledBackups(project_id);
        const hour = cron_hour ?? current?.cron_hour;
        const minute = cron_minute ?? current?.cron_minute;
        if (hour === undefined || minute === undefined) {
          throw new Error(
            "The project has no backup schedule yet: pass cron_hour and cron_minute to create one.",
          );
        }
        return client.upsertScheduledBackup(project_id, {
          cron_hour: hour,
          cron_minute: minute,
          is_active: is_active ?? current?.is_active ?? true,
          retention_days: retention_days ?? current?.retention_days,
          label: label ?? current?.label,
        });
      }),
  );

  server.registerTool(
    "export_database",
    {
      ...writeTool("Export the database", { destructiveHint: false }),
      description:
        "Enqueues a logical export (a pg_dump custom-format archive) of the project database. " +
        "Runs asynchronously and returns export_id and a job whose state get_job reports; get_export_download returns a download URL for the completed export. " +
        "Exports expire after 7 days.",
      inputSchema: z.object({
        project_id: z.string().describe("Project id."),
      }),
    },
    async ({ project_id }) => run(auth, () => client.createExport(project_id)),
  );

  server.registerTool(
    "list_exports",
    {
      ...readTool("List exports"),
      description:
        "Lists a project's exports, newest first. A download exists only for a completed export.",
      inputSchema: z.object({
        project_id: z.string().describe("Project id."),
      }),
      outputSchema: exportsSchema,
    },
    async ({ project_id }) =>
      run(auth, async () => ({ exports: await client.listExports(project_id) })),
  );

  server.registerTool(
    "get_export_download",
    {
      ...readTool("Get an export download URL"),
      description:
        "Presigns a download URL for a completed export, valid for 15 minutes. Each call returns a fresh URL.",
      inputSchema: z.object({
        project_id: z.string().describe("Project id."),
        export_id: z.string().describe("Export id from export_database or list_exports."),
      }),
      outputSchema: exportDownloadSchema,
    },
    async ({ project_id, export_id }) =>
      run(auth, () => client.getExportDownload(project_id, export_id)),
  );

  server.registerTool(
    "list_extensions",
    {
      ...readTool("List extensions"),
      description:
        "Lists the Postgres extensions available on the project's database and whether each is enabled. " +
        "installed_version is what the database has and available_version what the platform now provides; update_available marks the extensions a newer build exists for. " +
        "Extensions that CapyDB manages for its own observability report no update_available, because they are kept current automatically. " +
        "Each entry carries a category (core, ai, search, performance, security, analytics, geospatial, scheduling, devtools) and requires_restart, which is true for an extension that loads a shared library and therefore restarts the database when it is enabled or disabled.",
      inputSchema: z.object({
        project_id: z.string().describe("Project id."),
      }),
      outputSchema: extensionsSchema,
    },
    async ({ project_id }) =>
      run(auth, async () => ({ extensions: await client.listProjectExtensions(project_id) })),
  );

  server.registerTool(
    "suggest_indexes",
    {
      ...readTool("Suggest indexes"),
      description:
        "Suggests indexes for the project's database from the predicates its queries actually ran. " +
        "Read-only: each candidate is measured by building it as a hypothetical index, which exists only in the planner's memory for one connection, so no index is created and nothing is written. " +
        "Each suggestion carries both sides of the trade: estimated_size_bytes is what the index would cost to store, and estimated_cost_reduction_pct is how much cheaper the planner expects the statement it was derived from to become, measured by planning that statement with and without the index. " +
        "The order returned is not a ranking by reduction. An absent reduction means it could not be measured, which is different from zero; zero means it was measured and the index would not help. " +
        "available is false when the required extensions are missing, and missing_extensions names them: pg_qualstats collects the evidence and hypopg measures the candidates. Enabling pg_qualstats restarts the database. " +
        "Suggestions appear only after the database has served enough traffic for a predicate to cross the thresholds, so an empty list on a quiet database is expected; a lower min_filter widens the search. " +
        "Nothing is created by this tool. Building a suggested index with plain CREATE INDEX blocks writes to the table while it builds; CREATE INDEX CONCURRENTLY does not.",
      inputSchema: z.object({
        project_id: z.string().describe("Project id."),
        min_filter: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Minimum average rows a predicate has to filter to be considered (default 1000). A lower value finds candidates on a quiet database.",
          ),
        min_selectivity: z
          .number()
          .int()
          .positive()
          .max(100)
          .optional()
          .describe(
            "Minimum average selectivity percentage for a predicate to be considered (default 30).",
          ),
      }),
      outputSchema: indexAdvisorSchema,
    },
    async ({ project_id, min_filter, min_selectivity }) =>
      run(auth, () =>
        client.getIndexAdvisor(project_id, {
          minFilter: min_filter,
          minSelectivity: min_selectivity,
        }),
      ),
  );

  server.registerTool(
    "get_index_hygiene",
    {
      ...readTool("Find unused and redundant indexes"),
      description:
        "Lists indexes the project's database pays for without using: those with no recorded scans, and those whose columns are a leading subset of another index on the same table. " +
        "It is the counterpart to suggest_indexes, which only proposes new indexes. Read-only, and it needs no extensions, so it works on any project. " +
        "UNIQUE, primary-key, exclusion and replica-identity indexes are not listed, because they are correctness constraints rather than access paths. " +
        "available is false until a week of query statistics has accumulated: Postgres does not record when an index was created, so over a shorter window an index used by a weekly job cannot be told apart from a dead one. " +
        "Nothing is dropped by this tool. Each entry carries a drop_statement that uses DROP INDEX CONCURRENTLY; the plain form locks the table against writes for the whole drop.",
      inputSchema: z.object({
        project_id: z.string().describe("Project id."),
      }),
      outputSchema: indexHygieneSchema,
    },
    async ({ project_id }) => run(auth, () => client.getIndexHygiene(project_id)),
  );

  server.registerTool(
    "enable_extension",
    {
      ...writeTool("Enable an extension", { destructiveHint: false }),
      description:
        "Enables a Postgres extension on the project's database (CREATE EXTENSION IF NOT EXISTS). The extension has to be one that list_extensions lists and that is not enabled yet. " +
        "Enabling an extension that loads a shared library (requires_restart true in list_extensions: pg_cron, pgaudit, pg_qualstats) restarts the database, which interrupts open connections for a few seconds. " +
        "Runs asynchronously and returns a job whose state get_job reports.",
      inputSchema: z.object({
        project_id: z.string().describe("Project id."),
        name: z.string().describe("Extension name from list_extensions, e.g. postgis."),
      }),
    },
    async ({ project_id, name }) =>
      run(auth, () => client.enableProjectExtension(project_id, name)),
  );

  server.registerTool(
    "disable_extension",
    {
      ...writeTool("Disable an extension", { destructiveHint: true }),
      description:
        "Disables a Postgres extension on the project's database (DROP EXTENSION, without CASCADE). " +
        "The extension's own objects (types, functions, operators) are removed; when anything else still depends on them, the job fails with the dependency error instead of dropping the dependents. " +
        "Disabling an extension that loads a shared library (requires_restart true in list_extensions) restarts the database, which interrupts open connections for a few seconds. " +
        "Runs asynchronously and returns a job whose state get_job reports.",
      inputSchema: z.object({
        project_id: z.string().describe("Project id."),
        name: z.string().describe("Extension name, e.g. postgis."),
      }),
    },
    async ({ project_id, name }) =>
      run(auth, () => client.disableProjectExtension(project_id, name)),
  );

  server.registerTool(
    "update_extension",
    {
      ...writeTool("Update an extension", { destructiveHint: false }),
      description:
        "Updates an enabled extension to the version the platform provides (ALTER EXTENSION ... UPDATE); list_extensions marks the extensions that have one with update_available. " +
        "The update changes behaviour inside the database's own data: a PostGIS upgrade, for example, can require reindexing afterwards. " +
        "Updating an extension that is already current is a no-op, so a repeated call is harmless. " +
        "Runs asynchronously and returns a job whose state get_job reports.",
      inputSchema: z.object({
        project_id: z.string().describe("Project id."),
        name: z.string().describe("Extension name, e.g. vector."),
      }),
    },
    async ({ project_id, name }) =>
      run(auth, () => client.updateProjectExtension(project_id, name)),
  );

  server.registerTool(
    "major_upgrade_preflight",
    {
      ...readTool("Check a PostgreSQL major upgrade"),
      description:
        "Checks whether the project's database can move to a given PostgreSQL major, without changing anything. " +
        "Returns a job, whose state get_job reports and whose result gives status (upgradable or blocked) with the specific blockers and warnings - most often an extension with no build for the target major, which would leave the schema referencing types and functions that no longer exist. " +
        "Repeating it is harmless. upgrade_postgres_major requires a preflight for the same target that passed within the last hour.",
      inputSchema: z.object({
        project_id: z.string().describe("Project id."),
        target_major: z.number().int().describe("PostgreSQL major to evaluate, e.g. 18."),
      }),
      outputSchema: jobSchema,
    },
    async ({ project_id, target_major }) =>
      run(auth, () => client.majorUpgradePreflight(project_id, target_major)),
  );

  const upgradeAccess =
    "Needs an organization admin, or an organization-wide API key with manager rights (a key that an ordinary member approved is refused with HTTP 403). " +
    "It also takes a single-use approval token for this exact step. Only a person can mint one, as an organization admin in the CapyDB dashboard: the control plane refuses to mint one for an API key, and a token expires 10 minutes after it is minted. " +
    "A repeated call with a token that was already used returns the job that token started instead of repeating the step.";
  const approvalTokenInput = (action: string) =>
    z
      .string()
      .describe(
        `Single-use approval token for ${action}, minted by the user in the CapyDB dashboard.`,
      );

  server.registerTool(
    "get_upgrade_status",
    {
      ...readTool("Get the major upgrade status"),
      description:
        "Reports the PostgreSQL major upgrade in flight on a project, if any: from_major and to_major, state (staging: the data is being copied and verified; rollback_available: the project runs on the new major and the previous database is kept; confirming or rolling_back: a confirm or a rollback is running) and rollback_available_until, the time at which rollback and confirm stop being accepted and CapyDB confirms the upgrade on its own, destroying the previous database. " +
        "upgrade is null when nothing is in flight.",
      inputSchema: z.object({
        project_id: z.string().describe("Project id."),
      }),
      outputSchema: majorUpgradeStatusSchema,
    },
    async ({ project_id }) =>
      run(auth, async () => ({ upgrade: await client.getMajorUpgradeStatus(project_id) })),
  );

  server.registerTool(
    "upgrade_postgres_major",
    {
      ...writeTool("Upgrade the PostgreSQL major version", { destructiveHint: true }),
      description:
        "Moves the project's database to a newer PostgreSQL major. A new database is staged on the target major, the current one is write-fenced (writes are refused until the cutover), the data is copied across and verified, and the project is swapped onto the new database; the connection string does not change. " +
        "The previous database is kept for 72 hours, during which rollback_major_upgrade swaps back to it (discarding every write made after the cutover) and confirm_major_upgrade ends the window early. " +
        "The target has to be newer than the current major and offered for new databases (list_postgres_versions), and major_upgrade_preflight has to have passed for the same target within the last hour. " +
        upgradeAccess +
        " Runs asynchronously and returns a job whose state get_job reports. " +
        "get_upgrade_status reports the rollback window.",
      inputSchema: z.object({
        project_id: z.string().describe("Project id."),
        target_major: z.number().int().describe("PostgreSQL major to upgrade to, e.g. 18."),
        approval_token: approvalTokenInput("the project.upgrade_major action"),
      }),
    },
    async ({ project_id, target_major, approval_token }) =>
      run(auth, () => client.majorUpgradeStep(project_id, "upgrade", approval_token, target_major)),
  );

  server.registerTool(
    "confirm_major_upgrade",
    {
      ...writeTool("Confirm a major upgrade", { destructiveHint: true }),
      description:
        "Finalizes a PostgreSQL major upgrade: the previous database kept for rollback is destroyed, after which the upgrade can no longer be rolled back. " +
        "Without a confirm, CapyDB confirms on its own when the rollback window closes (rollback_available_until in get_upgrade_status); this tool only ends the window early. " +
        upgradeAccess +
        " Runs asynchronously and returns a job whose state get_job reports.",
      inputSchema: z.object({
        project_id: z.string().describe("Project id."),
        approval_token: approvalTokenInput("the project.upgrade_major_confirm action"),
      }),
    },
    async ({ project_id, approval_token }) =>
      run(auth, () => client.majorUpgradeStep(project_id, "confirm", approval_token)),
  );

  server.registerTool(
    "rollback_major_upgrade",
    {
      ...writeTool("Roll back a major upgrade", { destructiveHint: true }),
      description:
        "Swaps the project back onto the database kept from before a PostgreSQL major upgrade and destroys the upgraded one. " +
        "Every write committed after the upgrade's cutover is discarded: the kept database is the state at cutover, not a replica. " +
        "Possible only until rollback_available_until (get_upgrade_status), and only once the project's preview databases have been deleted. " +
        upgradeAccess +
        " Runs asynchronously and returns a job whose state get_job reports.",
      inputSchema: z.object({
        project_id: z.string().describe("Project id."),
        approval_token: approvalTokenInput("the project.upgrade_major_rollback action"),
      }),
    },
    async ({ project_id, approval_token }) =>
      run(auth, () => client.majorUpgradeStep(project_id, "rollback", approval_token)),
  );

  server.registerTool(
    "restore",
    {
      ...writeTool("Restore into a preview database", { destructiveHint: true }),
      description:
        "Restores a backup (backup_key), a named restore point (restore_point_id) or a point in time (restore_time) into a preview database: an existing one (preview_id), a new named one (preview_name), or a new auto-named one when neither is given. " +
        "Exactly one source is accepted, and preview_id and preview_name exclude each other. Restoring into an existing preview replaces that preview's data. " +
        "This tool cannot overwrite the project's own database: that restore is irreversible and is available only from the dashboard and the CLI, to an organization admin. " +
        "Returns { job, pitr? }; get_job reports the job's state. For a point-in-time restore, pitr gives requested_restore_time and the restore_time the job actually runs to. " +
        "A time later than the latest restorable point is not an error: the restore runs to the latest restorable point and restore_time_clamped is true. The completed job's result reports the time the restore reached.",
      inputSchema: z.object({
        project_id: z.string().describe("Project id."),
        backup_key: z.string().optional().describe("Backup to restore from."),
        restore_point_id: z.string().optional().describe("Named restore point to restore from."),
        restore_time: z
          .string()
          .optional()
          .describe("Point-in-time recovery target timestamp (RFC 3339)."),
        preview_id: z
          .string()
          .optional()
          .describe("Existing preview database to restore into (its data is replaced)."),
        preview_name: z
          .string()
          .optional()
          .describe("Name for a new preview database to restore into."),
        ttl_hours: z
          .number()
          .int()
          .min(1)
          .max(168)
          .optional()
          .describe("TTL for a newly created preview target (1-168 hours, default 24)."),
        allow_unverified_backup: z
          .boolean()
          .optional()
          .describe("true permits restoring from a backup whose verification has not passed."),
      }),
    },
    async ({
      project_id,
      backup_key,
      restore_point_id,
      restore_time,
      preview_id,
      preview_name,
      ttl_hours,
      allow_unverified_backup,
    }) => {
      const sources = [backup_key, restore_point_id, restore_time].filter(
        (source) => source !== undefined && source !== "",
      );
      if (sources.length !== 1) {
        return errorResult(
          new Error(
            "Provide exactly one restore source: backup_key, restore_point_id, or restore_time.",
          ),
        );
      }
      if (preview_id !== undefined && preview_name !== undefined) {
        return errorResult(
          new Error(
            "Provide preview_id (existing preview) or preview_name (new preview), not both.",
          ),
        );
      }
      return run(auth, () =>
        client.createRestore(project_id, {
          backup_key: backup_key ?? "",
          restore_point_id,
          restore_time,
          // Never "project": production overwrite is not exposed over MCP.
          // "preview" replaces an existing preview; "new_preview" creates one
          // (named via preview_name, or auto-named when omitted).
          target_kind: preview_id !== undefined ? "preview" : "new_preview",
          preview_id,
          preview_name,
          ttl_hours,
          allow_unverified_backup,
        }),
      );
    },
  );

  server.registerTool(
    "import_preflight",
    {
      ...readTool("Run an import preflight", { openWorldHint: true }),
      description:
        "Inspects an external source Postgres database (size, server version, installed extensions) and reports, in the same call, whether an import into the project is expected to succeed, with pass, warn or fail detail for each check. " +
        "Neither database is modified. The source URL contains credentials.",
      inputSchema: z.object({
        project_id: z.string().describe("Project id."),
        source_url: z
          .string()
          .describe(
            "Postgres connection URL of the source database (postgres://user:pass@host:port/db). A direct or session-mode endpoint is required: transaction-pooler URLs (Neon '-pooler' hostnames, Supabase port 6543) are rejected. Supabase sources get their platform-managed schemas (auth, storage, realtime and the like) excluded automatically.",
          ),
      }),
      outputSchema: importPreflightSchema,
    },
    async ({ project_id, source_url }) =>
      run(auth, () => client.runImportPreflight(project_id, source_url)),
  );

  server.registerTool(
    "import_database",
    {
      ...writeTool("Import a database", { destructiveHint: true, openWorldHint: true }),
      description:
        "Imports a live external Postgres database into the project from its connection URL. " +
        "The import overwrites the project's database: existing data that is not in the source is lost and can be recovered only from backups. " +
        "confirm has to be true and states that the user explicitly approved the overwrite; without it the call is refused before anything is sent. " +
        "import_preflight checks the same source without changing anything. " +
        "Runs asynchronously and returns a job whose state get_job reports. " +
        "The source URL contains credentials. Importing from a dump file is not available here; the CLI's upload flow (`capydb import --file`) covers it.",
      inputSchema: z.object({
        project_id: z.string().describe("Project id."),
        source_url: z
          .string()
          .describe(
            "Postgres connection URL of the source database (postgres://user:pass@host:port/db). A direct or session-mode endpoint is required: transaction-pooler URLs (Neon '-pooler' hostnames, Supabase port 6543) are rejected. Supabase sources get their platform-managed schemas (auth, storage, realtime and the like) excluded automatically.",
          ),
        recreate: z
          .boolean()
          .optional()
          .describe(
            "true drops and recreates the target database before importing (the cleanest overwrite).",
          ),
        confirm: z
          .boolean()
          .describe(
            "true states that the user explicitly approved overwriting the project's database with the imported data; any other value is refused.",
          ),
      }),
    },
    async ({ project_id, source_url, recreate, confirm }) => {
      if (!confirm) {
        return errorResult(
          new Error(
            "Import not confirmed: the import overwrites the project's database. Ask the user for explicit approval, then retry with confirm: true.",
          ),
        );
      }
      // The server now enforces the confirm too; forward the agent's
      // assertion instead of re-asserting it client-side.
      return run(auth, () => client.createImport(project_id, { source_url, recreate, confirm }));
    },
  );

  // ---- Schema & type generation ----------------------------------------------

  server.registerTool(
    "get_schema",
    {
      ...readTool("Get database schema"),
      description:
        "Returns the complete database schema in one call: schemas, tables, views, columns (types, nullability, defaults, identity), primary, foreign and unique keys, enums and installed extensions. " +
        "It is one request and the canonical shape, where reading pg_catalog through query_sql takes several. preview_id selects a preview database instead of the project database.",
      inputSchema: z.object({
        project_id: z.string().describe("Project id."),
        preview_id: z
          .string()
          .optional()
          .describe("A preview database to introspect instead of the project database."),
      }),
      outputSchema: databaseSchemaSchema,
    },
    async ({ project_id, preview_id }) =>
      run(auth, () =>
        preview_id ? client.getPreviewSchema(preview_id) : client.getProjectSchema(project_id),
      ),
  );

  server.registerTool(
    "generate_types",
    {
      ...readTool("Generate types from schema"),
      description:
        "Generates source code from the live database schema: TypeScript interfaces (language typescript; style capydb or supabase-compatible), Zod schemas (zod), a Drizzle ORM schema (drizzle), Go structs (go; package sets the package clause) or Python models (python; style dataclass or pydantic). " +
        "Returns { filename, content }, where filename is a suggested file name for the content. preview_id generates from a preview database, for example a migration branch.",
      inputSchema: z.object({
        project_id: z.string().describe("Project id."),
        language: z
          .enum(["typescript", "zod", "drizzle", "go", "python"])
          .optional()
          .describe("Output language (default typescript)."),
        style: z
          .enum(["capydb", "supabase", "dataclass", "pydantic"])
          .optional()
          .describe(
            "For typescript: capydb (per-table interfaces, default) or supabase (a Database generic compatible with supabase-js). For python: dataclass (standard-library frozen dataclasses, default) or pydantic (pydantic v2 models). Ignored by the other languages.",
          ),
        package: z
          .string()
          .optional()
          .describe(
            "Go package name for language go (default db). Ignored by the other languages.",
          ),
        preview_id: z
          .string()
          .optional()
          .describe("A preview database to generate from instead of the project database."),
      }),
      outputSchema: generatedTypesSchema,
    },
    async ({ project_id, language, style, package: goPackage, preview_id }) =>
      run(auth, () => {
        const options = { language, style, package: goPackage };
        return preview_id
          ? client.generatePreviewSchemaTypes(preview_id, options)
          : client.generateProjectSchemaTypes(project_id, options);
      }),
  );

  server.registerTool(
    "lint_schema",
    {
      ...readTool("Lint the schema and indexes"),
      description:
        "Checks the database for problems that are cheap to fix early and expensive later: tables without a primary key (missing_primary_key), foreign keys whose columns lead no index (unindexed_foreign_key), identical indexes (duplicate_index), indexes covered by a wider one (redundant_index), indexes with no scans (unused_index, reported only after a week of statistics) and tables where dead rows are a large share (table_bloat). " +
        "Read-only: a fixed set of catalog queries that touches no table data. " +
        "Each finding names the object (schema.name), a severity (warning or info) and, where there is one, a fix statement. The fix is a suggestion and nothing is applied; index changes lock tables. " +
        "skipped lists the checks that could not run, with the reason. preview_id lints a preview database, for example a migration branch before it reaches production. The report is the same as `capydb db lint --json`.",
      inputSchema: z.object({
        project_id: z.string().describe("Project id."),
        preview_id: z
          .string()
          .optional()
          .describe("A preview database to lint instead of the project database."),
      }),
      outputSchema: lintSchema,
    },
    async ({ project_id, preview_id }) =>
      run(auth, () =>
        preview_id ? client.lintPreview(preview_id) : client.lintProject(project_id),
      ),
  );

  // ---- Restore points (agent safety loop) -------------------------------------

  server.registerTool(
    "list_restore_points",
    {
      ...readTool("List restore points"),
      description:
        "Lists the project's named restore points and the PITR window (how many days back point-in-time recovery reaches).",
      inputSchema: z.object({
        project_id: z.string().describe("Project id."),
      }),
      outputSchema: restorePointsSchema,
    },
    async ({ project_id }) => run(auth, () => client.listRestorePoints(project_id)),
  );

  server.registerTool(
    "create_restore_point",
    {
      ...writeTool("Create a restore point", { destructiveHint: false }),
      description:
        "Creates a named restore point, which keeps the state before a risky change (a schema migration, a bulk update, destructive SQL) addressable. " +
        "If the change goes wrong, restore with restore_point_id recovers that state into a preview database; delete_restore_point removes the point once the change is verified. " +
        "kind backup pins an existing backup_key: create_backup makes a backup, and list_backups shows its key once the backup has completed. " +
        "kind pitr pins a timestamp (pitr_time, default now), and restoring it requires the project to be eligible for point-in-time recovery.",
      inputSchema: z.object({
        project_id: z.string().describe("Project id."),
        label: z.string().describe('Short label, e.g. "before-orders-migration".'),
        kind: z
          .enum(["backup", "pitr"])
          .describe("backup: pin an existing backup_key. pitr: pin a point-in-time marker."),
        backup_key: z
          .string()
          .optional()
          .describe(
            "Recorded backup key, required when kind is backup; list_backups shows it once create_backup has completed.",
          ),
        note: z.string().optional().describe("Free-form note about why the point was created."),
        pitr_time: z
          .string()
          .optional()
          .describe("RFC 3339 timestamp to pin when kind is pitr (defaults to now)."),
      }),
    },
    async ({ project_id, label, kind, backup_key, note, pitr_time }) =>
      run(auth, () => {
        if (kind === "backup" && !backup_key) {
          throw new Error(
            "backup_key is required for a backup restore point; run create_backup, wait for completion, then select the recorded key from list_backups",
          );
        }
        if (kind === "pitr" && backup_key) {
          throw new Error("backup_key is only valid when kind is backup");
        }
        if (kind === "backup" && pitr_time) {
          throw new Error("pitr_time is only valid when kind is pitr");
        }
        return client.createRestorePoint(project_id, {
          backup_key,
          kind,
          label,
          note,
          pitr_time,
        });
      }),
  );

  server.registerTool(
    "delete_restore_point",
    {
      ...writeTool("Delete a restore point", { destructiveHint: true }),
      description:
        "Deletes a named restore point, typically once the change it guarded has been verified. The backups underneath it follow the normal retention policy.",
      inputSchema: z.object({
        project_id: z.string().describe("Project id."),
        restore_point_id: z.string().describe("Restore point id."),
      }),
    },
    async ({ project_id, restore_point_id }) =>
      run(auth, async () => {
        await client.deleteRestorePoint(project_id, restore_point_id);
        return { deleted: restore_point_id };
      }),
  );

  // ---- Studio (SQL + data browser) ------------------------------------------

  const sqlInputSchema = z.object({
    project_id: z.string().describe("Project id."),
    query: z.string().describe("SQL statement to execute."),
    max_rows: z
      .number()
      .int()
      .positive()
      .max(1000)
      .optional()
      .describe("Row cap for the result (default 200, max 1000)."),
  });
  const sqlLimits =
    "This tool targets only the project's own database and has no preview_id parameter: query_preview_sql and execute_preview_sql run SQL on a preview database, and get_schema, lint_schema and generate_types accept preview_id for inspecting one. " +
    "Results are capped (default 200 rows, max 1000) and a statement times out after 15 seconds. Every execution is recorded in the project's SQL history. " +
    "Result rows are the user's own data. " +
    DOCS_REFERENCE;

  server.registerTool(
    "query_sql",
    {
      ...readTool("Query SQL (read-only)"),
      description:
        "Runs a SQL statement that does not change anything (SELECT, EXPLAIN, catalog inspection) against the project's CapyDB Postgres database - the live one. " +
        "Every call runs inside a READ ONLY transaction, so the database itself refuses every write (DML, DDL, TRUNCATE, SELECT INTO, sequence advancement) with an ordinary error; execute_sql is the counterpart for statements that change data or schema. " +
        sqlLimits,
      inputSchema: sqlInputSchema,
      outputSchema: sqlResultSchema,
    },
    async ({ project_id, query, max_rows }) =>
      run(auth, () => client.runSql(project_id, { query, max_rows, read_only: true })),
  );

  server.registerTool(
    "explain_query",
    {
      ...readTool("Explain a query's plan"),
      description:
        "Returns the planner's plan for one statement (SELECT, INSERT, UPDATE, DELETE or WITH) against the project's live database without executing it: EXPLAIN (COSTS, FORMAT TEXT) inside a READ ONLY transaction. " +
        "The input is the statement itself; a leading EXPLAIN is stripped, EXPLAIN ANALYZE is refused because it would run the statement, and input that holds more than one statement is refused. " +
        "Signs worth noticing in a plan: a Seq Scan on a large table whose Filter is a jsonb expression (payload->>'key' = ...) or a function of a column, which an expression index serves; Nested Loop nodes with a high row estimate on the inner side (an N+1 join or a missing join index); a Sort or HashAggregate over many rows (a work_mem spill); and an estimated row count far from the real one (stale statistics, which ANALYZE refreshes). " +
        "The summary line carries the top node's estimated cost and rows, which makes two shapes of the same query comparable before either runs. " +
        "A plan quotes literals from the statement, which are user-supplied text.",
      inputSchema: z.object({
        project_id: z.string().describe("Project id."),
        query: z.string().describe("One SQL statement to plan (without EXPLAIN; it is added)."),
      }),
      outputSchema: explainSchema,
    },
    async ({ project_id, query }) =>
      run(auth, async () =>
        formatExplainResult(
          await client.runSql(project_id, {
            query: prepareExplainQuery(query),
            max_rows: 500,
            read_only: true,
          }),
        ),
      ),
  );

  server.registerTool(
    "execute_sql",
    {
      ...writeTool("Execute SQL (may change data)", { destructiveHint: true }),
      description:
        "Executes a SQL statement that changes data or schema (INSERT, UPDATE, DELETE, DDL) against the project's CapyDB Postgres database - the live one, with the effect it would have in production. query_sql is the read-only counterpart. " +
        "An UPDATE or DELETE with no WHERE clause, and any TRUNCATE, is refused by the control plane rather than run, and the refusal names the remedy. That guard does not make a statement safe: a WHERE clause that is too broad passes it and still rewrites rows, and the original values cannot be recovered from the table afterwards. " +
        "A restore point created beforehand with create_restore_point is what makes such a change reversible; reconstructing overwritten values from a related table is lossy. " +
        "DO blocks and CALL statements are refused here, because their bodies can change any number of rows unseen; the dashboard's SQL Studio and `capydb sql` run them. " +
        "On a Postgres 18 or newer database (get_project shows the version), RETURNING old.*, new.* on an UPDATE or DELETE returns the values before and after for every affected row, so they land in the result and in SQL history; on 16 and 17 that clause is a syntax error. " +
        sqlLimits,
      inputSchema: sqlInputSchema,
    },
    async ({ project_id, query, max_rows }) =>
      run(auth, async () => {
        refuseDoAndCall(query);
        return client.runSql(project_id, { query, max_rows });
      }),
  );

  server.registerTool(
    "list_tables",
    {
      ...readTool("List tables"),
      description: "Lists the tables and views in the project database.",
      inputSchema: z.object({
        project_id: z.string().describe("Project id."),
      }),
      outputSchema: tablesSchema,
    },
    async ({ project_id }) =>
      run(auth, async () => ({ tables: await client.listTables(project_id) })),
  );

  server.registerTool(
    "get_table_rows",
    {
      ...readTool("Get table rows"),
      description:
        "Returns rows from one table of the project database; limit caps how many. Rows are the user's own data.",
      inputSchema: z.object({
        project_id: z.string().describe("Project id."),
        schema: z.string().describe('Schema name (e.g. "public").'),
        table: z.string().describe("Table name."),
        limit: z.number().int().positive().optional().describe("Maximum number of rows to return."),
      }),
      outputSchema: tableRowsSchema,
    },
    async ({ project_id, schema, table, limit }) =>
      run(auth, () => client.getTableRows(project_id, schema, table, limit)),
  );

  // ---- Observability + jobs --------------------------------------------------

  server.registerTool(
    "get_observability",
    {
      ...readTool("Get live project metrics"),
      description:
        "Returns a live observability snapshot of the project database: connection usage, database size against the storage limit, active queries, the slowest statements (when pg_stat_statements is available) and derived alerts. " +
        "wake summarizes scale-to-zero over the last 7 days: how often the database was woken (wakes) and how long waking took (p50_ms, p95_ms, max_ms over the timed wakes; null when none was timed) - the delay the first connection after an idle period pays, which always_on (update_project_settings) removes. " +
        "On Postgres 19 databases only (absent on 16-18): each slow query may carry generic_plan_calls and custom_plan_calls, executions on a cached generic plan against executions on a plan made for the actual parameters; a statement that is slow only sometimes and runs mostly generic may be getting a generic plan that suits some values badly. " +
        "lock_waits lists, per lock type, waits longer than deadlock_timeout (waits, wait_time_ms) and fast-path overflows (fastpath_exceeded) for the whole server the database runs on, and autovacuum_priority the ten tables autovacuum would reach first (score; do_vacuum, do_analyze, for_wraparound).",
      inputSchema: z.object({
        project_id: z.string().describe("Project id."),
      }),
      outputSchema: observabilitySchema,
    },
    async ({ project_id }) => run(auth, () => client.getObservability(project_id)),
  );

  server.registerTool(
    "get_logs",
    {
      ...readTool("Get database logs"),
      description:
        "Returns recent Postgres log entries for the project database, ascending by time. " +
        'Severity is parsed from the Postgres log format; continuation lines (STATEMENT, DETAIL, HINT, CONTEXT) report severity "detail". ' +
        "It works for a paused database too, because logs outlive the process; retention is typically several days. " +
        "next_cursor, passed back as cursor, continues the tail after the last entry; cursor takes precedence over hours, and an absent next_cursor means nothing new arrived and the previous cursor is still the position. " +
        "Log messages can quote statements and data from the user's database.",
      inputSchema: z.object({
        project_id: z.string().describe("Project id."),
        hours: z
          .number()
          .int()
          .min(1)
          .max(168)
          .optional()
          .describe("Trailing window in hours (1-168, default 1). Ignored when cursor is set."),
        severity: z
          .string()
          .optional()
          .describe(
            "Comma-separated severity filter (debug, log, info, notice, warning, error, fatal, panic, detail). All severities when omitted.",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe("Maximum entries returned (1-500, default 200). The newest entries are kept."),
        cursor: z
          .string()
          .optional()
          .describe(
            "A previously returned cursor; the result resumes strictly after that entry (tail mode).",
          ),
      }),
      outputSchema: logsSchema,
    },
    async ({ project_id, hours, severity, limit, cursor }) =>
      run(auth, () => client.getProjectLogs(project_id, { hours, severity, limit, cursor })),
  );

  server.registerTool(
    "get_recent_errors",
    {
      ...readTool("Get recent database errors"),
      description:
        "Returns the ERROR, FATAL and PANIC lines of the project database's recent log, folded into groups keyed by SQLSTATE plus the message with its variable parts normalised. " +
        "One group is one distinct failure, busiest first, with its count, first and last seen, the newest occurrence's exact message, its STATEMENT (the failing SQL), DETAIL, HINT and CONTEXT (for a batch, which parameter carried the bad value), the session's user and database, the SQLSTATE class name and a retryable verdict. " +
        "The reason a job or a query failed is usually here even when the client reported only 'Failed query'. " +
        "retryable false means the statement fails the same way on every attempt: data errors (22xxx, for example an out-of-range date), constraint violations (23xxx), syntax or privilege errors (42xxx). " +
        "retryable true covers connection failures (08xxx), serialization (40001) and deadlock (40P01) rollbacks, too many connections (53300) and a cell that is pausing or resuming (57P01-57P03), all of which can succeed on a later attempt. " +
        "truncated true means the window held more lines than the 500-line cap, so every count is a lower bound over the newest lines scanned; search_logs reaches further back. " +
        "Log messages and statements quote the user's data.",
      inputSchema: z.object({
        project_id: z.string().describe("Project id."),
        hours: z
          .number()
          .int()
          .min(1)
          .max(720)
          .optional()
          .describe(
            "Trailing window in hours (default 1; beyond 168 needs the platform log archive).",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe("Maximum raw log lines read (1-500, default 500); the newest are kept."),
      }),
      outputSchema: logErrorsSchema,
    },
    async ({ project_id, hours, limit }) =>
      run(auth, () => client.getProjectLogErrors(project_id, { hours, limit })),
  );

  server.registerTool(
    "search_logs",
    {
      ...readTool("Search database logs"),
      description:
        "Searches the project's archived Postgres logs, newest first, by SQLSTATE, severity and message text over up to the last 30 days, which answers questions such as when the unique-violation errors started that the recent window of get_logs cannot. " +
        "The newest few minutes are not searchable yet, because logs are archived in batches; get_logs covers them. Entries carry sqlstate, pid, user and database when Postgres logged them. " +
        "Each request scans a bounded amount: next_cursor, passed back with the same filters, continues the search until it is absent. truncated means the scan budget ran out before the page filled, so a short or empty page does not mean there are no older matches. " +
        "HTTP 503 means log search is switched off on the platform; get_logs still works. " +
        "Log messages can quote statements and data from the user's database.",
      inputSchema: z.object({
        project_id: z.string().describe("Project id."),
        sqlstate: z
          .string()
          .optional()
          .describe(
            "Comma-separated SQLSTATE filter: a five-character code matches exactly (42P01), a two-character class matches every code in it (23 = integrity constraint violations).",
          ),
        severity: z
          .string()
          .optional()
          .describe(
            "Comma-separated severity filter (debug, log, info, notice, warning, error, fatal, panic, detail). All severities when omitted.",
          ),
        q: z
          .string()
          .max(200)
          .optional()
          .describe("Case-insensitive substring the message has to contain."),
        since: z
          .string()
          .optional()
          .describe(
            "Window start (RFC 3339). Defaults to 24 hours before until; the window spans at most 720 hours.",
          ),
        until: z.string().optional().describe("Window end (RFC 3339). Defaults to now."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe("Maximum entries per page (1-500, default 100)."),
        cursor: z
          .string()
          .optional()
          .describe("next_cursor from the previous page of the same search."),
      }),
      outputSchema: logSearchSchema,
    },
    async ({ project_id, sqlstate, severity, q, since, until, limit, cursor }) =>
      run(auth, () =>
        client.searchProjectLogs(project_id, {
          sqlstate,
          severity,
          q,
          since,
          until,
          limit,
          cursor,
        }),
      ),
  );

  server.registerTool(
    "list_alerts",
    {
      ...readTool("List project alerts"),
      description:
        "Lists the project's open alerts, newest first. " +
        "Covers threshold alerts on storage and connection usage against the plan limits, backup failure and staleness alerts, reachability alerts (unreachable: the database does not answer probe connections; kv_unreachable: the project's K/V store does not; pooler_handshake: clients are failing the pooled-connection handshake), read_only (critical: a platform safety control has made the database read-only, so every write fails with 'cannot execute ... in a read-only transaction' until it is lifted; nothing in the application needs changing) and warning-severity health advisories (cache_hit, blocked_queries, deadlocks, vacuum, long_transaction, subtransactions, oom_kill, temp_spill) derived from the periodic metrics sweep. " +
        "An alert is open while resolved_at is absent, and it resolves on its own when the condition clears. " +
        "include_resolved adds the alerts resolved in the last 30 days, which shows whether a condition has recurred; a busy project accumulates hundreds of them. limit caps the list (default 50, max 200), and total_matching and open_count give the full counts.",
      inputSchema: z.object({
        project_id: z.string().describe("Project id."),
        include_resolved: z
          .boolean()
          .optional()
          .describe(
            "true adds alerts that have already resolved (default false: only open alerts are returned).",
          ),
        limit: z
          .number()
          .int()
          .positive()
          .max(200)
          .optional()
          .describe("Maximum alerts to return, newest first (default 50, max 200)."),
      }),
      outputSchema: alertsSchema,
    },
    async ({ project_id, include_resolved, limit }) =>
      run(auth, async () => {
        // The control plane returns open alerts plus everything resolved in the
        // last 30 days, unbounded. That is right for the dashboard's history view
        // and wrong for a tool result: on a project with a flapping condition it
        // is tens of kilobytes of resolved rows, nearly all of it irrelevant to
        // the question the caller is actually asking. Narrow it here rather than
        // changing an endpoint the dashboard depends on.
        const alerts = await client.listProjectAlerts(project_id);
        const relevant =
          include_resolved === true
            ? alerts
            : alerts.filter(
                (alert) => alert.resolved_at === undefined || alert.resolved_at === null,
              );
        const cap = limit ?? 50;
        return {
          alerts: relevant.slice(0, cap),
          returned: Math.min(relevant.length, cap),
          total_matching: relevant.length,
          open_count: alerts.filter(
            (alert) => alert.resolved_at === undefined || alert.resolved_at === null,
          ).length,
          include_resolved: include_resolved === true,
        };
      }),
  );

  server.registerTool(
    "acknowledge_alert",
    {
      ...writeTool("Acknowledge a project alert", { destructiveHint: false, idempotentHint: true }),
      description:
        "Records that the user has seen an alert (alert_id from list_alerts). Idempotent: the first acknowledgement time is kept. " +
        "Acknowledging does not resolve the alert; it resolves on its own when the underlying condition clears (storage freed, connections reduced, a backup that succeeds).",
      inputSchema: z.object({
        project_id: z.string().describe("Project id."),
        alert_id: z.string().describe("Alert id from list_alerts."),
      }),
    },
    async ({ project_id, alert_id }) =>
      run(auth, () => client.acknowledgeProjectAlert(project_id, alert_id)),
  );

  server.registerTool(
    "get_job",
    {
      ...readTool("Get a job"),
      description:
        'Returns one asynchronous job by id. "completed" and "failed" are its final states, and a failed job carries its error. ' +
        "Jobs are returned by create_preview_database, reset_preview_database, delete_preview_database, create_backup, export_database, restore, import_database, enable_extension, disable_extension, update_extension, major_upgrade_preflight, upgrade_postgres_major, confirm_major_upgrade, rollback_major_upgrade, create_kv_store, retry_provisioning, enable_app_role, rotate_app_role and sync_integration_env, and by create_project when provisioning outlasts its wait.",
      inputSchema: z.object({
        job_id: z.string().describe("Job id."),
      }),
      outputSchema: jobSchema,
    },
    async ({ job_id }) => run(auth, () => client.getJob(job_id)),
  );

  server.registerTool(
    "list_jobs",
    {
      ...readTool("List project jobs"),
      description: "Lists a project's asynchronous jobs, newest first (default 25).",
      inputSchema: z.object({
        project_id: z.string().describe("Project id."),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Maximum number of jobs to return (default 25)."),
      }),
      outputSchema: jobsSchema,
    },
    async ({ project_id, limit }) =>
      run(auth, async () => ({ jobs: await client.listJobs(project_id, limit) })),
  );

  // ---- App role (split role model) -------------------------------------------

  server.registerTool(
    "get_app_role",
    {
      ...readTool("Get the project's app role"),
      description:
        "Reports whether the project has the split-role runtime login app_user - a second login role that owns nothing, cannot bypass row-level security and is not a member of the owner, so RLS policies apply to everything it runs - and when it was issued or last rotated. " +
        "available says whether the platform lets a project enable it right now; a project that already has it can use and rotate it either way. " +
        "Its connection strings are not returned here: once enabled they appear under app in get_connection_strings.",
      inputSchema: z.object({
        project_id: z.string().describe("Project id."),
      }),
      outputSchema: appRoleSchema,
    },
    async ({ project_id }) => run(auth, () => client.getAppRole(project_id)),
  );

  server.registerTool(
    "enable_app_role",
    {
      ...writeTool("Enable the project's app role", { destructiveHint: false }),
      description:
        "Opts the project into the split role model: issues the runtime login app_user on its database, for the application to connect as so that row-level security applies. The owner login keeps working for migrations and admin work and can SET ROLE app_user. " +
        "app_user starts with no access to the project's tables; grants give it what the app needs (the roles file that `capydb migrate rls --role-model split` produces is one source), and its connection strings appear under app in get_connection_strings. " +
        "Requires PostgreSQL 16 or newer. Where the platform does not offer it yet the call answers HTTP 404, which is expected rather than a failure; available in get_app_role says which applies. " +
        "Runs asynchronously and returns a job whose state get_job reports.",
      inputSchema: z.object({
        project_id: z.string().describe("Project id."),
      }),
    },
    async ({ project_id }) => run(auth, () => client.enableAppRole(project_id)),
  );

  server.registerTool(
    "rotate_app_role",
    {
      ...writeTool("Rotate the app role password", { destructiveHint: true }),
      description:
        "Replaces the app_user password in place. " +
        "The old password stops working when the job completes, so every app that connects as app_user fails until it has the new connection strings, which appear under app in get_connection_strings; sync_integration_env pushes them to a connected deployment platform. " +
        "Runs asynchronously and returns a job whose state get_job reports.",
      inputSchema: z.object({
        project_id: z.string().describe("Project id."),
      }),
    },
    async ({ project_id }) => run(auth, () => client.rotateAppRole(project_id)),
  );

  // ---- Deployment-platform integrations --------------------------------------

  server.registerTool(
    "sync_integration_env",
    {
      ...writeTool("Re-sync connection env vars to a platform", {
        destructiveHint: true,
        idempotentHint: true,
      }),
      description:
        "Pushes the project's current connection env vars again to a connected Vercel, Netlify or Cloudflare integration, using the token stored when it was connected, so nothing is entered again. " +
        "It repairs a variable that was edited or deleted on the platform, or a push that failed; values edited on the platform are overwritten with CapyDB's. Pushes also happen on their own after credential rotations and restores. " +
        "Answers HTTP 404 when that integration is not connected to the project and 409 while a push for it is already queued or running. " +
        "Runs asynchronously and returns a job whose state get_job reports.",
      inputSchema: z.object({
        project_id: z.string().describe("Project id."),
        provider: z
          .enum(["vercel", "netlify", "cloudflare"])
          .describe("The connected deployment platform."),
      }),
    },
    async ({ project_id, provider }) =>
      run(auth, () => client.syncIntegrationEnv(project_id, provider)),
  );

  // ---- Public status -----------------------------------------------------------

  server.registerTool(
    "get_status_history",
    {
      ...readTool("Get CapyDB status history (no account needed)"),
      description:
        "Returns CapyDB's public status history: per-region daily uptime over the last days (default 90) and the incidents that overlap that window. No account is needed. " +
        "A day's uptime_percent is the share of that day's status samples in which the region was up; degraded counts as up and only outage as down. A day without samples is null (no data), not 100%. " +
        "It shows whether a problem is platform-wide; get_observability and list_alerts cover a single database.",
      inputSchema: z.object({
        days: z
          .number()
          .int()
          .min(1)
          .max(90)
          .optional()
          .describe("Window length in UTC days, today included (1-90, default 90)."),
      }),
      outputSchema: statusHistorySchema,
    },
    async ({ days }) => runAnonymous(() => client.getStatusHistory(days)),
  );
}
