import { randomUUID } from "node:crypto";
import { asJsonArray, jsonString, parseJsonText, type JsonValue } from "../../json-value.js";
import { withImmediate } from "../../db/client.js";
import type { DatabaseSync } from "../db.js";
import { asRecord, finiteNumber } from "./http.js";
import { errored, type ProviderUsage, type UsageWindow } from "./types.js";

/**
 * Per-provider usage cache with a cross-process refresh lease (singleflight).
 *
 * Every Claude Code / Codex hook is a fresh process, and a single turn can
 * fire several (`UserPromptSubmit` + parallel `PreToolUse`) across several
 * sessions. Without coordination they all refresh together the moment the
 * TTL lapses — a request burst that earns HTTP 429 from the vendor.
 *
 * Here exactly one process (the lease holder) refreshes a provider; the rest
 * wait for its decision (the row's `seq` bumps when an attempt completes,
 * success or failure) up to a bounded deadline. Failed refreshes set a
 * backoff (honouring `Retry-After` on 429) so nobody re-hits the API until
 * it expires. While refresh is impossible, the last good reading is served
 * as explicitly `stale` up to `maxStaleMs`; past that the provider becomes
 * an `error` so failClosed decides.
 */

/** Soft TTL before a hook process hits the vendor again. */
export const DEFAULT_CACHE_TTL_MS = 90_000;
/** Oldest good reading a guard may still gate on when refresh is impossible. */
export const DEFAULT_MAX_STALE_MS = 10 * 60_000;
/**
 * Lease lifetime. Must exceed a leader's worst case: Claude's Keychain read
 * (2s) + usage, token refresh, usage again at 5s each ≈ 17s.
 */
export const DEFAULT_LEASE_TTL_MS = 30_000;
/**
 * How long a waiter waits for the leader's decision. Covers the leader's
 * worst case (≈17s); a waiter that takes over a dead lease adds at most one
 * more leader run, so a hook stays ≈40s worst case — under Claude Code's
 * historical 60s default hook timeout (Codex defaults to 600s). llm-budget
 * installs its hooks without an explicit `timeout`.
 */
export const DEFAULT_WAIT_TIMEOUT_MS = 20_000;
export const DEFAULT_POLL_INTERVAL_MS = 100;

/** 429 backoff: Retry-After clamped to this range; missing header → exponential. */
export const RATE_LIMIT_MIN_BACKOFF_MS = 5_000;
export const RATE_LIMIT_DEFAULT_BACKOFF_MS = 60_000;
export const RATE_LIMIT_MAX_BACKOFF_MS = 15 * 60_000;
/** Other refresh errors (5xx, network, bad JSON): short exponential backoff. */
export const ERROR_BASE_BACKOFF_MS = 5_000;
export const ERROR_MAX_BACKOFF_MS = 2 * 60_000;

export interface CachePolicy {
  ttlMs: number;
  maxStaleMs: number;
  leaseTtlMs: number;
  waitTimeoutMs: number;
  pollIntervalMs: number;
  /** Skip the TTL check (still respects backoff and the lease). */
  forceRefresh: boolean;
  clock: () => number;
  sleep: (ms: number) => Promise<void>;
}

export interface CacheRow {
  seq: number;
  result: ProviderUsage | null;
  resultAt: number | null;
  good: ProviderUsage | null;
  goodAt: number | null;
  failures: number;
  backoffUntil: number | null;
  lastError: string | null;
  leaseOwner: string | null;
  leasePid: number | null;
  leaseUntil: number | null;
}

function windowFromJson(value: JsonValue): UsageWindow {
  const rec = asRecord(value);
  return {
    id: jsonString(rec?.id) ?? "",
    label: jsonString(rec?.label) ?? "",
    usedPct: finiteNumber(rec?.usedPct),
    resetsAt: jsonString(rec?.resetsAt),
  };
}

export function providerFromJson(value: JsonValue): ProviderUsage {
  const rec = asRecord(value);
  const status = jsonString(rec?.status);
  return {
    providerId: jsonString(rec?.providerId) ?? "",
    displayName: jsonString(rec?.displayName) ?? "",
    status:
      status === "available" || status === "unavailable" || status === "error"
        ? status
        : "unavailable",
    planLabel: jsonString(rec?.planLabel),
    windows: (asJsonArray(rec?.windows) ?? []).map(windowFromJson),
    error: jsonString(rec?.error),
  };
}

/** Persist only the vendor reading — never transient cache annotations. */
function providerToJson(usage: ProviderUsage): string {
  return JSON.stringify({
    providerId: usage.providerId,
    displayName: usage.displayName,
    status: usage.status,
    planLabel: usage.planLabel,
    windows: usage.windows,
    error: usage.error,
  });
}

function parseProvider(raw: string | null): ProviderUsage | null {
  if (!raw) return null;
  try {
    return providerFromJson(parseJsonText(raw));
  } catch {
    return null;
  }
}

interface SqlRow {
  seq: number | bigint;
  result_json: string | null;
  result_at: number | bigint | null;
  good_json: string | null;
  good_at: number | bigint | null;
  failures: number | bigint;
  backoff_until: number | bigint | null;
  last_error: string | null;
  lease_owner: string | null;
  lease_pid: number | bigint | null;
  lease_until: number | bigint | null;
}

function num(value: number | bigint | null | undefined): number | null {
  return value === null || value === undefined ? null : Number(value);
}

export function readCacheRow(db: DatabaseSync, providerId: string): CacheRow {
  // SAFETY: SELECT * FROM provider_usage_cache matches SqlRow (schema.ts); missing rows are undefined.
  const row = db.prepare("SELECT * FROM provider_usage_cache WHERE provider_id = ?").get(providerId) as
    | SqlRow
    | undefined;
  return {
    seq: num(row?.seq) ?? 0,
    result: parseProvider(row?.result_json ?? null),
    resultAt: num(row?.result_at),
    good: parseProvider(row?.good_json ?? null),
    goodAt: num(row?.good_at),
    failures: num(row?.failures) ?? 0,
    backoffUntil: num(row?.backoff_until),
    lastError: row?.last_error ?? null,
    leaseOwner: row?.lease_owner ?? null,
    leasePid: num(row?.lease_pid),
    leaseUntil: num(row?.lease_until),
  };
}

function ensureRow(db: DatabaseSync, providerId: string): void {
  db.prepare("INSERT OR IGNORE INTO provider_usage_cache(provider_id) VALUES (?)").run(providerId);
}

/** Seed a provider row as if a refresh at `atMs` returned `usage` (tests, migrations). */
export function writeCachedProvider(db: DatabaseSync, usage: ProviderUsage, atMs: number): void {
  withImmediate(db, () => {
    ensureRow(db, usage.providerId);
    const json = providerToJson(usage);
    if (usage.status === "available") {
      db.prepare(
        `UPDATE provider_usage_cache SET result_json = ?, result_at = ?, good_json = ?, good_at = ?,
           seq = seq + 1, failures = 0, backoff_until = NULL, last_error = NULL
         WHERE provider_id = ?`,
      ).run(json, atMs, json, atMs, usage.providerId);
    } else {
      db.prepare(
        `UPDATE provider_usage_cache SET result_json = ?, result_at = ?, seq = seq + 1, last_error = ?
         WHERE provider_id = ?`,
      ).run(json, atMs, usage.error, usage.providerId);
    }
  });
}

function processAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: exists but owned by someone else — still alive.
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

function leaseHeld(row: CacheRow, nowMs: number): boolean {
  if (!row.leaseOwner || row.leaseUntil === null || row.leaseUntil <= nowMs) return false;
  // A crashed leader (killed hook) must not stall everyone for a full TTL.
  return row.leasePid === null || processAlive(row.leasePid);
}

function isFresh(row: CacheRow, nowMs: number, ttlMs: number): row is CacheRow & { result: ProviderUsage; resultAt: number } {
  if (!row.result || row.resultAt === null) return false;
  // An error is never a final answer; it is retried once backoff expires.
  if (row.result.status === "error") return false;
  const age = nowMs - row.resultAt;
  return age >= 0 && age < ttlMs;
}

export function backoffMs(usage: ProviderUsage, failures: number): number {
  const exp = Math.max(0, failures - 1);
  if (usage.rateLimited) {
    const hinted = usage.retryAfterMs;
    const base =
      hinted !== null && hinted !== undefined
        ? hinted
        : RATE_LIMIT_DEFAULT_BACKOFF_MS * 2 ** exp;
    return Math.min(RATE_LIMIT_MAX_BACKOFF_MS, Math.max(RATE_LIMIT_MIN_BACKOFF_MS, base));
  }
  return Math.min(ERROR_MAX_BACKOFF_MS, ERROR_BASE_BACKOFF_MS * 2 ** exp);
}

type Acquire = "acquired" | "busy" | "changed";

function tryAcquire(
  db: DatabaseSync,
  providerId: string,
  expectedSeq: number,
  owner: string,
  policy: CachePolicy,
): Acquire {
  return withImmediate(db, () => {
    ensureRow(db, providerId);
    const row = readCacheRow(db, providerId);
    const nowMs = policy.clock();
    // Someone finished an attempt between our read and this transaction.
    if (row.seq !== expectedSeq) return "changed";
    if (leaseHeld(row, nowMs)) return "busy";
    db.prepare(
      "UPDATE provider_usage_cache SET lease_owner = ?, lease_pid = ?, lease_until = ? WHERE provider_id = ?",
    ).run(owner, process.pid, nowMs + policy.leaseTtlMs, providerId);
    return "acquired";
  });
}

function commitAttempt(
  db: DatabaseSync,
  providerId: string,
  owner: string,
  usage: ProviderUsage,
  nowMs: number,
): CacheRow {
  return withImmediate(db, () => {
    ensureRow(db, providerId);
    const row = readCacheRow(db, providerId);
    const json = providerToJson(usage);
    if (usage.status === "available") {
      db.prepare(
        `UPDATE provider_usage_cache SET result_json = ?, result_at = ?, good_json = ?, good_at = ?,
           failures = 0, backoff_until = NULL, last_error = NULL WHERE provider_id = ?`,
      ).run(json, nowMs, json, nowMs, providerId);
    } else if (usage.status === "unavailable") {
      // Definitive (not signed in / token expired): cache for the TTL, no backoff.
      db.prepare(
        `UPDATE provider_usage_cache SET result_json = ?, result_at = ?,
           failures = 0, backoff_until = NULL, last_error = ? WHERE provider_id = ?`,
      ).run(json, nowMs, usage.error, providerId);
    } else {
      const failures = row.failures + 1;
      db.prepare(
        `UPDATE provider_usage_cache SET result_json = ?, result_at = ?,
           failures = ?, backoff_until = ?, last_error = ? WHERE provider_id = ?`,
      ).run(json, nowMs, failures, nowMs + backoffMs(usage, failures), usage.error, providerId);
    }
    // Bump seq so waiters see a decision; release only our own lease (an
    // expired one may have been taken over).
    db.prepare(
      `UPDATE provider_usage_cache SET seq = seq + 1,
         lease_owner = CASE WHEN lease_owner = ? THEN NULL ELSE lease_owner END,
         lease_pid = CASE WHEN lease_owner = ? THEN NULL ELSE lease_pid END,
         lease_until = CASE WHEN lease_owner = ? THEN NULL ELSE lease_until END
       WHERE provider_id = ?`,
    ).run(owner, owner, owner, providerId);
    return readCacheRow(db, providerId);
  });
}

function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 120) return `${m}m`;
  return `${Math.round(m / 60)}h`;
}

function withReading(usage: ProviderUsage, atMs: number | null): ProviderUsage {
  return { ...usage, fetchedAt: atMs === null ? null : new Date(atMs).toISOString() };
}

/**
 * Answer when no fresh reading is obtainable: the last good one if it is
 * recent enough (marked stale), else an error carrying the reason so the
 * guard's failClosed policy decides.
 */
function fallback(
  row: CacheRow,
  providerId: string,
  displayName: string,
  reason: string,
  nowMs: number,
  policy: CachePolicy,
): ProviderUsage {
  const backoff =
    row.backoffUntil !== null && row.backoffUntil > nowMs
      ? `; retrying after ${new Date(row.backoffUntil).toISOString()}`
      : "";
  const detail = `${reason}${backoff}`;
  if (row.good && row.goodAt !== null) {
    const ageMs = Math.max(0, nowMs - row.goodAt);
    if (ageMs <= policy.maxStaleMs) {
      return { ...withReading(row.good, row.goodAt), stale: { ageMs, reason: detail } };
    }
    const usage = errored(
      providerId,
      row.good.displayName || displayName,
      `${detail}; last good usage is ${formatDuration(ageMs)} old (max ${formatDuration(policy.maxStaleMs)})`,
    );
    usage.lastGood = { fetchedAt: new Date(row.goodAt).toISOString(), windows: row.good.windows };
    return usage;
  }
  return errored(providerId, row.result?.displayName || displayName, detail);
}

function failureReason(row: CacheRow): string {
  return row.lastError ?? row.result?.error ?? "usage refresh failed";
}

/**
 * Resolve one provider's usage through the shared cache, refreshing at most
 * once across all concurrent llm-budget processes. Never throws for fetch
 * failures (the fetcher's rejection becomes an `error` reading).
 */
export async function getProviderUsageCached(
  db: DatabaseSync,
  providerId: string,
  displayName: string,
  fetcher: () => Promise<ProviderUsage>,
  policy: CachePolicy,
): Promise<ProviderUsage> {
  const owner = randomUUID();
  const deadline = policy.clock() + policy.waitTimeoutMs;
  let initialSeq: number | null = null;

  for (;;) {
    const row = readCacheRow(db, providerId);
    const nowMs = policy.clock();
    if (initialSeq === null) initialSeq = row.seq;
    const decided = row.seq !== initialSeq;

    if ((decided || !policy.forceRefresh) && isFresh(row, nowMs, policy.ttlMs)) {
      return withReading(row.result, row.resultAt);
    }
    // Another process's refresh attempt finished, and failed: take its decision.
    if (decided) return fallback(row, providerId, displayName, failureReason(row), nowMs, policy);
    if (row.backoffUntil !== null && row.backoffUntil > nowMs) {
      return fallback(row, providerId, displayName, failureReason(row), nowMs, policy);
    }

    const acquired = tryAcquire(db, providerId, row.seq, owner, policy);
    if (acquired === "acquired") break;
    if (acquired === "changed") continue;
    if (policy.clock() >= deadline) {
      return fallback(
        row,
        providerId,
        displayName,
        `timed out after ${formatDuration(policy.waitTimeoutMs)} waiting for another llm-budget process to refresh ${displayName} usage`,
        policy.clock(),
        policy,
      );
    }
    await policy.sleep(policy.pollIntervalMs);
  }

  let usage: ProviderUsage;
  try {
    usage = await fetcher();
  } catch (error) {
    usage = errored(providerId, displayName, error instanceof Error ? error.message : String(error));
  }
  const nowMs = policy.clock();
  const row = commitAttempt(db, providerId, owner, usage, nowMs);
  if (usage.status !== "error") return withReading(usage, nowMs);
  return fallback(row, providerId, displayName, usage.error ?? "usage refresh failed", nowMs, policy);
}
