/**
 * Output schemas for the read tools (MCP `outputSchema`; the result carries the
 * same value as `structuredContent`).
 *
 * The SDK validates every `structuredContent` against the tool's output schema
 * and answers a protocol error - not a tool error - when it does not match, so
 * a schema that is stricter than the control plane breaks the tool outright.
 * Two rules keep that from happening:
 *
 * - Every object is a `z.looseObject`: fields the control plane adds later pass
 *   through, and the advertised JSON Schema does not forbid them (a plain
 *   `z.object` advertises `additionalProperties: false`, which a strict client
 *   would enforce against the extra keys still on the wire).
 * - Only the fields that identify a record are required; every other declared
 *   field is `nullish()`, because the control plane may send `null` for an
 *   absent value.
 *
 * `conforms<Api>()` ties each schema to the `@capydb/sdk` type generated from
 * the OpenAPI document: the build fails when a schema requires a field the API
 * makes optional, or declares a type the API does not send.
 */

import { z } from "zod";

import type {
  Backup,
  ConnectionInfo,
  DatabaseSchema,
  DatabaseTable,
  EphemeralDatabaseDetails,
  ExportDownload,
  GeneratedTypes,
  ImportPreflightResult,
  IndexAdvisorReport,
  IndexHygieneReport,
  Job,
  KVCredentials,
  KVStore,
  OrganizationUsage,
  PreviewDatabase,
  Project,
  ProjectAlert,
  ProjectAuditEvent,
  ProjectExport,
  ProjectExtension,
  ProjectLogs,
  ProjectObservability,
  RestorePoint,
  ScheduledBackup,
  SQLQueryResult,
  TableRowsResult,
} from "./types.js";

/** Compile-time check that every value of `Api` satisfies the schema. */
function conforms<Api>() {
  return <Schema extends z.ZodType>(
    schema: Schema & (Api extends z.infer<Schema> ? unknown : never),
  ): Schema => schema;
}

const record = z.looseObject({});
const nullableString = z.string().nullish();
const nullableNumber = z.number().nullish();
const nullableBoolean = z.boolean().nullish();

/** Wraps a list so every tool result has an object root. */
function listOf<Key extends string, Item extends z.ZodType>(key: Key, item: Item) {
  return z.looseObject({ [key]: z.array(item) } as Record<Key, z.ZodArray<Item>>);
}

export const projectSchema = conforms<Project>()(
  z.looseObject({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    organization_id: z.string(),
    state: z.string(),
    environment: z.string().describe("production or non_production."),
    always_on: z
      .boolean()
      .describe("true: never sleeps. false: scales to zero when idle and wakes on connect."),
    runtime_status: nullableString.describe("active, paused or resuming."),
    region: z.string(),
    plan: z.string(),
    postgres_version: nullableString,
    storage_limit_bytes: z.number(),
    max_connections: z.number(),
    last_error: nullableString,
  }),
);

export const jobSchema = conforms<Job>()(
  z.looseObject({
    id: z.string(),
    type: z.string(),
    state: z.string().describe("pending, running, completed or failed."),
    project_id: nullableString,
    preview_database_id: nullableString,
    error: nullableString,
    created_at: z.string(),
    completed_at: nullableString,
    result: z.unknown().optional(),
  }),
);

export const connectionInfoSchema = conforms<ConnectionInfo>()(
  z.looseObject({
    username: z.string(),
    pooled_url: nullableString.describe("SECRET: embeds the database password."),
    direct_url: nullableString.describe("SECRET: embeds the database password."),
  }),
);

export const usageSchema = conforms<OrganizationUsage>()(
  z.looseObject({
    totals: record,
    projects: z.array(record),
    storage_history: z.array(record),
  }),
);

export const kvStoreSchema = conforms<KVStore>()(
  z.looseObject({
    id: z.string(),
    project_id: z.string(),
    state: z.string(),
    maxmemory_mb: z.number().describe("Storable capacity."),
    mem_max_mb: z.number().describe("Memory ceiling of the cell; NOT usable capacity."),
    maxmemory_policy: z.string(),
    persistence: z.string(),
    last_error: nullableString,
  }),
);

export const kvCredentialsSchema = conforms<KVCredentials>()(
  z.looseObject({
    rest_url: z.string(),
    redis_url: z.string(),
    redis_host: z.string(),
    redis_port: z.number(),
    token_required: z.boolean(),
  }),
);

export const ephemeralDatabaseSchema = conforms<EphemeralDatabaseDetails>()(
  z.looseObject({
    ephemeral_database: z.looseObject({
      project_id: z.string(),
      state: z.string().describe("provisioning, ready or failed."),
      expires_at: z.string(),
      name: nullableString,
      region: nullableString,
    }),
    connections: connectionInfoSchema.nullish(),
  }),
);

export const previewDatabaseSchema = conforms<PreviewDatabase>()(
  z.looseObject({
    id: z.string(),
    project_id: z.string(),
    name: z.string(),
    state: z.string(),
    mode: z.string().describe("empty or clone."),
    ttl_expires_at: z.string(),
    last_error: nullableString,
  }),
);

export const backupSchema = conforms<Backup>()(
  z.looseObject({
    id: z.string(),
    backup_key: z.string(),
    state: z.string(),
    created_at: z.string(),
    size_bytes: nullableNumber,
    label: nullableString,
    verification_state: nullableString,
  }),
);

export const exportSchema = conforms<ProjectExport>()(
  z.looseObject({
    id: z.string(),
    state: z.string(),
    created_at: z.string(),
    expires_at: z.string(),
    size_bytes: nullableNumber,
  }),
);

export const exportDownloadSchema = conforms<ExportDownload>()(
  z.looseObject({
    download_url: z.string(),
    expires_at: z.string(),
  }),
);

export const extensionSchema = conforms<ProjectExtension>()(
  z.looseObject({
    name: z.string(),
    enabled: z.boolean(),
    description: nullableString,
    installed_version: nullableString,
    available_version: nullableString,
    update_available: nullableBoolean,
    requires_restart: nullableBoolean,
    category: nullableString,
  }),
);

export const indexAdvisorSchema = conforms<IndexAdvisorReport>()(
  z.looseObject({
    available: z.boolean(),
    reason: nullableString,
    missing_extensions: z.array(z.string()).nullish(),
    suggestions: z.array(record).nullish(),
  }),
);

export const indexHygieneSchema = conforms<IndexHygieneReport>()(
  z.looseObject({
    available: z.boolean(),
    reason: nullableString,
    unused_indexes: z.array(record).nullish(),
    redundant_indexes: z.array(record).nullish(),
    reclaimable_bytes: nullableNumber,
  }),
);

export const importPreflightSchema = conforms<ImportPreflightResult>()(
  z.looseObject({
    ok: z.boolean(),
    checks: z.array(
      z.looseObject({
        name: z.string(),
        status: z.string().describe("pass, warn or fail."),
        detail: nullableString,
      }),
    ),
    source: record.nullish(),
    target_version: nullableString,
  }),
);

export const databaseSchemaSchema = conforms<DatabaseSchema>()(
  z.looseObject({
    database_name: z.string(),
    postgres_version: nullableString,
    schemas: z.array(record),
    extensions: z.array(record).nullish(),
  }),
);

export const generatedTypesSchema = conforms<GeneratedTypes>()(
  z.looseObject({
    filename: z.string(),
    content: z.string(),
    language: z.string(),
    style: nullableString,
  }),
);

const restorePointSchema = conforms<RestorePoint>()(
  z.looseObject({
    id: z.string(),
    label: z.string(),
    kind: z.string().describe("backup or pitr."),
    state: z.string(),
    created_at: z.string(),
    backup_key: nullableString,
    pitr_time: nullableString,
    note: nullableString,
  }),
);

export const restorePointsSchema = z.looseObject({
  restore_points: z.array(restorePointSchema),
  pitr_window_days: nullableNumber,
});

export const sqlResultSchema = conforms<SQLQueryResult>()(
  z.looseObject({
    columns: z.array(z.string()),
    rows: z.array(z.record(z.string(), z.unknown())),
    row_count: z.number(),
    truncated: z.boolean(),
    duration_ms: nullableNumber,
  }),
);

export const tableRowsSchema = conforms<TableRowsResult>()(
  z.looseObject({
    columns: z.array(z.string()),
    rows: z.array(z.record(z.string(), z.unknown())),
  }),
);

export const observabilitySchema = conforms<ProjectObservability>()(
  z.looseObject({
    connection_count: z.number(),
    connection_limit: z.number(),
    database_size_bytes: z.number(),
    storage_limit_bytes: z.number(),
    alerts: z.array(z.string()).nullish(),
    active_queries: z.array(record).nullish(),
    slow_queries: z.array(record).nullish(),
  }),
);

export const logsSchema = conforms<ProjectLogs>()(
  z.looseObject({
    entries: z.array(record),
    next_cursor: nullableString,
  }),
);

const alertSchema = conforms<ProjectAlert>()(
  z.looseObject({
    id: z.string(),
    kind: z.string(),
    severity: z.string().describe("warning or critical."),
    triggered_at: z.string(),
    resolved_at: nullableString.describe("Absent while the alert is open."),
    acknowledged_at: nullableString,
  }),
);

export const alertsSchema = z.looseObject({
  alerts: z.array(alertSchema),
  returned: z.number(),
  total_matching: z.number(),
  open_count: z.number(),
  include_resolved: z.boolean(),
});

const scheduledBackupSchema = conforms<ScheduledBackup>()(
  z.looseObject({
    id: z.string(),
    project_id: z.string(),
    cron_hour: z.number().describe("UTC hour."),
    cron_minute: z.number().describe("UTC minute."),
    is_active: z.boolean(),
    retention_days: z.number(),
    label: nullableString,
    last_run_at: nullableString,
    last_job_id: nullableString,
  }),
);

const auditEventSchema = conforms<ProjectAuditEvent>()(
  z.looseObject({
    id: z.string(),
    action: z.string(),
    actor_kind: z.string(),
    actor_id: nullableString,
    project_id: nullableString,
    created_at: z.string(),
    metadata: z.unknown().optional(),
  }),
);

export const regionsSchema = listOf("regions", z.string());
export const projectsSchema = listOf("projects", projectSchema);
export const kvStoresSchema = listOf("kv_stores", kvStoreSchema);
export const previewDatabasesSchema = listOf("preview_databases", previewDatabaseSchema);
export const backupsSchema = listOf("backups", backupSchema);
export const exportsSchema = listOf("exports", exportSchema);
export const extensionsSchema = listOf("extensions", extensionSchema);
export const tablesSchema = listOf(
  "tables",
  conforms<DatabaseTable>()(
    z.looseObject({ schema: z.string(), table: z.string(), type: z.string() }),
  ),
);
export const jobsSchema = listOf("jobs", jobSchema);
export const scheduledBackupsSchema = listOf("scheduled_backups", scheduledBackupSchema);
export const auditEventsSchema = listOf("audit_events", auditEventSchema);
