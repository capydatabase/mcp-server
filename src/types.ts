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
  Backup,
  CreatePreviewRequest,
  CreateImportRequest,
  CreateProjectRequest,
  CreateRestorePointRequest,
  CreateRestoreRequest,
  DatabaseSchema,
  DatabaseTable,
  ExportDownload,
  GeneratedTypes,
  ImportPreflightCheck,
  ImportPreflightResult,
  IndexAdvisorReport,
  IndexSuggestion,
  Job,
  OrganizationUsage,
  PreviewConnectionInfo,
  PreviewDatabase,
  Project,
  ProjectAlert,
  ProjectConnectionInfo,
  ProjectExport,
  ProjectExtensionStatus,
  ProjectExtensionStatus as ProjectExtension,
  ProjectLogEntry,
  ProjectLogs,
  ProjectObservability,
  RegionsResponse,
  RestorePoint,
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
  TableRowsResult,
} from "@capydb/sdk";

import type { ProjectConnectionInfo } from "@capydb/sdk";

/** Connection endpoints for a project or a preview database - one shape for both. */
export type ConnectionInfo = ProjectConnectionInfo;
