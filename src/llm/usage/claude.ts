import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { jsonString, parseJsonText, type JsonValue } from "../../json-value.js";
import { asRecord, fetchJson, finiteNumber, type FetchFn } from "./http.js";
import {
  errored,
  httpError,
  unavailable,
  type CallError,
  type ProviderUsage,
  type UsageWindow,
} from "./types.js";

const execFileAsync = promisify(execFile);

const CLAUDE_OAUTH_BETA = "oauth-2025-04-20";
const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";

export interface ClaudeFetchOptions {
  home?: string;
  claudeHome?: string;
  fetch?: FetchFn;
  timeoutMs?: number;
  platform?: NodeJS.Platform;
  keychainReader?: () => Promise<JsonValue | null>;
}

interface ClaudeOauth {
  accessToken: string;
  refreshToken?: string;
  subscriptionType?: string;
  rateLimitTier?: string;
}

interface ClaudeCreds {
  oauth: ClaudeOauth;
  /** Null when the token came from macOS Keychain — do not refresh/persist. */
  filePath: string | null;
}

function claudeHomeDir(options: ClaudeFetchOptions): string {
  return (
    options.claudeHome ||
    process.env.CLAUDE_HOME ||
    join(options.home ?? homedir(), ".claude")
  );
}

function planLabel(oauth: ClaudeOauth): string | null {
  if (!oauth.subscriptionType) return null;
  const label = oauth.subscriptionType.charAt(0).toUpperCase() + oauth.subscriptionType.slice(1);
  const tier = oauth.rateLimitTier?.split("_").pop();
  return tier ? `${label} ${tier}` : label;
}

function oauthFromUnknown(raw: JsonValue | null | undefined): ClaudeOauth | null {
  const root = asRecord(raw);
  const oauth = asRecord(root?.claudeAiOauth);
  const accessToken = jsonString(oauth?.accessToken)?.trim() ?? "";
  if (!oauth || !accessToken) return null;
  return {
    accessToken,
    refreshToken: jsonString(oauth.refreshToken) ?? undefined,
    subscriptionType: jsonString(oauth.subscriptionType) ?? undefined,
    rateLimitTier: jsonString(oauth.rateLimitTier) ?? undefined,
  };
}

async function readKeychain(): Promise<JsonValue | null> {
  try {
    const { stdout } = await execFileAsync(
      "security",
      ["find-generic-password", "-s", CLAUDE_KEYCHAIN_SERVICE, "-w"],
      { timeout: 2_000 },
    );
    const raw = stdout.trim();
    return raw ? parseJsonText(raw) : null;
  } catch {
    return null;
  }
}

async function readCredentials(options: ClaudeFetchOptions): Promise<ClaudeCreds | null> {
  const dir = claudeHomeDir(options);
  const filePath = join(dir, ".credentials.json");
  if (existsSync(filePath)) {
    try {
      const oauth = oauthFromUnknown(parseJsonText(readFileSync(filePath, "utf8")));
      if (oauth) return { oauth, filePath };
    } catch {
      // Fall through to Keychain on macOS.
    }
  }
  const platform = options.platform ?? process.platform;
  if (platform === "darwin") {
    const reader = options.keychainReader ?? readKeychain;
    const oauth = oauthFromUnknown(await reader());
    if (oauth) return { oauth, filePath: null };
  }
  return null;
}

function windowFromUtilization(
  id: string,
  label: string,
  raw: JsonValue | null | undefined,
): UsageWindow | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const usedPct = finiteNumber(rec.utilization);
  const resetsAt = jsonString(rec.resets_at);
  return { id, label, usedPct, resetsAt };
}

function windowsFromUsage(json: JsonValue | null | undefined): UsageWindow[] {
  const rec = asRecord(json);
  if (!rec) return [];
  const windows: UsageWindow[] = [];
  const session = windowFromUtilization("five_hour", "Session", rec.five_hour);
  const weekly = windowFromUtilization("weekly", "Weekly", rec.seven_day);
  if (session) windows.push(session);
  if (weekly) windows.push(weekly);
  return windows;
}

async function callUsage(
  token: string,
  options: ClaudeFetchOptions,
): Promise<{ kind: "ok"; json: JsonValue } | { kind: "auth" } | CallError> {
  try {
    const res = await fetchJson(
      USAGE_URL,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "anthropic-beta": CLAUDE_OAUTH_BETA,
        },
      },
      options,
    );
    if (res.status === 401 || res.status === 403) return { kind: "auth" };
    if (res.status < 200 || res.status >= 300) {
      return httpError("Claude usage API", res);
    }
    if (res.json == null) return { kind: "error", detail: "Claude usage API returned non-JSON" };
    return { kind: "ok", json: res.json };
  } catch (error) {
    return {
      kind: "error",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function refreshToken(
  refreshToken: string,
  options: ClaudeFetchOptions,
): Promise<{ accessToken: string; refreshToken?: string } | null> {
  try {
    const res = await fetchJson(
      TOKEN_URL,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: CLAUDE_CLIENT_ID,
          scope: "user:profile user:inference user:sessions:claude_code user:mcp_servers",
        }),
      },
      options,
    );
    const rec = asRecord(res.json);
    const accessToken = jsonString(rec?.access_token) ?? "";
    if (!res.status || res.status >= 300 || !accessToken) return null;
    return {
      accessToken,
      refreshToken: jsonString(rec?.refresh_token) ?? undefined,
    };
  } catch {
    return null;
  }
}

function saveCredentials(filePath: string, oauth: ClaudeOauth): void {
  try {
    const existing = asRecord(parseJsonText(readFileSync(filePath, "utf8"))) ?? {};
    const next = {
      ...existing,
      claudeAiOauth: {
        ...asRecord(existing.claudeAiOauth),
        accessToken: oauth.accessToken,
        refreshToken: oauth.refreshToken,
        subscriptionType: oauth.subscriptionType,
        rateLimitTier: oauth.rateLimitTier,
      },
    };
    writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  } catch {
    // Non-fatal: Claude Code can refresh on its own next time.
  }
}

/**
 * Read Claude Code's local OAuth creds and ask Anthropic for 5h + weekly
 * utilization. Does not refresh Keychain-backed tokens (that can log the
 * user out of Claude Code on macOS).
 */
export async function fetchClaudeUsage(options: ClaudeFetchOptions = {}): Promise<ProviderUsage> {
  const creds = await readCredentials(options);
  if (!creds) {
    return unavailable("claude", "Claude Code", "Claude Code is not signed in");
  }

  let token = creds.oauth.accessToken;
  let result = await callUsage(token, options);

  if (result.kind === "auth" && creds.filePath && creds.oauth.refreshToken) {
    const refreshed = await refreshToken(creds.oauth.refreshToken, options);
    if (refreshed) {
      token = refreshed.accessToken;
      saveCredentials(creds.filePath, {
        ...creds.oauth,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken ?? creds.oauth.refreshToken,
      });
      result = await callUsage(token, options);
    }
  }

  if (result.kind === "auth") {
    return unavailable("claude", "Claude Code", "Claude OAuth token expired");
  }
  if (result.kind === "error") {
    return errored("claude", "Claude Code", result.detail, result);
  }

  const windows = windowsFromUsage(result.json);
  if (windows.length === 0) {
    return errored("claude", "Claude Code", "Claude usage API returned no windows");
  }
  return {
    providerId: "claude",
    displayName: "Claude Code",
    status: "available",
    planLabel: planLabel(creds.oauth),
    windows,
    error: null,
  };
}
