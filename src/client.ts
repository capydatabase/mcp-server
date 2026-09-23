/**
 * Thin typed fetch client for the CapyDB control plane API.
 *
 * Intentionally has no dependency on `@capydb/sdk` - the MCP server only needs
 * a small slice of the API and a single-file client keeps the published
 * package lean. The API shape mirrors `backend/internal/httpapi/openapi.json`.
 */

import type {
  Backup,
  ConnectionInfo,
  CreateImportRequest,
  CreatePreviewRequest,
  CreateProjectRequest,
  CreateRestorePointRequest,
  CreateRestoreRequest,
  DatabaseSchema,
  DatabaseTable,
  EphemeralDatabaseCreateRequest,
  EphemeralDatabaseCreated,
  EphemeralDatabaseDetails,
  ExportDownload,
  GeneratedTypes,
  ImportPreflightResult,
  Job,
  KVCredentials,
  KVStore,
  OrganizationUsage,
  PreviewDatabase,
  Project,
  ProjectAlert,
  IndexAdvisorReport,
  IndexHygieneReport,
  ProjectExport,
  ProjectExtension,
  ProjectLogs,
  ProjectObservability,
  RegionsResponse,
  RestorePoint,
  SQLQueryRequest,
  SQLQueryResult,
  TableRowsResult,
} from "./types.js";

export const DEFAULT_API_URL = "https://capydb.dev/api/capydb";

/**
 * sqlcommenter tag appended to every statement this server runs, so agent
 * traffic is attributable in SQL history and query statistics.
 *
 * The format is the sqlcommenter convention (key='value' pairs in a trailing
 * SQL comment), which Postgres carries through into the statement text.
 */
const SQL_SOURCE_TAG = "/*source='capydb-mcp'*/";

/**
 * Appends the source tag, unless it is already there (a statement replayed
 * through this client twice must not accumulate tags).
 *
 * The tag goes at the END of the statement: a leading comment would sit before
 * a leading keyword and break callers that inspect the first token, and a
 * trailing comment survives a trailing semicolon either way.
 */
function tagQuery(query: string): string {
  const trimmed = query.trimEnd();
  if (trimmed.includes(SQL_SOURCE_TAG)) {
    return query;
  }
  const withoutTrailingSemicolon = trimmed.replace(/;+$/, "");
  return `${withoutTrailingSemicolon} ${SQL_SOURCE_TAG}`;
}

/** Error raised for non-2xx control plane responses. */
export class CapyDBApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "CapyDBApiError";
    this.status = status;
  }
}

export interface CapyDBClientOptions {
  /**
   * Returns the API key (`capy_...`) for each request. Resolved lazily so the
   * key can arrive after startup via the first-run device login.
   */
  getApiKey: () => string;
  /** Control plane base URL. Defaults to the hosted bridge. */
  baseUrl?: string;
}

interface RequestOptions {
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /**
   * Send no `Authorization` header and never touch the API key. Only the
   * ephemeral-database create, read and destroy are anonymous: they must work before
   * (and without) a device login, which `getApiKey()` would otherwise demand.
   */
  anonymous?: boolean;
  headers?: Record<string, string>;
}

export class CapyDBClient {
  private readonly getApiKey: () => string;
  private readonly baseUrl: string;

  constructor(options: CapyDBClientOptions) {
    this.getApiKey = options.getApiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_API_URL).replace(/\/+$/, "");
  }

  private async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          ...(options.anonymous === true ? {} : { authorization: `Bearer ${this.getApiKey()}` }),
          accept: "application/json",
          ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
          ...options.headers,
        },
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      });
    } catch (cause) {
      throw new Error(`CapyDB API request failed: ${method} ${path}: ${String(cause)}`, { cause });
    }

    const text = await response.text();
    if (!response.ok) {
      throw new CapyDBApiError(response.status, extractErrorMessage(text, response.status));
    }
    if (text.length === 0) {
      return undefined as T;
    }
    try {
      return JSON.parse(text) as T;
    } catch (cause) {
      throw new Error(`CapyDB API returned invalid JSON for ${method} ${path}`, { cause });
    }
  }

  // ---- Regions ---------------------------------------------------------------

  async listRegions(): Promise<string[]> {
    const data = await this.request<RegionsResponse>("GET", "/v1/regions");
    return data.regions ?? [];
  }

  // ---- Projects ------------------------------------------------------------

  async createProject(body: CreateProjectRequest): Promise<{ project: Project; job: Job }> {
    return await this.request("POST", "/v1/projects", { body });
  }

  async getOrganizationUsage(organizationId: string): Promise<OrganizationUsage> {
    const data = await this.request<{ usage: OrganizationUsage }>(
      "GET",
      `/v1/organizations/${organizationId}/usage`,
    );
    return data.usage;
  }

  async listProjects(organizationId?: string): Promise<Project[]> {
    const data = await this.request<{ projects: Project[] | null }>("GET", "/v1/projects", {
      query: { organization_id: organizationId },
    });
    return data.projects ?? [];
  }

  async getProject(projectId: string): Promise<Project> {
    const data = await this.request<{ project: Project }>(
      "GET",
      `/v1/projects/${encodeURIComponent(projectId)}`,
    );
    return data.project;
  }

  async getProjectConnections(projectId: string): Promise<ConnectionInfo> {
    const data = await this.request<{ connections: ConnectionInfo }>(
      "GET",
      `/v1/projects/${encodeURIComponent(projectId)}/connections`,
    );
    return data.connections;
  }

  // ---- Ephemeral databases --------------------------------------------------

  async createEphemeralDatabase(
    body: EphemeralDatabaseCreateRequest,
  ): Promise<EphemeralDatabaseCreated> {
    return await this.request("POST", "/v1/ephemeral-databases", { body, anonymous: true });
  }

  /** The claim token travels in a header so it never lands in access logs. */
  async getEphemeralDatabase(
    projectId: string,
    claimToken: string,
  ): Promise<EphemeralDatabaseDetails> {
    return await this.request("GET", `/v1/ephemeral-databases/${encodeURIComponent(projectId)}`, {
      anonymous: true,
      headers: { "x-capydb-claim-token": claimToken },
    });
  }

  /**
   * Brings the expiry forward to now; the worker's sweep deletes the database
   * within seconds. Idempotent (204); a claimed database answers 404.
   */
  async destroyEphemeralDatabase(projectId: string, claimToken: string): Promise<void> {
    await this.request<unknown>(
      "DELETE",
      `/v1/ephemeral-databases/${encodeURIComponent(projectId)}`,
      {
        anonymous: true,
        headers: { "x-capydb-claim-token": claimToken },
      },
    );
  }

  async claimEphemeralDatabase(projectId: string, claimToken: string): Promise<Project> {
    const data = await this.request<{ project: Project }>(
      "POST",
      `/v1/ephemeral-databases/${encodeURIComponent(projectId)}/claim`,
      { body: { claim_token: claimToken } },
    );
    return data.project;
  }

  // ---- Preview databases ---------------------------------------------------

  async createPreviewDatabase(
    projectId: string,
    body: CreatePreviewRequest,
  ): Promise<{ preview: PreviewDatabase; job: Job }> {
    return await this.request(
      "POST",
      `/v1/projects/${encodeURIComponent(projectId)}/preview-databases`,
      {
        body,
      },
    );
  }

  async listPreviewDatabases(projectId: string): Promise<PreviewDatabase[]> {
    const data = await this.request<{ preview_databases: PreviewDatabase[] | null }>(
      "GET",
      `/v1/projects/${encodeURIComponent(projectId)}/preview-databases`,
    );
    return data.preview_databases ?? [];
  }

  async deletePreviewDatabase(previewId: string): Promise<Job> {
    const data = await this.request<{ job: Job }>(
      "DELETE",
      `/v1/preview-databases/${encodeURIComponent(previewId)}`,
    );
    return data.job;
  }

  async getPreviewConnections(previewId: string): Promise<ConnectionInfo> {
    const data = await this.request<{ connections: ConnectionInfo }>(
      "GET",
      `/v1/preview-databases/${encodeURIComponent(previewId)}/connections`,
    );
    return data.connections;
  }

  async resetPreviewDatabase(previewId: string): Promise<Job> {
    const data = await this.request<{ job: Job }>(
      "POST",
      `/v1/preview-databases/${encodeURIComponent(previewId)}/reset`,
    );
    return data.job;
  }

  async extendPreviewDatabase(previewId: string, ttlHours: number): Promise<PreviewDatabase> {
    const data = await this.request<{ preview: PreviewDatabase }>(
      "POST",
      `/v1/preview-databases/${encodeURIComponent(previewId)}/extend`,
      { body: { ttl_hours: ttlHours } },
    );
    return data.preview;
  }

  // ---- Backups, restores, imports -------------------------------------------

  async createBackup(projectId: string, label?: string): Promise<Job> {
    const data = await this.request<{ job: Job }>(
      "POST",
      `/v1/projects/${encodeURIComponent(projectId)}/backups`,
      { body: label !== undefined ? { label } : {} },
    );
    return data.job;
  }

  async listBackups(projectId: string): Promise<Backup[]> {
    const data = await this.request<{ backups: Backup[] | null }>(
      "GET",
      `/v1/projects/${encodeURIComponent(projectId)}/backups`,
    );
    return data.backups ?? [];
  }

  async createExport(projectId: string): Promise<{ export_id: string; job: Job }> {
    return this.request<{ export_id: string; job: Job }>(
      "POST",
      `/v1/projects/${encodeURIComponent(projectId)}/exports`,
    );
  }

  async listExports(projectId: string): Promise<ProjectExport[]> {
    const data = await this.request<{ exports: ProjectExport[] | null }>(
      "GET",
      `/v1/projects/${encodeURIComponent(projectId)}/exports`,
    );
    return data.exports ?? [];
  }

  async getExportDownload(projectId: string, exportId: string): Promise<ExportDownload> {
    const data = await this.request<{ download: ExportDownload }>(
      "GET",
      `/v1/projects/${encodeURIComponent(projectId)}/exports/${encodeURIComponent(exportId)}/download`,
    );
    return data.download;
  }

  async listProjectExtensions(projectId: string): Promise<ProjectExtension[]> {
    const data = await this.request<{ extensions: ProjectExtension[] | null }>(
      "GET",
      `/v1/projects/${encodeURIComponent(projectId)}/extensions`,
    );
    return data.extensions ?? [];
  }

  async enableProjectExtension(projectId: string, name: string): Promise<Job> {
    const data = await this.request<{ job: Job }>(
      "POST",
      `/v1/projects/${encodeURIComponent(projectId)}/extensions`,
      { body: { name } },
    );
    return data.job;
  }

  async disableProjectExtension(projectId: string, name: string): Promise<Job> {
    const data = await this.request<{ job: Job }>(
      "DELETE",
      `/v1/projects/${encodeURIComponent(projectId)}/extensions/${encodeURIComponent(name)}`,
    );
    return data.job;
  }

  async updateProjectExtension(projectId: string, name: string): Promise<Job> {
    const data = await this.request<{ job: Job }>(
      "POST",
      `/v1/projects/${encodeURIComponent(projectId)}/extensions/${encodeURIComponent(name)}/update`,
    );
    return data.job;
  }

  async majorUpgradePreflight(projectId: string, targetMajor: number): Promise<Job> {
    const data = await this.request<{ job: Job }>(
      "POST",
      `/v1/projects/${encodeURIComponent(projectId)}/upgrade/major/preflight?target_major=${targetMajor}`,
    );
    return data.job;
  }

  async createRestore(projectId: string, body: CreateRestoreRequest): Promise<Job> {
    const data = await this.request<{ job: Job }>(
      "POST",
      `/v1/projects/${encodeURIComponent(projectId)}/restores`,
      { body },
    );
    return data.job;
  }

  async createImport(projectId: string, body: CreateImportRequest): Promise<Job> {
    const data = await this.request<{ job: Job }>(
      "POST",
      `/v1/projects/${encodeURIComponent(projectId)}/imports`,
      { body },
    );
    return data.job;
  }

  async runImportPreflight(projectId: string, sourceUrl: string): Promise<ImportPreflightResult> {
    const data = await this.request<{ preflight: ImportPreflightResult }>(
      "POST",
      `/v1/projects/${encodeURIComponent(projectId)}/imports/preflight`,
      { body: { source_url: sourceUrl } },
    );
    return data.preflight;
  }

  // ---- Studio (SQL + data browser) ------------------------------------------

  /**
   * Runs a statement against the project database.
   *
   * Two things happen here that the caller does not ask for:
   *
   * 1. The statement is tagged with a sqlcommenter comment identifying it as
   *    agent traffic, so the project's SQL history can separate "an agent did
   *    this" from "the application did this" - the first question anyone asks
   *    when a statement is a surprise.
   *
   *    Note this does NOT yet separate the two in query STATISTICS:
   *    pg_stat_statements derives its identifier from the parse tree, so a
   *    tagged statement merges into the same entry as an identically shaped
   *    untagged one. Making the stats layer tag-aware is separate work; the
   *    tag is written now so the history is right and the stats can catch up.
   * 2. `allow_unqualified_writes` is never set. The control plane refuses an
   *    UPDATE or DELETE with no WHERE and any TRUNCATE unless a caller opts
   *    out, and an agent is precisely the caller that must not.
   */
  async runSql(projectId: string, body: SQLQueryRequest): Promise<SQLQueryResult> {
    const data = await this.request<{ result: SQLQueryResult }>(
      "POST",
      `/v1/projects/${encodeURIComponent(projectId)}/sql`,
      { body: { ...body, query: tagQuery(body.query) } },
    );
    return data.result;
  }

  async listTables(projectId: string): Promise<DatabaseTable[]> {
    const data = await this.request<{ tables: DatabaseTable[] | null }>(
      "GET",
      `/v1/projects/${encodeURIComponent(projectId)}/tables`,
    );
    return data.tables ?? [];
  }

  async getTableRows(
    projectId: string,
    schema: string,
    table: string,
    limit?: number,
  ): Promise<TableRowsResult> {
    const data = await this.request<{ result: TableRowsResult }>(
      "GET",
      `/v1/projects/${encodeURIComponent(projectId)}/tables/${encodeURIComponent(schema)}/${encodeURIComponent(table)}/rows`,
      { query: { limit } },
    );
    return data.result;
  }

  // ---- Observability + jobs --------------------------------------------------

  async getObservability(projectId: string): Promise<ProjectObservability> {
    const data = await this.request<{ observability: ProjectObservability }>(
      "GET",
      `/v1/projects/${encodeURIComponent(projectId)}/observability`,
    );
    return data.observability;
  }

  /**
   * Index suggestions derived from the predicates the project's queries actually ran. Read-only:
   * candidates are costed as hypothetical indexes, so nothing is created on the database.
   */
  async getIndexAdvisor(
    projectId: string,
    options: { minFilter?: number; minSelectivity?: number } = {},
  ): Promise<IndexAdvisorReport> {
    const params = new URLSearchParams();
    if (options.minFilter !== undefined) params.set("min_filter", String(options.minFilter));
    if (options.minSelectivity !== undefined) {
      params.set("min_selectivity", String(options.minSelectivity));
    }
    const query = params.size > 0 ? `?${params.toString()}` : "";
    const data = await this.request<{ advisor: IndexAdvisorReport }>(
      "GET",
      `/v1/projects/${encodeURIComponent(projectId)}/advisor/indexes${query}`,
    );
    return {
      ...data.advisor,
      missing_extensions: data.advisor.missing_extensions ?? [],
      suggestions: data.advisor.suggestions ?? [],
    };
  }

  /**
   * Indexes the database is paying for without using: never scanned, or covered by a wider index.
   * Read-only, and unlike getIndexAdvisor it needs no extension.
   */
  async getIndexHygiene(projectId: string): Promise<IndexHygieneReport> {
    const data = await this.request<{ hygiene: IndexHygieneReport }>(
      "GET",
      `/v1/projects/${encodeURIComponent(projectId)}/advisor/index-hygiene`,
    );
    return {
      ...data.hygiene,
      unused_indexes: data.hygiene.unused_indexes ?? [],
      redundant_indexes: data.hygiene.redundant_indexes ?? [],
    };
  }

  async getProjectLogs(
    projectId: string,
    options: { hours?: number; severity?: string; limit?: number; cursor?: string } = {},
  ): Promise<ProjectLogs> {
    const data = await this.request<{ logs: ProjectLogs }>(
      "GET",
      `/v1/projects/${encodeURIComponent(projectId)}/logs`,
      {
        query: {
          hours: options.hours,
          severity: options.severity,
          limit: options.limit,
          cursor: options.cursor,
        },
      },
    );
    return { ...data.logs, entries: data.logs.entries ?? [] };
  }

  async listProjectAlerts(projectId: string): Promise<ProjectAlert[]> {
    const data = await this.request<{ alerts: ProjectAlert[] | null }>(
      "GET",
      `/v1/projects/${encodeURIComponent(projectId)}/alerts`,
    );
    return data.alerts ?? [];
  }

  async acknowledgeProjectAlert(projectId: string, alertId: string): Promise<ProjectAlert> {
    const data = await this.request<{ alert: ProjectAlert }>(
      "POST",
      `/v1/projects/${encodeURIComponent(projectId)}/alerts/${encodeURIComponent(alertId)}/acknowledge`,
    );
    return data.alert;
  }

  async getJob(jobId: string): Promise<Job> {
    const data = await this.request<{ job: Job }>("GET", `/v1/jobs/${encodeURIComponent(jobId)}`);
    return data.job;
  }

  async listJobs(projectId: string, limit?: number): Promise<Job[]> {
    const data = await this.request<{ jobs: Job[] | null }>(
      "GET",
      `/v1/projects/${encodeURIComponent(projectId)}/jobs`,
      { query: { limit } },
    );
    return data.jobs ?? [];
  }

  // ---- Schema & type generation ---------------------------------------------

  async getProjectSchema(projectId: string): Promise<DatabaseSchema> {
    const data = await this.request<{ schema: DatabaseSchema }>(
      "GET",
      `/v1/projects/${encodeURIComponent(projectId)}/schema`,
    );
    return data.schema;
  }

  async getPreviewSchema(previewId: string): Promise<DatabaseSchema> {
    const data = await this.request<{ schema: DatabaseSchema }>(
      "GET",
      `/v1/preview-databases/${encodeURIComponent(previewId)}/schema`,
    );
    return data.schema;
  }

  async generateProjectSchemaTypes(
    projectId: string,
    language?: string,
    style?: string,
  ): Promise<GeneratedTypes> {
    const data = await this.request<{ types: GeneratedTypes }>(
      "GET",
      `/v1/projects/${encodeURIComponent(projectId)}/schema/types`,
      { query: { language, style } },
    );
    return data.types;
  }

  async generatePreviewSchemaTypes(
    previewId: string,
    language?: string,
    style?: string,
  ): Promise<GeneratedTypes> {
    const data = await this.request<{ types: GeneratedTypes }>(
      "GET",
      `/v1/preview-databases/${encodeURIComponent(previewId)}/schema/types`,
      { query: { language, style } },
    );
    return data.types;
  }

  // ---- Restore points --------------------------------------------------------

  async listRestorePoints(
    projectId: string,
  ): Promise<{ restore_points: RestorePoint[]; pitr_window_days: number }> {
    const data = await this.request<{
      restore_points: RestorePoint[] | null;
      pitr_window_days: number;
    }>("GET", `/v1/projects/${encodeURIComponent(projectId)}/restore-points`);
    return {
      restore_points: data.restore_points ?? [],
      pitr_window_days: data.pitr_window_days,
    };
  }

  async createRestorePoint(
    projectId: string,
    body: CreateRestorePointRequest,
  ): Promise<RestorePoint> {
    const data = await this.request<{ restore_point: RestorePoint }>(
      "POST",
      `/v1/projects/${encodeURIComponent(projectId)}/restore-points`,
      { body },
    );
    return data.restore_point;
  }

  async deleteRestorePoint(projectId: string, restorePointId: string): Promise<void> {
    await this.request<unknown>(
      "DELETE",
      `/v1/projects/${encodeURIComponent(projectId)}/restore-points/${encodeURIComponent(restorePointId)}`,
    );
  }

  // ---- K/V stores ----------------------------------------------------------

  async listKVStores(organizationId?: string): Promise<KVStore[]> {
    const query =
      organizationId === undefined ? "" : `?organization_id=${encodeURIComponent(organizationId)}`;
    const data = await this.request<{ kv_stores: KVStore[] | null }>("GET", `/v1/kv${query}`);
    return data.kv_stores ?? [];
  }

  async getKVStore(projectId: string): Promise<KVStore> {
    return await this.request<KVStore>("GET", `/v1/projects/${encodeURIComponent(projectId)}/kv`);
  }

  /**
   * Provisions the store. The response carries the plaintext token exactly
   * once; only its SHA-256 hash is stored, so it cannot be fetched again.
   */
  async createKVStore(projectId: string): Promise<{ kv_store: KVStore; job: Job }> {
    return await this.request("POST", `/v1/projects/${encodeURIComponent(projectId)}/kv`, {
      body: {},
    });
  }

  /** Endpoints without the secret: `token_required` says the token is not readable. */
  async getKVCredentials(projectId: string): Promise<KVCredentials> {
    return await this.request<KVCredentials>(
      "GET",
      `/v1/projects/${encodeURIComponent(projectId)}/kv/credentials`,
    );
  }
}

/** The control plane returns `{ "error": "<message>" }` for failures. */
function extractErrorMessage(body: string, status: number): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "error" in parsed &&
      typeof (parsed as { error: unknown }).error === "string"
    ) {
      return (parsed as { error: string }).error;
    }
  } catch {
    // Not JSON - fall through to the generic message.
  }
  return body.length > 0 ? `HTTP ${status}: ${body.slice(0, 500)}` : `HTTP ${status}`;
}
