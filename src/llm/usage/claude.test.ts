import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { JsonValue } from "../../json-value.js";
import { fetchClaudeUsage } from "./claude.js";
import { tempHome } from "../../test-home.js";

function jsonResponse(status: number, body: JsonValue): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function homeWithClaudeCreds(): string {
  const home = tempHome("llm-budget-claude-");
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(
    join(home, ".claude", ".credentials.json"),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "access-1",
        refreshToken: "refresh-1",
        subscriptionType: "pro",
        rateLimitTier: "default_5x",
      },
    }),
  );
  return home;
}

test("fetchClaudeUsage maps 5h and weekly utilization windows", async () => {
  const home = homeWithClaudeCreds();
  const usage = await fetchClaudeUsage({
    home,
    platform: "linux",
    fetch: async (url) => {
      assert.match(String(url), /api\/oauth\/usage/);
      return jsonResponse(200, {
        five_hour: { utilization: 12, resets_at: "2026-08-25T21:00:00Z" },
        seven_day: { utilization: 40, resets_at: "2026-08-31T00:00:00Z" },
      });
    },
  });
  assert.equal(usage.status, "available");
  assert.equal(usage.planLabel, "Pro 5x");
  assert.equal(usage.windows.length, 2);
  assert.equal(usage.windows[0]?.id, "five_hour");
  assert.equal(usage.windows[0]?.usedPct, 12);
  assert.equal(usage.windows[1]?.id, "weekly");
  assert.equal(usage.windows[1]?.usedPct, 40);
});

test("fetchClaudeUsage is unavailable when Claude is not signed in", async () => {
  const home = tempHome("llm-budget-claude-none-");
  const usage = await fetchClaudeUsage({ home, platform: "linux", fetch: async () => {
    throw new Error("must not fetch without creds");
  } });
  assert.equal(usage.status, "unavailable");
  assert.match(usage.error ?? "", /not signed in/);
});

test("fetchClaudeUsage refreshes a file-backed token after 401", async () => {
  const home = homeWithClaudeCreds();
  const urls: string[] = [];
  const usage = await fetchClaudeUsage({
    home,
    platform: "linux",
    fetch: async (url, init) => {
      urls.push(String(url));
      if (String(url).includes("/oauth/token")) {
        const body = JSON.parse(String(init?.body));
        assert.equal(body.refresh_token, "refresh-1");
        return jsonResponse(200, { access_token: "access-2", refresh_token: "refresh-2" });
      }
      const auth = String(new Headers(init?.headers).get("Authorization"));
      if (auth.includes("access-1")) return jsonResponse(401, { error: "expired" });
      return jsonResponse(200, {
        five_hour: { utilization: 1 },
        seven_day: { utilization: 2 },
      });
    },
  });
  assert.equal(usage.status, "available");
  assert.equal(usage.windows[1]?.usedPct, 2);
  const saved = JSON.parse(readFileSync(join(home, ".claude", ".credentials.json"), "utf8"));
  assert.equal(saved.claudeAiOauth.accessToken, "access-2");
  assert.equal(saved.claudeAiOauth.refreshToken, "refresh-2");
  assert.equal(urls.filter((u) => u.includes("/oauth/token")).length, 1);
});

test("fetchClaudeUsage does not refresh Keychain-backed tokens", async () => {
  const home = tempHome("llm-budget-claude-kc-");
  let tokenCalls = 0;
  const usage = await fetchClaudeUsage({
    home,
    platform: "darwin",
    keychainReader: async () => ({
      claudeAiOauth: { accessToken: "kc-access", refreshToken: "kc-refresh" },
    }),
    fetch: async (url) => {
      if (String(url).includes("/oauth/token")) {
        tokenCalls += 1;
        return jsonResponse(200, { access_token: "should-not-save" });
      }
      return jsonResponse(401, {});
    },
  });
  assert.equal(usage.status, "unavailable");
  assert.match(usage.error ?? "", /expired/);
  assert.equal(tokenCalls, 0);
});

test("fetchClaudeUsage flags HTTP 429 with the vendor's Retry-After", async () => {
  const home = homeWithClaudeCreds();
  const usage = await fetchClaudeUsage({
    home,
    platform: "linux",
    fetch: async () =>
      new Response(JSON.stringify({ error: { type: "rate_limit_error" } }), {
        status: 429,
        headers: { "retry-after": "42" },
      }),
  });
  assert.equal(usage.status, "error");
  assert.equal(usage.rateLimited, true);
  assert.equal(usage.retryAfterMs, 42_000);
  assert.match(usage.error ?? "", /HTTP 429/);
});
