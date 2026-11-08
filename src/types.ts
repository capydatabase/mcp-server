/**
 * CapyDB control-plane types used by the MCP tools.
 *
 * Every shape here is re-exported from `@capydb/sdk`, which is generated from the
 * control plane's OpenAPI document, so nothing in this server can drift from the
 * API. Nothing is declared locally.
 *
 * Note the dump-upload import variant (`upload_key` on CreateImportRequest) is
 * deliberately not exposed over MCP: it needs the presigned-upload flow that only
 * the CLI and dashboard implement.
 */

export type {
  ActiveQuerySample,
  AppRoleStatus,
  Backup,
  CreatePreviewRequest,
  CreateImportRequest,
  CreateProjectRequest,
  CreateRestorePointRequest,
  CreateRestoreRequest,
  CreateRestoreResponse,
  DatabaseSchema,
  DatabaseTable,
  EphemeralDatabase,
  EphemeralDatabaseCreateRequest,
  EphemeralDatabaseCreated,
  EphemeralDatabaseDetails,
  ExportDownload,
  GeneratedTypes,
  ImportPreflightCheck,
  ImportPreflightResult,
  IndexAdvisorReport,
  IndexHygieneReport,
  IndexSuggestion,
  Job,
  KvCredentials as KVCredentials,
  KvStore as KVStore,
  LintFinding,
  LintReport,
  MajorUpgradeStatus,
  NotificationPreferences,
  OrganizationUsage,
  PitrRestoreTarget,
  PostgresVersion,
  PreviewConnectionInfo,
  PreviewDatabase,
  Project,
  ProjectAlert,
  ProjectAuditEvent,
  ProjectConnectionInfo,
  ProjectExport,
  ProjectExtensionStatus,
  ProjectExtensionStatus as ProjectExtension,
  ProjectLogEntry,
  ProjectLogSearch,
  ProjectLogs,
  ProjectObservability,
  ProjectWakeLatency,
  PutNotificationPreferencesRequest,
  RedundantIndex,
  RegionDetail,
  RegionsResponse,
  RestorePoint,
  ScheduledBackup,
  SchemaColumn,
  SchemaEnum,
  SchemaExtension,
  SchemaForeignKey,
  SchemaNamespace,
  SchemaTable,
  SchemaUniqueConstraint,
  SlowQuerySample,
  SourceExtension,
  SourceInspection,
  SqlQueryRequest as SQLQueryRequest,
  SqlQueryResult as SQLQueryResult,
  StatusHistoryResponse,
  TableRowsResult,
  UnusedIndex,
  UpdateProjectRequest,
  UpsertScheduledBackupRequest,
} from "@capydb/sdk";

import type { ProjectConnectionInfo } from "@capydb/sdk";

/**
 * One distinct failure in a log window, from `GET /v1/projects/{id}/logs/errors`
 * (`ProjectLogErrorGroup` in the control plane's OpenAPI document). Declared
 * here until the published `@capydb/sdk` is regenerated from that document;
 * move it into the re-export list above then.
 */
export type ProjectLogErrorGroup = {
  key: string;
  /** Five-character SQLSTATE shared by the group; absent for lines without one. */
  sqlstate?: string;
  /** SQLSTATE class name (data_exception, integrity_constraint_violation, ...). */
  class?: string;
  /** True when the condition is transient by its class and worth one retry. */
  retryable: boolean;
  severity: "error" | "fatal" | "panic";
  /** Occurrences among the scanned lines (a lower bound when truncated). */
  count: number;
  /** Distinct exact messages the group folds together. */
  variants: number;
  first_seen: string;
  last_seen: string;
  /** The newest occurrence's exact message. */
  message: string;
  /** The newest occurrence's STATEMENT line(s), when Postgres logged them. */
  statement?: string;
  detail?: string;
  hint?: string;
  /** e.g. which parameter of a batch carried the bad value. */
  context?: string;
  user?: string;
  database?: string;
};

/** The error-class lines of one log window, grouped busiest first. */
export type ProjectLogErrors = {
  groups: ProjectLogErrorGroup[];
  since: string;
  scanned: number;
  occurrences: number;
  /** True when the line cap was reached: every count is a lower bound. */
  truncated: boolean;
};

/** Connection endpoints for a project or a preview database - one shape for both. */
export type ConnectionInfo = ProjectConnectionInfo;
