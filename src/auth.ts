/**
 * Credential resolution and first-run browser device login.
 *
 * Key precedence:
 * 1. `CAPYDB_API_KEY` environment variable - always wins (headless/CI).
 * 2. The CapyDB CLI's saved credentials (active organization) from the shared
 *    user config file, so the CLI and the MCP server share one credential and
 *    one revocation point.
 * 3. Browser device login: the first tool call starts a login session and
 *    returns the approval URL as the tool result; a background poller waits
 *    for approval, then the minted key is persisted back into the CLI config.
 *
 * The config file location and JSON schema mirror the Go CLI exactly
 * (`cli/internal/config/config.go`): Go's `os.UserConfigDir()` plus
 * `capydb/config.json` - `~/Library/Application Support` on macOS, `%AppData%`
 * on Windows, `$XDG_CONFIG_HOME` (default `~/.config`) elsewhere.
 */

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";

import { DEFAULT_API_URL } from "./client.js";

const DEFAULT_APP_URL = "https://capydb.dev";

/** Org map key for credentials saved without a known organization id. */
const DEFAULT_ORG_KEY = "default";

/** Login sessions live 10 minutes server-side. */
const LOGIN_SESSION_FALLBACK_TTL_MS = 10 * 60_000;
/** Background poll cadence while waiting for browser approval. */
const LOGIN_POLL_INTERVAL_MS = 2_000;
/** How long a retried tool call waits for a pending approval before re-returning the URL. */
const RETRY_WAIT_MS = 25_000;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One organization's saved credentials - mirrors the CLI's `OrganizationConfig`.
 *
 * `api_key` is optional because the CLI's `Active()` returns an entry whatever it
 * holds: an entry can carry only endpoint configuration (`api_url`/`app_url`).
 * Dropping those entries is what used to hide the saved dashboard origin from the
 * device login, which then derived a 404ing approval URL.
 */
interface OrganizationEntry {
  api_key?: string;
  api_url?: string;
  app_url?: string;
  name?: string;
  slug?: string;
}

/** The CLI's `UserConfig` shape (legacy single-credential files are converted on read). */
interface StoredConfig {
  active_org?: string;
  organizations: Record<string, OrganizationEntry>;
}

interface PendingLogin {
  sessionId: string;
  pollToken: string;
  /** Epoch milliseconds when the login session itself expires. */
  expiresAt: number;
  approvalUrl: string;
}

export type EnsureResult = { ok: true; apiKey: string } | { ok: false; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function trimUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed !== "" ? trimmed : undefined;
}

/** Mirrors Go's `os.UserConfigDir()` + `capydb/config.json` - the CLI's config path. */
export function userConfigPath(): string {
  switch (process.platform) {
    case "darwin":
      return join(homedir(), "Library", "Application Support", "capydb", "config.json");
    case "win32": {
      const appData = nonEmpty(process.env["AppData"]) ?? join(homedir(), "AppData", "Roaming");
      return join(appData, "capydb", "config.json");
    }
    default: {
      const base = nonEmpty(process.env["XDG_CONFIG_HOME"]) ?? join(homedir(), ".config");
      return join(base, "capydb", "config.json");
    }
  }
}

/**
 * Dashboard origin for approval URLs - mirrors the CLI's `UserConfig.AppURL()`:
 * `CAPYDB_APP_URL` env, else the `app_url` saved beside the credential, else
 * `DefaultAppURL(apiURL)` - strip the `/api/capydb` suffix from the API URL,
 * else the API URL origin itself, else capydb.dev.
 *
 * The saved value has to outrank the derivation: an API URL is not always a path
 * under the dashboard origin (`https://api.capydb.dev` is a sibling host), and
 * deriving from one that is not yields an approval link that 404s.
 *
 * `CAPYDB_APP_URL` outranks the saved value, unlike the CLI - here the env var is
 * the documented override for pointing at another deployment; see the caller in
 * `AuthManager.create()`, which also drops a saved `app_url` that no longer pairs
 * with the API URL in use.
 */
export function dashboardUrl(apiUrl: string, savedAppUrl?: string): string {
  const fromEnv = nonEmpty(process.env["CAPYDB_APP_URL"]);
  if (fromEnv !== undefined) return trimUrl(fromEnv);
  const fromConfig = nonEmpty(savedAppUrl);
  if (fromConfig !== undefined) return trimUrl(fromConfig);
  const trimmed = trimUrl(apiUrl);
  if (trimmed.endsWith("/api/capydb")) return trimmed.slice(0, -"/api/capydb".length);
  if (trimmed !== "") return trimmed;
  return DEFAULT_APP_URL;
}

function approvalMessage(url: string): string {
  return (
    `CapyDB needs a one-time approval. Ask the user to open: ${url} - then retry this tool. ` +
    "The approval link expires in 10 minutes; once approved, the minted API key is saved to " +
    "the CapyDB CLI config and no further approval is needed."
  );
}

/**
 * Reads the CLI config file. Returns undefined when the file does not exist or
 * holds no usable credential. Throws on unreadable or malformed files.
 */
async function readStoredConfig(path: string): Promise<StoredConfig | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isRecord(error) && error["code"] === "ENOENT") return undefined;
    throw new Error(
      `read CapyDB config ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`CapyDB config ${path} is not valid JSON`, { cause });
  }
  if (!isRecord(parsed)) {
    throw new Error(`CapyDB config ${path} has an unexpected shape (expected a JSON object)`);
  }

  const organizations: Record<string, OrganizationEntry> = {};
  const rawOrgs = parsed["organizations"];
  if (isRecord(rawOrgs)) {
    for (const [orgId, value] of Object.entries(rawOrgs)) {
      if (!isRecord(value)) continue;
      const entry: OrganizationEntry = {
        api_url: optionalString(value["api_url"]),
        app_url: optionalString(value["app_url"]),
        name: optionalString(value["name"]),
        slug: optionalString(value["slug"]),
      };
      const apiKey = nonEmpty(optionalString(value["api_key"]));
      if (apiKey !== undefined) entry.api_key = apiKey;
      // Keep credential-less entries: their api_url/app_url still describe which
      // deployment to talk to and which dashboard to send the user to.
      if (apiKey === undefined && entry.api_url === undefined && entry.app_url === undefined) {
        continue;
      }
      organizations[orgId] = entry;
    }
  }
  if (Object.keys(organizations).length > 0) {
    return { active_org: optionalString(parsed["active_org"]), organizations };
  }

  // Legacy pre-multi-org shape: a flat single-credential object. Read it
  // compatibly but never write it back - the CLI owns that migration.
  const legacyKey = nonEmpty(optionalString(parsed["api_key"]));
  const legacyApiUrl = optionalString(parsed["api_url"]);
  const legacyAppUrl = optionalString(parsed["app_url"]);
  if (legacyKey === undefined && legacyApiUrl === undefined && legacyAppUrl === undefined) {
    return undefined;
  }
  const legacyOrgId = nonEmpty(optionalString(parsed["organization_id"])) ?? DEFAULT_ORG_KEY;
  return {
    active_org: legacyOrgId,
    organizations: {
      [legacyOrgId]: {
        api_key: legacyKey,
        api_url: optionalString(parsed["api_url"]),
        app_url: optionalString(parsed["app_url"]),
        name: optionalString(parsed["organization_name"]),
        slug: optionalString(parsed["organization_slug"]),
      },
    },
  };
}

/** Active-organization selection - mirrors the CLI's `UserConfig.Active()`. */
function activeOrganization(config: StoredConfig): OrganizationEntry | undefined {
  const ids = Object.keys(config.organizations);
  if (ids.length === 0) return undefined;
  if (config.active_org !== undefined) {
    const entry = config.organizations[config.active_org];
    if (entry !== undefined) return entry;
  }
  // Self-heal a dangling active_org when exactly one entry exists.
  if (ids.length === 1 && ids[0] !== undefined) return config.organizations[ids[0]];
  return undefined;
}

export class AuthManager {
  /** Resolved control plane base URL (no trailing slash). */
  readonly apiUrl: string;
  /** Resolved dashboard origin for approval URLs (no trailing slash). */
  readonly appUrl: string;

  private cachedKey: string | undefined;
  private pending: PendingLogin | undefined;
  private readonly source: "env" | "config" | "none";

  private constructor(
    apiUrl: string,
    appUrl: string,
    apiKey: string | undefined,
    source: "env" | "config" | "none",
  ) {
    this.apiUrl = trimUrl(apiUrl);
    this.appUrl = appUrl;
    this.cachedKey = apiKey;
    this.source = source;
  }

  /** Resolves env + saved CLI credentials. Never fails on a missing credential. */
  static async create(): Promise<AuthManager> {
    const envKey = nonEmpty(process.env["CAPYDB_API_KEY"]);
    const envUrl = nonEmpty(process.env["CAPYDB_API_URL"]);

    if (envKey !== undefined) {
      const apiUrl = envUrl ?? DEFAULT_API_URL;
      return new AuthManager(apiUrl, dashboardUrl(apiUrl), envKey, "env");
    }

    let stored: OrganizationEntry | undefined;
    try {
      const config = await readStoredConfig(userConfigPath());
      if (config !== undefined) stored = activeOrganization(config);
    } catch (error) {
      console.error(
        `capydb-mcp: ignoring unreadable CLI config: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const apiUrl = envUrl ?? nonEmpty(stored?.api_url) ?? DEFAULT_API_URL;
    // A saved `app_url` describes the dashboard paired with the saved `api_url`.
    // When CAPYDB_API_URL retargets the control plane somewhere else (staging, a
    // self-hosted deployment) that pairing no longer holds, so fall back to
    // deriving from the URL actually in use - otherwise a login session opened on
    // one deployment is advertised with a link to another one's dashboard.
    const savedAppUrl =
      envUrl === undefined || trimUrl(envUrl) === trimUrl(stored?.api_url ?? "")
        ? stored?.app_url
        : undefined;
    // `source` describes the credential, so a config that held only endpoint
    // configuration still counts as "none" - the first tool call starts a login.
    const source = stored?.api_key !== undefined ? "config" : "none";
    return new AuthManager(apiUrl, dashboardUrl(apiUrl, savedAppUrl), stored?.api_key, source);
  }

  /** Human-readable credential source, for startup diagnostics on stderr. */
  describe(): string {
    switch (this.source) {
      case "env":
        return "CAPYDB_API_KEY";
      case "config":
        return `CLI config ${userConfigPath()}`;
      case "none":
        return "none - the first tool call will start a browser device login";
    }
  }

  /** The key for the current request. Only valid after ensure() returned ok. */
  apiKey(): string {
    if (this.cachedKey === undefined) {
      throw new Error("CapyDB MCP server is not authenticated yet");
    }
    return this.cachedKey;
  }

  /**
   * Resolves a usable API key, starting (or waiting briefly on) a browser
   * device login when none is available. Tool calls gate on this: a `false`
   * result carries the approval message to relay to the user.
   */
  async ensure(): Promise<EnsureResult> {
    if (this.cachedKey !== undefined) return { ok: true, apiKey: this.cachedKey };

    if (this.pending !== undefined) {
      const key = await this.waitForPending(RETRY_WAIT_MS);
      if (key !== undefined) return { ok: true, apiKey: key };
      if (this.pending !== undefined) {
        return { ok: false, message: approvalMessage(this.pending.approvalUrl) };
      }
      // The pending session expired while waiting - fall through to a new one.
    }

    // Pick up a credential saved since startup (e.g. the user ran `capydb auth login`).
    try {
      const config = await readStoredConfig(userConfigPath());
      const entry = config !== undefined ? activeOrganization(config) : undefined;
      if (entry?.api_key !== undefined) {
        this.cachedKey = entry.api_key;
        return { ok: true, apiKey: entry.api_key };
      }
    } catch {
      // Unreadable config was already reported at startup; device login still works.
    }

    const pending = await this.startLoginSession();
    this.pending = pending;
    void this.pollLoginSession(pending);
    return { ok: false, message: approvalMessage(pending.approvalUrl) };
  }

  /** Waits for the background poller, checking once a second. */
  private async waitForPending(maxWaitMs: number): Promise<string | undefined> {
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      if (this.cachedKey !== undefined) return this.cachedKey;
      if (this.pending === undefined) return undefined;
      await sleep(1_000);
    }
    return this.cachedKey;
  }

  private async startLoginSession(): Promise<PendingLogin> {
    let response: Response;
    try {
      response = await fetch(`${this.apiUrl}/v1/cli/login/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          name: "MCP session",
          device_name: hostname(),
          source: "agent",
        }),
      });
    } catch (cause) {
      throw new Error(`CapyDB device login could not start: ${String(cause)}`, { cause });
    }
    if (!response.ok) {
      throw new Error(`CapyDB device login could not start: HTTP ${response.status}`);
    }

    const parsed: unknown = await response.json();
    if (!isRecord(parsed)) {
      throw new Error("CapyDB device login response had an unexpected shape");
    }
    const sessionId = nonEmpty(optionalString(parsed["session_id"]));
    const pollToken = nonEmpty(optionalString(parsed["poll_token"]));
    if (sessionId === undefined || pollToken === undefined) {
      throw new Error("CapyDB device login response had an unexpected shape");
    }
    const expiresAtRaw = optionalString(parsed["expires_at"]);
    const expiresAtParsed = expiresAtRaw !== undefined ? Date.parse(expiresAtRaw) : Number.NaN;
    const expiresAt = Number.isNaN(expiresAtParsed)
      ? Date.now() + LOGIN_SESSION_FALLBACK_TTL_MS
      : expiresAtParsed;

    const approvalUrl = `${this.appUrl}/dashboard/cli/login?session=${encodeURIComponent(sessionId)}`;
    console.error(`capydb-mcp: device login started - approve at ${approvalUrl}`);
    return { sessionId, pollToken, expiresAt, approvalUrl };
  }

  /** Background poller: every 2s until approval or session expiry. */
  private async pollLoginSession(pending: PendingLogin): Promise<void> {
    while (this.pending === pending && Date.now() < pending.expiresAt) {
      await sleep(LOGIN_POLL_INTERVAL_MS);
      if (this.pending !== pending) return;

      let response: Response;
      try {
        // Poll token travels in a header so the sole secret gating key
        // delivery never lands in server/proxy access logs.
        response = await fetch(
          `${this.apiUrl}/v1/cli/login/sessions/${encodeURIComponent(pending.sessionId)}`,
          { headers: { accept: "application/json", "x-capydb-poll-token": pending.pollToken } },
        );
      } catch (error) {
        console.error(
          `capydb-mcp: device login poll failed (will retry): ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }

      if (response.status === 404 || response.status === 410) {
        // Gone or expired server-side - clear the session so the next call starts fresh.
        if (this.pending === pending) this.pending = undefined;
        console.error("capydb-mcp: device login session expired before approval");
        return;
      }
      if (!response.ok) {
        console.error(
          `capydb-mcp: device login poll returned HTTP ${response.status} (will retry)`,
        );
        continue;
      }

      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch {
        console.error("capydb-mcp: device login poll returned invalid JSON (will retry)");
        continue;
      }
      if (!isRecord(parsed) || parsed["state"] !== "completed") continue;

      const apiKey = nonEmpty(optionalString(parsed["plaintext_api_key"]));
      if (apiKey === undefined) {
        // The plaintext key is delivered exactly once; without it the session is unusable.
        if (this.pending === pending) this.pending = undefined;
        console.error(
          "capydb-mcp: device login completed but the poll response carried no API key",
        );
        return;
      }

      this.cachedKey = apiKey;
      if (this.pending === pending) this.pending = undefined;
      console.error("capydb-mcp: device login approved - API key minted");

      try {
        await this.persistCredentials({
          apiKey,
          organizationId: optionalString(parsed["organization_id"]),
          organizationName: optionalString(parsed["organization_name"]),
          organizationSlug: optionalString(parsed["organization_slug"]),
        });
        console.error(`capydb-mcp: credentials saved to ${userConfigPath()}`);
      } catch (error) {
        // The key still works for this process; persisting it is best-effort.
        console.error(
          `capydb-mcp: could not save credentials to ${userConfigPath()}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return;
    }

    if (this.pending === pending) {
      this.pending = undefined;
      console.error("capydb-mcp: device login session expired before approval");
    }
  }

  /** Merges the minted key into the CLI config file without clobbering other orgs. */
  private async persistCredentials(options: {
    apiKey: string;
    organizationId: string | undefined;
    organizationName: string | undefined;
    organizationSlug: string | undefined;
  }): Promise<void> {
    const path = userConfigPath();
    let existing: StoredConfig | undefined;
    try {
      existing = await readStoredConfig(path);
    } catch (error) {
      // An unreadable file is replaced - the credential it held was unusable anyway.
      console.error(
        `capydb-mcp: replacing unreadable CLI config: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const orgId = nonEmpty(options.organizationId) ?? DEFAULT_ORG_KEY;
    const entry: OrganizationEntry = {
      api_key: options.apiKey,
      api_url: this.apiUrl,
      app_url: this.appUrl,
    };
    const name = nonEmpty(options.organizationName);
    if (name !== undefined) entry.name = name;
    const slug = nonEmpty(options.organizationSlug);
    if (slug !== undefined) entry.slug = slug;

    const config: StoredConfig = {
      active_org: orgId,
      organizations: { ...existing?.organizations, [orgId]: entry },
    };

    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    // writeFile's mode only applies on creation; enforce 0600 on existing files too.
    await chmod(path, 0o600);
  }
}
