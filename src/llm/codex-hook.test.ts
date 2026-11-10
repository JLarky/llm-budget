import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG, type Config } from "../config.js";
import {
  CODEX_ENFORCE_EVENTS,
  handleCodexHook,
  parseCodexHookInput,
  CodexHookInputError,
} from "./codex-hook.js";
import type { UsageSnapshot } from "./usage/index.js";
import { tempHome } from "../test-home.js";

// Tests that omit `home` would otherwise open the developer's real
// ~/.local/share/llm-budget store (an active override there flips results).
process.env.HOME = tempHome("llm-budget-codex-hook-home-");

function config(): Config {
  return structuredClone(DEFAULT_CONFIG);
}
function usage(usedPct: number): () => Promise<UsageSnapshot> {
  return async () => ({
    fetchedAt: "2026-08-25T00:00:00.000Z",
    providers: [{
      providerId: "codex",
      displayName: "Codex",
      status: "available",
      planLabel: null,
      windows: [
        { id: "session", label: "Session", usedPct, resetsAt: null },
        { id: "weekly", label: "Weekly", usedPct, resetsAt: null },
      ],
      error: null,
    }],
  });
}

test("Codex enforces prompt and tool hooks, not Stop", () => {
  assert.deepEqual([...CODEX_ENFORCE_EVENTS].sort(), ["PreToolUse", "UserPromptSubmit"]);
});

test("allows under budget and blocks over budget with session escape hatch", async () => {
  const allowed = await handleCodexHook(
    { hook_event_name: "UserPromptSubmit", session_id: "codex-1" },
    { config: config(), fetchUsage: usage(10) },
  );
  assert.equal(allowed.block, false);
  const blocked = await handleCodexHook(
    { hook_event_name: "PreToolUse", session_id: "codex-1" },
    { config: config(), fetchUsage: usage(90) },
  );
  assert.equal(blocked.block, true);
  assert.match(blocked.message ?? "", /except add codex-1/);
  assert.equal((await handleCodexHook({ hook_event_name: "Stop" }, { fetchUsage: usage(99) })).block, false);
});

test("excepted Codex session bypasses the gate", async () => {
  const cfg = config();
  cfg.excludeSessionIds = ["codex-exempt"];
  const result = await handleCodexHook(
    { hook_event_name: "UserPromptSubmit", session_id: "codex-exempt" },
    { config: cfg, fetchUsage: usage(99) },
  );
  assert.equal(result.block, false);
});

test("parses JSON and rejects malformed input", () => {
  assert.deepEqual(parseCodexHookInput('{"session_id":"s"}'), { session_id: "s" });
  assert.throws(() => parseCodexHookInput(""), CodexHookInputError);
  assert.throws(() => parseCodexHookInput("{ nope"), CodexHookInputError);
});
