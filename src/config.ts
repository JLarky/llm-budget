import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import * as v from "valibot";
import { ConfigFileSchema } from "./config-schema.js";
import type { JsonValue } from "./json-value.js";
import { parseJsonc } from "./jsonc.js";
import { configPath } from "./paths.js";

/**
 * One config, one parser, shared by Claude Code, Codex, and Cursor Agent.
 *
 * Every gate is a percent window: `blockAtPercent` is a number to enforce at
 * that threshold, or `null` for monitor-only (measured and shown in status,
 * never blocks). Window names match what the vendor calls them, so this file
 * and status output always agree. There is no inheritance between windows —
 * each one is independent.
 */

export interface WindowConfig {
  blockAtPercent: number | null;
}

export interface ClaudeConfig {
  enabled: boolean;
  windows: {
    /** Anthropic's 7-day rolling cap. */
    weekly: WindowConfig;
    /** Anthropic's rolling 5-hour session cap. */
    five_hour: WindowConfig;
  };
  /**
   * When a refresh fails (HTTP 429, outage, waiting on another process), the
   * last good reading is gated on until it is this old (ms); beyond it usage
   * counts as unknown and failClosed decides.
   */
  maxStaleMs: number;
}

export interface CodexConfig {
  enabled: boolean;
  windows: {
    /** OpenAI's weekly rate-limit window. */
    weekly: WindowConfig;
    /**
     * OpenAI's rolling 5-hour session window. OpenAI publishes no hard cap
     * for it, so it ships monitor-only (`null`) — set a number to enforce it.
     */
    session: WindowConfig;
  };
  /** Same as {@link ClaudeConfig.maxStaleMs}, for the OpenAI usage reading. */
  maxStaleMs: number;
}

export interface CursorConfig {
  enabled: boolean;
  windows: {
    /** Dashboard "Cursor Models" (auto) meter. */
    cursorModels: WindowConfig;
    /** Dashboard "Other Models" (api) meter. */
    otherModels: WindowConfig;
    /** Combined spend meter across both. */
    total: WindowConfig;
  };
  /** Rolling-hour event count: a runaway-loop backstop, not a budget. `null` disables. */
  rateLimit: { maxEventsPerHour: number | null };
  /** Beyond this age a cached snapshot counts as unknown usage. */
  maxStaleMs: number;
  /** Soft TTL before a hook process refreshes over the network. */
  cacheTtlMs: number;
  /** Fractions (0–1) of each window's block threshold that fire a desktop notification. */
  warnings: number[];
  excludeConversationIds: string[];
}

export interface GrokConfig {
  enabled: boolean;
  windows: {
    /**
     * xAI's weekly credit pool. Ships enforced at 80 (this product is a
     * guard, not a monitor). A missing percent with a billing period is
     * treated as 0% with a status warning. It does not fail closed.
     */
    weekly: WindowConfig;
  };
  /** Grok session ids that bypass the Grok gate only. */
  excludeSessionIds: string[];
}

export interface Config {
  claude: ClaudeConfig;
  codex: CodexConfig;
  cursor: CursorConfig;
  grok: GrokConfig;
  enforcement: {
    /**
     * When usage cannot be determined (API unreachable, auth expired, stale
     * cache), block instead of allowing. Applies to every agent. Escape
     * hatches (override, exceptions) stay open regardless.
     */
    failClosed: boolean;
  };
  /** Claude Code / Codex session ids that bypass those gates. */
  excludeSessionIds: string[];
}

export const DEFAULT_CONFIG: Config = {
  claude: {
    enabled: true,
    windows: {
      weekly: { blockAtPercent: 80 },
      five_hour: { blockAtPercent: 80 },
    },
    maxStaleMs: 600_000,
  },
  codex: {
    enabled: true,
    windows: {
      weekly: { blockAtPercent: 80 },
      session: { blockAtPercent: null },
    },
    maxStaleMs: 600_000,
  },
  cursor: {
    enabled: true,
    windows: {
      cursorModels: { blockAtPercent: 90 },
      otherModels: { blockAtPercent: 90 },
      total: { blockAtPercent: null },
    },
    rateLimit: { maxEventsPerHour: 500 },
    maxStaleMs: 3_600_000,
    cacheTtlMs: 90_000,
    warnings: [0.5, 0.75, 0.9],
    excludeConversationIds: [],
  },
  grok: {
    enabled: true,
    windows: {
      weekly: { blockAtPercent: 80 },
    },
    excludeSessionIds: [],
  },
  enforcement: { failClosed: true },
  excludeSessionIds: [],
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function resolveWindow(
  raw: { blockAtPercent?: number | null } | undefined,
  fallback: WindowConfig,
): WindowConfig {
  if (!raw || raw.blockAtPercent === undefined) return fallback;
  return { blockAtPercent: raw.blockAtPercent };
}

/** Parse + validate a raw config file object into a fully-resolved config. */
export function parseConfig(raw: JsonValue | Config): Config {
  let parsed: v.InferOutput<typeof ConfigFileSchema>;
  try {
    parsed = v.parse(ConfigFileSchema, raw);
  } catch (error) {
    if (error instanceof v.ValiError) {
      throw new ConfigError(`Invalid config.jsonc:\n${v.summarize(error.issues)}`);
    }
    throw error;
  }

  return {
    claude: {
      enabled: parsed.claude?.enabled ?? DEFAULT_CONFIG.claude.enabled,
      windows: {
        weekly: resolveWindow(parsed.claude?.windows?.weekly, DEFAULT_CONFIG.claude.windows.weekly),
        five_hour: resolveWindow(
          parsed.claude?.windows?.five_hour,
          DEFAULT_CONFIG.claude.windows.five_hour,
        ),
      },
      maxStaleMs: parsed.claude?.maxStaleMs ?? DEFAULT_CONFIG.claude.maxStaleMs,
    },
    codex: {
      enabled: parsed.codex?.enabled ?? DEFAULT_CONFIG.codex.enabled,
      windows: {
        weekly: resolveWindow(parsed.codex?.windows?.weekly, DEFAULT_CONFIG.codex.windows.weekly),
        session: resolveWindow(parsed.codex?.windows?.session, DEFAULT_CONFIG.codex.windows.session),
      },
      maxStaleMs: parsed.codex?.maxStaleMs ?? DEFAULT_CONFIG.codex.maxStaleMs,
    },
    cursor: {
      enabled: parsed.cursor?.enabled ?? DEFAULT_CONFIG.cursor.enabled,
      windows: {
        cursorModels: resolveWindow(
          parsed.cursor?.windows?.cursorModels,
          DEFAULT_CONFIG.cursor.windows.cursorModels,
        ),
        otherModels: resolveWindow(
          parsed.cursor?.windows?.otherModels,
          DEFAULT_CONFIG.cursor.windows.otherModels,
        ),
        total: resolveWindow(parsed.cursor?.windows?.total, DEFAULT_CONFIG.cursor.windows.total),
      },
      rateLimit: {
        maxEventsPerHour:
          parsed.cursor?.rateLimit?.maxEventsPerHour === undefined
            ? DEFAULT_CONFIG.cursor.rateLimit.maxEventsPerHour
            : parsed.cursor.rateLimit.maxEventsPerHour,
      },
      maxStaleMs: parsed.cursor?.maxStaleMs ?? DEFAULT_CONFIG.cursor.maxStaleMs,
      cacheTtlMs: parsed.cursor?.cacheTtlMs ?? DEFAULT_CONFIG.cursor.cacheTtlMs,
      warnings: parsed.cursor?.warnings ?? DEFAULT_CONFIG.cursor.warnings,
      excludeConversationIds: parsed.cursor?.excludeConversationIds ?? [],
    },
    grok: {
      enabled: parsed.grok?.enabled ?? DEFAULT_CONFIG.grok.enabled,
      windows: {
        weekly: resolveWindow(parsed.grok?.windows?.weekly, DEFAULT_CONFIG.grok.windows.weekly),
      },
      excludeSessionIds: parsed.grok?.excludeSessionIds ?? [],
    },
    enforcement: {
      failClosed: parsed.enforcement?.failClosed ?? DEFAULT_CONFIG.enforcement.failClosed,
    },
    excludeSessionIds: parsed.excludeSessionIds ?? [],
  };
}

function blockAt(w: WindowConfig): string {
  return w.blockAtPercent === null ? "null" : `${w.blockAtPercent}`;
}

/**
 * Render a fully-documented config.jsonc so the file doubles as schema docs.
 */
export function renderConfigFile(c: Config): string {
  const warnings = c.cursor.warnings.map((w) => `${w}`).join(", ");
  const cursorExcept = c.cursor.excludeConversationIds.map((id) => JSON.stringify(id)).join(", ");
  const grokExcept = c.grok.excludeSessionIds.map((id) => JSON.stringify(id)).join(", ");
  const llmExcept = c.excludeSessionIds.map((id) => JSON.stringify(id)).join(", ");
  return `// llm-budget configuration — JSONC, so comments and trailing commas are fine.
//
// Schema: every agent has "windows", one entry per vendor-reported usage
// window.
//
//   "blockAtPercent": <0-100>   Enforced — block once usage reaches this %.
//   "blockAtPercent": null      Monitor-only — measured and shown in
//                               status, never blocks.
//
// Window names match what the vendor calls them:
//   claude.windows.weekly         Anthropic's 7-day rolling cap.
//   claude.windows.five_hour      Anthropic's rolling 5-hour session cap.
//   codex.windows.weekly          OpenAI's weekly rate-limit window.
//   codex.windows.session         OpenAI's rolling 5-hour window — no
//                                 vendor-published hard cap, monitor-only by
//                                 default.
//   cursor.windows.cursorModels   Dashboard "Cursor Models" (auto) meter.
//   cursor.windows.otherModels    Dashboard "Other Models" (api) meter.
//   cursor.windows.total          Combined spend meter, monitor-only by default.
//   grok.windows.weekly           xAI's weekly credit pool. Enforced at 80 by
//                                 default. A missing percent is 0% plus a
//                                 warning, not fail-closed unknown usage.
{
  "claude": {
    // Gate Claude Code sessions at all?
    "enabled": ${c.claude.enabled},
    "windows": {
      "weekly": { "blockAtPercent": ${blockAt(c.claude.windows.weekly)} },
      "five_hour": { "blockAtPercent": ${blockAt(c.claude.windows.five_hour)} }
    },
    // If a usage refresh fails (e.g. HTTP 429), keep gating on the last good
    // reading until it is this old (ms); after that usage is unknown.
    "maxStaleMs": ${c.claude.maxStaleMs}
  },
  "codex": {
    // Gate Codex CLI sessions at all?
    "enabled": ${c.codex.enabled},
    "windows": {
      "weekly": { "blockAtPercent": ${blockAt(c.codex.windows.weekly)} },
      "session": { "blockAtPercent": ${blockAt(c.codex.windows.session)} }
    },
    // Same as claude.maxStaleMs, for the OpenAI usage reading.
    "maxStaleMs": ${c.codex.maxStaleMs}
  },
  "cursor": {
    // Gate Cursor Agent sessions at all?
    "enabled": ${c.cursor.enabled},
    "windows": {
      "cursorModels": { "blockAtPercent": ${blockAt(c.cursor.windows.cursorModels)} },
      "otherModels": { "blockAtPercent": ${blockAt(c.cursor.windows.otherModels)} },
      "total": { "blockAtPercent": ${blockAt(c.cursor.windows.total)} }
    },
    "rateLimit": {
      // Runaway-loop backstop: max hook events per rolling hour; null disables.
      "maxEventsPerHour": ${c.cursor.rateLimit.maxEventsPerHour === null ? "null" : c.cursor.rateLimit.maxEventsPerHour}
    },
    // Beyond this age (ms) a cached snapshot is treated as unknown usage.
    "maxStaleMs": ${c.cursor.maxStaleMs},
    // Soft TTL (ms) for the local snapshot cache before a network refresh.
    "cacheTtlMs": ${c.cursor.cacheTtlMs},
    // Warning fractions (0-1) of each Cursor window's block threshold.
    "warnings": [${warnings}],
    // Cursor Agent conversation ids that bypass every Cursor gate.
    "excludeConversationIds": [${cursorExcept}]
  },
  "grok": {
    // Gate Grok CLI sessions at all?
    "enabled": ${c.grok.enabled},
    "windows": {
      "weekly": { "blockAtPercent": ${blockAt(c.grok.windows.weekly)} }
    },
    // Grok session ids that bypass the Grok gate only.
    "excludeSessionIds": [${grokExcept}]
  },
  "enforcement": {
    // When usage cannot be determined (API down), block instead of allow.
    // Applies to every agent.
    "failClosed": ${c.enforcement.failClosed}
  },
  // Claude Code / Codex session ids that bypass those gates.
  "excludeSessionIds": [${llmExcept}]
}
`;
}

function withPath(path: string, detail: string): ConfigError {
  return new ConfigError(
    `${detail}\nConfig file: ${path}\nDelete this file to regenerate defaults.`,
  );
}

function readJsoncFile(path: string): JsonValue {
  const text = readFileSync(path, "utf8");
  if (!text.trim()) return {};
  return parseJsonc(text);
}

interface LoadedRaw {
  path: string;
  raw: JsonValue;
}

function loadRaw(home?: string): LoadedRaw {
  const path = configPath(home);
  if (!existsSync(path)) return { path, raw: {} };
  try {
    return { path, raw: readJsoncFile(path) };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw withPath(path, `Invalid config.jsonc (not JSONC): ${detail}`);
  }
}

function persist(home: string | undefined, config: Config): void {
  const path = configPath(home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, renderConfigFile(config));
}

export interface ConfigReadResult {
  config: Config;
  warning?: string;
}

/** Read + validate config, writing the documented default file on first run. */
export function ensureConfig(home?: string): Config {
  const { path, raw } = loadRaw(home);
  if (!existsSync(path)) {
    const config = structuredClone(DEFAULT_CONFIG);
    persist(home, config);
    return config;
  }
  try {
    return parseConfig(raw);
  } catch (error) {
    if (error instanceof ConfigError) throw withPath(path, error.message);
    throw error;
  }
}

/**
 * Read config for display only: falls back to defaults with a warning
 * instead of throwing. Never used on an enforcement path — `ensureConfig`
 * throws there so a broken file fails closed instead of silently guarding
 * with defaults.
 */
export function loadConfigForRead(home?: string): ConfigReadResult {
  try {
    return { config: ensureConfig(home) };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      config: structuredClone(DEFAULT_CONFIG),
      warning: `Warning: using defaults because config failed to load.\n${detail}`,
    };
  }
}

/** Persist a fully-resolved config. Writes exactly what is given — no merge with disk. */
export function writeConfig(config: Config, home?: string): void {
  persist(home, config);
}

/** Path + documented file for `llm-budget config`. */
export function formatConfigFile(home?: string): string {
  const { warning } = loadConfigForRead(home);
  const path = configPath(home);
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  const body = `${path}\n\n${text}`;
  return warning ? `${warning}\n\n${body}` : body;
}
