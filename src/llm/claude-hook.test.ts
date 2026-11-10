import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import {
  CLAUDE_ENFORCE_EVENTS,
  ClaudeHookInputError,
  handleClaudeHook,
  parseClaudeHookInput,
} from "./claude-hook.js";
import { DEFAULT_CONFIG, type Config } from "../config.js";
import { tempHome } from "../test-home.js";
import type { UsageSnapshot } from "./usage/index.js";

// Tests that omit `home` would otherwise open the developer's real
// ~/.local/share/llm-budget store (an active override there flips results).
process.env.HOME = tempHome("llm-budget-claude-hook-home-");

function baseConfig(overrides: { fiveHourBlockAtPercent?: number } = {}): Config {
  const config = structuredClone(DEFAULT_CONFIG);
  if (overrides.fiveHourBlockAtPercent !== undefined) {
    config.claude.windows.five_hour.blockAtPercent = overrides.fiveHourBlockAtPercent;
  }
  return config;
}

function claudeSnapshot(
  windows: Array<{ id: string; label: string; usedPct?: number | null }>,
): () => Promise<UsageSnapshot> {
  return () =>
    Promise.resolve({
      fetchedAt: "2026-08-25T00:00:00.000Z",
      providers: [
        {
          providerId: "claude",
          displayName: "claude",
          status: "available",
          planLabel: null,
          windows: windows.map((w) => ({
            id: w.id,
            label: w.label,
            usedPct: w.usedPct ?? null,
            resetsAt: null,
          })),
          error: null,
        },
      ],
    });
}

const UNDER_THRESHOLD = claudeSnapshot([
  { id: "weekly", label: "Weekly", usedPct: 50 },
  { id: "five_hour", label: "Session", usedPct: 10 },
]);

test("enforce set covers the two registered hook events only", () => {
  assert.deepEqual([...CLAUDE_ENFORCE_EVENTS].sort(), ["PreToolUse", "UserPromptSubmit"]);
});

test("allows when usage is below both thresholds", async () => {
  const response = await handleClaudeHook(
    { hook_event_name: "UserPromptSubmit", session_id: "s-1" },
    { fetchUsage: UNDER_THRESHOLD, config: baseConfig() },
  );
  assert.equal(response.block, false);
});

test("blocks UserPromptSubmit past the weekly threshold with escape hatches", async () => {
  const over = claudeSnapshot([
    { id: "weekly", label: "Weekly", usedPct: 85 },
    { id: "five_hour", label: "Session", usedPct: 10 },
  ]);
  const response = await handleClaudeHook(
    { hook_event_name: "UserPromptSubmit", session_id: "sess-1234" },
    { fetchUsage: over, config: baseConfig() },
  );
  assert.equal(response.block, true);
  assert.match(response.message ?? "", /Claude Code blocked by llm-budget/);
  assert.match(response.message ?? "", /85% of 80% block threshold/);
  assert.match(response.message ?? "", /llm-budget override 30m/);
  assert.match(response.message ?? "", /llm-budget except add sess-1234/);
});

test("rolling 5h window blocks independently of the weekly gate", async () => {
  const rollingOver = claudeSnapshot([
    { id: "weekly", label: "Weekly", usedPct: 10 },
    { id: "five_hour", label: "Session", usedPct: 90 },
  ]);
  const response = await handleClaudeHook(
    { hook_event_name: "PreToolUse", session_id: "s-1" },
    { fetchUsage: rollingOver, config: baseConfig() },
  );
  assert.equal(response.block, true);
  assert.match(response.message ?? "", /Rolling 5h budget reached/);

  // A tighter rolling threshold blocks where the default would not.
  const tight = baseConfig({ fiveHourBlockAtPercent: 5 });
  const responseTight = await handleClaudeHook(
    { hook_event_name: "PreToolUse", session_id: "s-1" },
    { fetchUsage: UNDER_THRESHOLD, config: tight },
  );
  assert.equal(responseTight.block, true);
  assert.match(responseTight.message ?? "", /Rolling 5h/);
});

test("excluded sessions bypass every gate", async () => {
  const config = baseConfig();
  config.excludeSessionIds = ["sess-1234"];
  const over = claudeSnapshot([
    { id: "weekly", label: "Weekly", usedPct: 99 },
    { id: "five_hour", label: "Session", usedPct: 99 },
  ]);
  const response = await handleClaudeHook(
    { hook_event_name: "UserPromptSubmit", session_id: "sess-1234" },
    { fetchUsage: over, config },
  );
  assert.equal(response.block, false);
});

test("override bypasses gates", async () => {
  const home = tempHome("llm-budget-hook-");
  const { openLlmDb, setState } = await import("./db.js");
  setState(openLlmDb(home), "override_until", new Date(Date.now() + 3_600_000).toISOString());
  const over = claudeSnapshot([
    { id: "weekly", label: "Weekly", usedPct: 99 },
    { id: "five_hour", label: "Session", usedPct: 99 },
  ]);
  const response = await handleClaudeHook(
    { hook_event_name: "UserPromptSubmit", session_id: "s-1" },
    { home, fetchUsage: over },
  );
  assert.equal(response.block, false);
});

test("broken config denies enforce events with a recoverable message", async () => {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const home = tempHome("llm-budget-hook-cfg-");
  mkdirSync(join(home, ".config", "llm-budget"), { recursive: true });
  writeFileSync(join(home, ".config", "llm-budget", "config.jsonc"), "{ not json");
  const response = await handleClaudeHook(
    { hook_event_name: "UserPromptSubmit", session_id: "s-1" },
    { home },
  );
  assert.equal(response.block, true);
  assert.match(response.message ?? "", /failed to load config/);
});

test("unreachable usage API fails closed (and opens under failClosed=false)", async () => {
  const failing = () => {
    throw new Error("daemon down");
  };
  const blocked = await handleClaudeHook(
    { hook_event_name: "UserPromptSubmit", session_id: "s-1" },
    { fetchUsage: failing },
  );
  assert.equal(blocked.block, true);
  assert.match(blocked.message ?? "", /Usage could not be determined/);

  const lenientConfig = baseConfig();
  lenientConfig.enforcement.failClosed = false;
  const allowed = await handleClaudeHook(
    { hook_event_name: "UserPromptSubmit", session_id: "s-1" },
    { fetchUsage: failing, config: lenientConfig },
  );
  assert.equal(allowed.block, false);
});

test("non-enforce events never block", async () => {
  const response = await handleClaudeHook({ hook_event_name: "Stop" }, {});
  assert.equal(response.block, false);
});

test("hook event without session id still formats a usable block message", async () => {
  const over = claudeSnapshot([
    { id: "weekly", label: "Weekly", usedPct: 99 },
    { id: "five_hour", label: "Session", usedPct: 99 },
  ]);
  const response = await handleClaudeHook(
    { hook_event_name: "UserPromptSubmit" },
    { fetchUsage: over, config: baseConfig() },
  );
  assert.equal(response.block, true);
  assert.match(response.message ?? "", /except add unknown/);
});

test("malformed or empty hook input fails closed", () => {
  assert.throws(() => parseClaudeHookInput(""), ClaudeHookInputError);
  assert.throws(() => parseClaudeHookInput("{ nope"), ClaudeHookInputError);
  assert.deepEqual(parseClaudeHookInput('{"hook_event_name":"Stop"}'), {
    hook_event_name: "Stop",
  });
});
