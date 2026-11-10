import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { openLlmDb } from "../db.js";
import { tempHome } from "../../test-home.js";
import {
  backoffMs,
  getProviderUsageCached,
  readCacheRow,
  writeCachedProvider,
  RATE_LIMIT_DEFAULT_BACKOFF_MS,
  RATE_LIMIT_MAX_BACKOFF_MS,
  RATE_LIMIT_MIN_BACKOFF_MS,
  ERROR_BASE_BACKOFF_MS,
  ERROR_MAX_BACKOFF_MS,
  type CachePolicy,
} from "./cache.js";
import { parseRetryAfter } from "./http.js";
import { errored, type ProviderUsage } from "./types.js";

function policy(overrides: Partial<CachePolicy> = {}): CachePolicy {
  return {
    ttlMs: 90_000,
    maxStaleMs: 600_000,
    leaseTtlMs: 30_000,
    waitTimeoutMs: 2_000,
    pollIntervalMs: 5,
    forceRefresh: false,
    clock: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    ...overrides,
  };
}

function good(pct: number): ProviderUsage {
  return {
    providerId: "claude",
    displayName: "Claude Code",
    status: "available",
    planLabel: null,
    windows: [
      { id: "weekly", label: "Weekly", usedPct: pct, resetsAt: null },
      { id: "five_hour", label: "Session", usedPct: pct, resetsAt: null },
    ],
    error: null,
  };
}

function rateLimited(retryAfterMs: number | null): ProviderUsage {
  return errored("claude", "Claude Code", "Claude usage API HTTP 429 (rate limited)", {
    rateLimited: true,
    retryAfterMs,
  });
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("concurrent callers on separate connections share one refresh", async () => {
  const home = tempHome("llm-budget-cache-sf-");
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    await delay(80);
    return good(42);
  };
  const results = await Promise.all(
    Array.from({ length: 6 }, () =>
      getProviderUsageCached(openLlmDb(home), "claude", "Claude Code", fetcher, policy()),
    ),
  );
  assert.equal(calls, 1);
  for (const r of results) {
    assert.equal(r.status, "available");
    assert.equal(r.windows[0]?.usedPct, 42);
    assert.equal(r.stale, undefined);
  }
  // Fresh cache: no further network.
  await getProviderUsageCached(openLlmDb(home), "claude", "Claude Code", fetcher, policy());
  assert.equal(calls, 1);
});

test("waiters take the leader's 429 decision and nobody retries during Retry-After", async () => {
  const home = tempHome("llm-budget-cache-429-");
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    await delay(50);
    return rateLimited(120_000);
  };
  const results = await Promise.all(
    Array.from({ length: 4 }, () =>
      getProviderUsageCached(openLlmDb(home), "claude", "Claude Code", fetcher, policy()),
    ),
  );
  assert.equal(calls, 1);
  for (const r of results) {
    assert.equal(r.status, "error");
    assert.match(r.error ?? "", /429/);
    assert.match(r.error ?? "", /retrying after/);
  }
  const row = readCacheRow(openLlmDb(home), "claude");
  assert.equal(row.failures, 1);
  assert.ok(row.backoffUntil !== null && row.backoffUntil - Date.now() > 100_000);
  assert.equal(row.leaseOwner, null);

  // Still in backoff, even with forceRefresh: no request.
  await getProviderUsageCached(openLlmDb(home), "claude", "Claude Code", fetcher, policy({ forceRefresh: true }));
  assert.equal(calls, 1);

  // Once the backoff lapses a single refresh happens again.
  const later = Date.now() + 130_000;
  const recovered = await getProviderUsageCached(
    openLlmDb(home),
    "claude",
    "Claude Code",
    async () => {
      calls += 1;
      return good(7);
    },
    policy({ clock: () => later }),
  );
  assert.equal(calls, 2);
  assert.equal(recovered.status, "available");
  assert.equal(readCacheRow(openLlmDb(home), "claude").failures, 0);
});

test("a failed refresh serves the last good reading as stale within maxStaleMs", async () => {
  const home = tempHome("llm-budget-cache-stale-");
  const db = openLlmDb(home);
  const t0 = Date.now();
  writeCachedProvider(db, good(55), t0 - 5 * 60_000);
  const usage = await getProviderUsageCached(db, "claude", "Claude Code", async () => rateLimited(null), policy());
  assert.equal(usage.status, "available");
  assert.equal(usage.windows[0]?.usedPct, 55);
  assert.ok(usage.stale);
  assert.ok(usage.stale.ageMs >= 5 * 60_000);
  assert.match(usage.stale.reason, /429/);
  assert.equal(usage.fetchedAt, new Date(t0 - 5 * 60_000).toISOString());
});

test("beyond maxStaleMs the provider is an error carrying lastGood", async () => {
  const home = tempHome("llm-budget-cache-toostale-");
  const db = openLlmDb(home);
  writeCachedProvider(db, good(90), Date.now() - 30 * 60_000);
  const usage = await getProviderUsageCached(
    db,
    "claude",
    "Claude Code",
    async () => errored("claude", "Claude Code", "Claude usage API HTTP 503"),
    policy({ maxStaleMs: 10 * 60_000 }),
  );
  assert.equal(usage.status, "error");
  assert.equal(usage.windows.length, 0);
  assert.match(usage.error ?? "", /HTTP 503.*last good usage is 30m old \(max 10m\)/);
  assert.equal(usage.lastGood?.windows[0]?.usedPct, 90);
});

test("a waiter gives up at the bounded deadline while a live leader holds the lease", async () => {
  const home = tempHome("llm-budget-cache-wait-");
  const db = openLlmDb(home);
  writeCachedProvider(db, good(10), Date.now() - 2 * 60_000); // expired TTL, still within maxStale
  db.prepare(
    "UPDATE provider_usage_cache SET lease_owner = 'other', lease_pid = ?, lease_until = ? WHERE provider_id = 'claude'",
  ).run(process.pid, Date.now() + 60_000);
  let calls = 0;
  const started = Date.now();
  const usage = await getProviderUsageCached(
    db,
    "claude",
    "Claude Code",
    async () => {
      calls += 1;
      return good(99);
    },
    policy({ waitTimeoutMs: 150 }),
  );
  assert.equal(calls, 0);
  assert.ok(Date.now() - started >= 140);
  assert.equal(usage.windows[0]?.usedPct, 10);
  assert.match(usage.stale?.reason ?? "", /timed out .* waiting for another llm-budget process/);
});

test("a lease held by a dead process is taken over immediately", async () => {
  const home = tempHome("llm-budget-cache-dead-");
  const db = openLlmDb(home);
  // A pid that cannot exist on Linux/macOS (above pid_max).
  db.prepare(
    "INSERT INTO provider_usage_cache(provider_id, lease_owner, lease_pid, lease_until) VALUES ('claude', 'ghost', 2147483646, ?)",
  ).run(Date.now() + 60_000);
  let calls = 0;
  const usage = await getProviderUsageCached(
    db,
    "claude",
    "Claude Code",
    async () => {
      calls += 1;
      return good(3);
    },
    policy({ waitTimeoutMs: 50 }),
  );
  assert.equal(calls, 1);
  assert.equal(usage.status, "available");
});

test("unavailable (not signed in) is a definitive answer cached for the TTL", async () => {
  const home = tempHome("llm-budget-cache-unavail-");
  let calls = 0;
  const fetcher = async (): Promise<ProviderUsage> => {
    calls += 1;
    return {
      providerId: "claude",
      displayName: "Claude Code",
      status: "unavailable",
      planLabel: null,
      windows: [],
      error: "Claude Code is not signed in",
    };
  };
  await getProviderUsageCached(openLlmDb(home), "claude", "Claude Code", fetcher, policy());
  const second = await getProviderUsageCached(openLlmDb(home), "claude", "Claude Code", fetcher, policy());
  assert.equal(calls, 1);
  assert.equal(second.status, "unavailable");
  assert.equal(readCacheRow(openLlmDb(home), "claude").backoffUntil, null);
});

test("a throwing fetcher becomes an error reading with backoff", async () => {
  const home = tempHome("llm-budget-cache-throw-");
  const usage = await getProviderUsageCached(
    openLlmDb(home),
    "claude",
    "Claude Code",
    async () => {
      throw new Error("boom");
    },
    policy(),
  );
  assert.equal(usage.status, "error");
  assert.match(usage.error ?? "", /boom/);
  const row = readCacheRow(openLlmDb(home), "claude");
  assert.equal(row.leaseOwner, null);
  assert.ok(row.backoffUntil !== null);
});

test("backoff honours Retry-After within bounds and grows without it", () => {
  assert.equal(backoffMs(rateLimited(30_000), 1), 30_000);
  assert.equal(backoffMs(rateLimited(1), 1), RATE_LIMIT_MIN_BACKOFF_MS);
  assert.equal(backoffMs(rateLimited(86_400_000), 1), RATE_LIMIT_MAX_BACKOFF_MS);
  assert.equal(backoffMs(rateLimited(null), 1), RATE_LIMIT_DEFAULT_BACKOFF_MS);
  assert.equal(backoffMs(rateLimited(null), 2), RATE_LIMIT_DEFAULT_BACKOFF_MS * 2);
  assert.equal(backoffMs(rateLimited(null), 20), RATE_LIMIT_MAX_BACKOFF_MS);
  const plain = errored("claude", "Claude Code", "HTTP 503");
  assert.equal(backoffMs(plain, 1), ERROR_BASE_BACKOFF_MS);
  assert.equal(backoffMs(plain, 3), ERROR_BASE_BACKOFF_MS * 4);
  assert.equal(backoffMs(plain, 30), ERROR_MAX_BACKOFF_MS);
});

test("parseRetryAfter accepts delta-seconds and HTTP-dates", () => {
  assert.equal(parseRetryAfter("120"), 120_000);
  assert.equal(parseRetryAfter("1.5"), 1_500);
  const now = Date.parse("2026-11-09T00:00:00Z");
  assert.equal(parseRetryAfter("Mon, 09 Nov 2026 00:01:00 GMT", now), 60_000);
  assert.equal(parseRetryAfter("Sun, 08 Nov 2026 00:00:00 GMT", now), 0);
  assert.equal(parseRetryAfter(null), null);
  assert.equal(parseRetryAfter("soon"), null);
});

test("separate hook processes refresh Claude usage exactly once", { timeout: 60_000 }, async () => {
  const home = tempHome("llm-budget-cache-mp-");
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(
    join(home, ".claude", ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "c" } }),
  );
  const counter = join(home, "fetches.log");
  writeFileSync(counter, "");
  // Pre-create the schema so children only race on the lease, not on DDL.
  openLlmDb(home);
  const indexJs = fileURLToPath(new URL("./index.js", import.meta.url));
  const script = `
    import { appendFileSync } from "node:fs";
    const { fetchDirectUsage } = await import(${JSON.stringify(indexJs)});
    const snapshot = await fetchDirectUsage({
      home: ${JSON.stringify(home)},
      platform: "linux",
      providers: ["claude"],
      pollIntervalMs: 20,
      fetch: async () => {
        appendFileSync(${JSON.stringify(counter)}, "x");
        await new Promise((r) => setTimeout(r, 400));
        return new Response(JSON.stringify({ five_hour: { utilization: 11 }, seven_day: { utilization: 22 } }), { status: 200 });
      },
    });
    process.stdout.write(JSON.stringify(snapshot.providers[0]));
  `;
  const run = () =>
    new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
        env: { ...process.env, HOME: home },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += String(d)));
      child.stderr.on("data", (d) => (err += String(d)));
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`exit ${code}: ${err}`))));
    });
  const outputs = await Promise.all(Array.from({ length: 6 }, run));
  assert.equal(readFileSync(counter, "utf8").length, 1);
  for (const out of outputs) {
    const usage = JSON.parse(out);
    assert.equal(usage.status, "available");
    assert.equal(usage.windows[1].usedPct, 22);
  }
});
