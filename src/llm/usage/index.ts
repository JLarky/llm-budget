import { getState, openLlmDb, type DatabaseSync } from "../db.js";
import {
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_LEASE_TTL_MS,
  DEFAULT_MAX_STALE_MS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_WAIT_TIMEOUT_MS,
  getProviderUsageCached,
  writeCachedProvider,
  type CachePolicy,
} from "./cache.js";
import { fetchClaudeUsage } from "./claude.js";
import { fetchCodexUsage } from "./codex.js";
import { fetchCopilotUsage } from "./copilot.js";
import type { FetchFn } from "./http.js";
import type { ProviderUsage, UsageSnapshot } from "./types.js";

export type {
  ProviderUsage,
  UsageFetcher,
  UsageSnapshot,
  UsageWindow,
} from "./types.js";
export { emptySnapshot, errored, providerUsage, unavailable } from "./types.js";
export { fetchClaudeUsage } from "./claude.js";
export { fetchCodexUsage } from "./codex.js";
export { fetchCopilotUsage } from "./copilot.js";

export {
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_LEASE_TTL_MS,
  DEFAULT_MAX_STALE_MS,
  DEFAULT_WAIT_TIMEOUT_MS,
} from "./cache.js";

/** Pre-per-provider snapshot blob; superseded by the provider_usage_cache table. */
const LEGACY_CACHE_KEY = "provider_usage_v1";

export type UsageProviderId = "claude" | "codex" | "copilot";

const ALL_PROVIDERS: readonly UsageProviderId[] = ["claude", "codex", "copilot"];

const DISPLAY_NAMES = {
  claude: "Claude Code",
  codex: "Codex",
  copilot: "GitHub Copilot",
} satisfies Record<UsageProviderId, string>;

export interface FetchDirectUsageOptions {
  home?: string;
  /** Wall-clock base for cache timestamps; time still advances from it while waiting. */
  now?: Date;
  fetch?: FetchFn;
  timeoutMs?: number;
  cacheTtlMs?: number;
  forceRefresh?: boolean;
  db?: DatabaseSync;
  claudeHome?: string;
  codexHome?: string;
  copilotHome?: string;
  platform?: NodeJS.Platform;
  /** Which providers to resolve (default: all). Guards ask only for their own. */
  providers?: readonly UsageProviderId[];
  /** Per-provider max age of a good reading served when refresh fails. */
  maxStaleMs?: Partial<Record<UsageProviderId, number>>;
  /** Bound on waiting for another process's refresh. */
  waitTimeoutMs?: number;
  leaseTtlMs?: number;
  pollIntervalMs?: number;
  /** Test seam: monotonic-enough ms clock. Defaults to `now` advancing in real time. */
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Called as soon as each provider's usage is known, ahead of the combined return. */
  onProvider?: (usage: ProviderUsage) => void;
}

function fetcherFor(id: UsageProviderId, options: FetchDirectUsageOptions): () => Promise<ProviderUsage> {
  if (id === "claude") return () => fetchClaudeUsage(options);
  if (id === "codex") return () => fetchCodexUsage(options);
  return () => fetchCopilotUsage(options);
}

function policyFor(id: UsageProviderId, options: FetchDirectUsageOptions): CachePolicy {
  const base = options.now?.getTime();
  const start = Date.now();
  const clock = options.clock ?? (base === undefined ? Date.now : () => base + (Date.now() - start));
  return {
    ttlMs: options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS,
    maxStaleMs: options.maxStaleMs?.[id] ?? DEFAULT_MAX_STALE_MS,
    leaseTtlMs: options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS,
    waitTimeoutMs: options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS,
    pollIntervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    forceRefresh: options.forceRefresh ?? false,
    clock,
    sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  };
}

/**
 * Fetch Claude Code + Codex + GitHub Copilot usage from the vendor APIs.
 *
 * Never throws for expected failures: a missing login or a down API becomes
 * an `unavailable` / `error` provider entry so the guard can fail closed.
 * Each provider is cached separately in the llm-budget sqlite store (no
 * tokens stored) and refreshed by at most one process at a time; see
 * `cache.ts` for the lease, backoff, and stale-fallback rules.
 */
export async function fetchDirectUsage(
  options: FetchDirectUsageOptions = {},
): Promise<UsageSnapshot> {
  const db = options.db ?? openLlmDb(options.home);
  const ids = options.providers ?? ALL_PROVIDERS;
  dropLegacyUsageCache(db);
  const providers = await Promise.all(
    ids.map(async (id) => {
      const usage = await getProviderUsageCached(
        db,
        id,
        DISPLAY_NAMES[id],
        fetcherFor(id, options),
        policyFor(id, options),
      );
      options.onProvider?.(usage);
      return usage;
    }),
  );
  // Snapshot age is its oldest reading, so a cached answer keeps its timestamp.
  const readings = providers
    .map((p) => (p.fetchedAt ? Date.parse(p.fetchedAt) : Number.NaN))
    .filter((t) => Number.isFinite(t));
  const fetchedAt =
    readings.length > 0
      ? new Date(Math.min(...readings)).toISOString()
      : (options.now ?? new Date()).toISOString();
  return { fetchedAt, providers };
}

/** Test helper: persist a snapshot as if a previous fetch wrote it. */
export function writeUsageCache(db: DatabaseSync, snapshot: UsageSnapshot): void {
  const at = Date.parse(snapshot.fetchedAt);
  const atMs = Number.isFinite(at) ? at : Date.now();
  for (const provider of snapshot.providers) writeCachedProvider(db, provider, atMs);
}

/** Drop the pre-per-provider single-blob cache; nothing reads it any more. */
function dropLegacyUsageCache(db: DatabaseSync): void {
  if (getState(db, LEGACY_CACHE_KEY) !== null) {
    db.prepare("DELETE FROM app_state WHERE key = ?").run(LEGACY_CACHE_KEY);
  }
}

export function isUnavailable(provider: ProviderUsage): boolean {
  return provider.status !== "available" || provider.windows.length === 0;
}
