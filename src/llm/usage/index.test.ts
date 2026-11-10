import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { JsonValue } from "../../json-value.js";
import { openLlmDb } from "../db.js";
import { fetchDirectUsage, writeUsageCache } from "./index.js";
import { tempHome } from "../../test-home.js";

function jsonResponse(status: number, body: JsonValue): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function signedInHome(): string {
  const home = tempHome("llm-budget-usage-");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(
    join(home, ".claude", ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "c" } }),
  );
  writeFileSync(
    join(home, ".codex", "auth.json"),
    JSON.stringify({ tokens: { access_token: "x" } }),
  );
  return home;
}

test("fetchDirectUsage returns both providers and caches the snapshot", async () => {
  const home = signedInHome();
  let calls = 0;
  const fetch = async (url: RequestInfo | URL) => {
    calls += 1;
    if (String(url).includes("anthropic")) {
      return jsonResponse(200, {
        five_hour: { utilization: 1 },
        seven_day: { utilization: 2 },
      });
    }
    return jsonResponse(200, {
      rate_limit: { primary_window: { used_percent: 3 } },
    });
  };
  const first = await fetchDirectUsage({ home, platform: "linux", fetch });
  assert.equal(first.providers.length, 3);
  assert.equal(first.providers[0]?.providerId, "claude");
  assert.equal(first.providers[1]?.providerId, "codex");
  assert.equal(first.providers[2]?.providerId, "copilot");
  assert.equal(first.providers[2]?.status, "unavailable");
  const networkCalls = calls;
  const second = await fetchDirectUsage({ home, platform: "linux", fetch });
  assert.equal(calls, networkCalls);
  assert.equal(second.fetchedAt, first.fetchedAt);
});

test("fetchDirectUsage maps a signed-in Copilot provider through the cache", async () => {
  const home = signedInHome();
  const dir = join(home, ".config", "github-copilot");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "hosts.json"),
    JSON.stringify({ "github.com": { oauth_token: "ghu_jsontoken" } }),
  );
  const snapshot = await fetchDirectUsage({
    home,
    platform: "linux",
    fetch: async (url) => {
      const href = String(url);
      if (href.includes("anthropic")) {
        return jsonResponse(200, {
          five_hour: { utilization: 1 },
          seven_day: { utilization: 2 },
        });
      }
      if (href.includes("copilot_internal")) {
        return jsonResponse(200, {
          copilot_plan: "individual",
          quota_snapshots: {
            chat: { percent_remaining: 40, unlimited: false },
          },
        });
      }
      return jsonResponse(200, {
        rate_limit: { primary_window: { used_percent: 3 } },
      });
    },
  });
  assert.equal(snapshot.providers[2]?.providerId, "copilot");
  assert.equal(snapshot.providers[2]?.status, "available");
  assert.equal(snapshot.providers[2]?.windows[0]?.usedPct, 60);
});

test("fetchDirectUsage forceRefresh bypasses a fresh cache", async () => {
  const home = signedInHome();
  const db = openLlmDb(home);
  writeUsageCache(db, {
    fetchedAt: new Date().toISOString(),
    providers: [],
  });
  const snapshot = await fetchDirectUsage({
    home,
    db,
    platform: "linux",
    forceRefresh: true,
    fetch: async (url) => {
      if (String(url).includes("anthropic")) {
        return jsonResponse(200, {
          five_hour: { utilization: 9 },
          seven_day: { utilization: 9 },
        });
      }
      return jsonResponse(200, {
        rate_limit: { primary_window: { used_percent: 9 } },
      });
    },
  });
  assert.equal(snapshot.providers[0]?.windows[0]?.usedPct, 9);
});

test("fetchDirectUsage resolves only the requested providers, each cached separately", async () => {
  const home = signedInHome();
  const urls: string[] = [];
  const fetch = async (url: RequestInfo | URL) => {
    urls.push(String(url));
    if (String(url).includes("anthropic")) {
      return jsonResponse(200, { five_hour: { utilization: 1 }, seven_day: { utilization: 2 } });
    }
    return jsonResponse(200, { rate_limit: { primary_window: { used_percent: 3 } } });
  };
  const claudeOnly = await fetchDirectUsage({ home, platform: "linux", fetch, providers: ["claude"] });
  assert.deepEqual(claudeOnly.providers.map((p) => p.providerId), ["claude"]);
  assert.equal(urls.length, 1);
  assert.match(urls[0] ?? "", /anthropic/);
  // A later full fetch reuses the fresh Claude row and only hits the others.
  await fetchDirectUsage({ home, platform: "linux", fetch });
  assert.equal(urls.filter((u) => u.includes("anthropic")).length, 1);
  assert.ok(urls.some((u) => u.includes("chatgpt")));
});

test("fetchDirectUsage keeps a good Claude reading through a 429 and backs off", async () => {
  const home = signedInHome();
  const db = openLlmDb(home);
  let claudeCalls = 0;
  const ok = async () => {
    claudeCalls += 1;
    return jsonResponse(200, { five_hour: { utilization: 30 }, seven_day: { utilization: 40 } });
  };
  const limited = async () => {
    claudeCalls += 1;
    return new Response("{}", { status: 429, headers: { "retry-after": "300" } });
  };
  const t0 = new Date();
  await fetchDirectUsage({ home, db, platform: "linux", fetch: ok, providers: ["claude"], now: t0 });
  const later = new Date(t0.getTime() + 120_000); // past the 90s TTL
  const stale = await fetchDirectUsage({ home, db, platform: "linux", fetch: limited, providers: ["claude"], now: later });
  const claude = stale.providers[0];
  assert.equal(claude?.status, "available");
  assert.equal(claude?.windows[1]?.usedPct, 40);
  assert.match(claude?.stale?.reason ?? "", /429/);
  assert.equal(claudeCalls, 2);
  // Within Retry-After: served from cache again with no request.
  await fetchDirectUsage({ home, db, platform: "linux", fetch: limited, providers: ["claude"], now: new Date(later.getTime() + 60_000) });
  assert.equal(claudeCalls, 2);
});
