/**
 * Provider-reported usage windows. Percents are 0–100 of the provider's own limit.
 */

export interface UsageWindow {
  id: string;
  label: string;
  usedPct: number | null;
  resetsAt: string | null;
}

export interface ProviderUsage {
  providerId: string;
  displayName: string;
  status: "available" | "unavailable" | "error";
  planLabel: string | null;
  windows: UsageWindow[];
  error: string | null;
  /** Fetcher signal: the vendor answered HTTP 429. Consumed by the cache's backoff. */
  rateLimited?: boolean;
  /** Fetcher signal: the vendor's `Retry-After`, in ms, when it sent one. */
  retryAfterMs?: number | null;
  /** When this reading was taken (ISO). Set by the cache layer. */
  fetchedAt?: string | null;
  /**
   * Set when this is an older good reading served because a refresh failed,
   * backed off, or timed out. Still gated normally, but never silently: the
   * guard and status surface the age and reason.
   */
  stale?: { ageMs: number; reason: string } | null;
  /**
   * On an `error` result: the last good reading, too old to gate on
   * (older than maxStaleMs). The guard still blocks on any enforced window it
   * shows over threshold that has not reset yet — stale data may only ever
   * tighten a gate, never loosen it.
   */
  lastGood?: { fetchedAt: string; windows: UsageWindow[] } | null;
}

export interface UsageSnapshot {
  fetchedAt: string;
  providers: ProviderUsage[];
}

export type UsageFetcher = () => UsageSnapshot | Promise<UsageSnapshot>;

export function emptySnapshot(fetchedAt = new Date(0).toISOString()): UsageSnapshot {
  return { fetchedAt, providers: [] };
}

export function providerUsage(snapshot: UsageSnapshot, providerId: string): ProviderUsage | null {
  return snapshot.providers.find((p) => p.providerId === providerId) ?? null;
}

export function unavailable(
  providerId: string,
  displayName: string,
  error?: string | null,
): ProviderUsage {
  return {
    providerId,
    displayName,
    status: "unavailable",
    planLabel: null,
    windows: [],
    error: error ?? null,
  };
}

export function errored(
  providerId: string,
  displayName: string,
  error: string,
  extra: { rateLimited?: boolean; retryAfterMs?: number | null } = {},
): ProviderUsage {
  const usage: ProviderUsage = {
    providerId,
    displayName,
    status: "error",
    planLabel: null,
    windows: [],
    error,
  };
  if (extra.rateLimited) {
    usage.rateLimited = true;
    usage.retryAfterMs = extra.retryAfterMs ?? null;
  }
  return usage;
}

/** Shared `callUsage` failure shape across the vendor fetchers. */
export interface CallError {
  kind: "error";
  detail: string;
  rateLimited?: boolean;
  retryAfterMs?: number | null;
}

/** Build the error for a non-2xx vendor response, flagging 429 for backoff. */
export function httpError(
  api: string,
  res: { status: number; retryAfterMs: number | null },
): CallError {
  if (res.status === 429) {
    return {
      kind: "error",
      detail: `${api} HTTP 429 (rate limited)`,
      rateLimited: true,
      retryAfterMs: res.retryAfterMs,
    };
  }
  return { kind: "error", detail: `${api} HTTP ${res.status}` };
}
