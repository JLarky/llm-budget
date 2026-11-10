import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG, type Config } from "../config.js";
import { formatGuardDeny, runGuard } from "./guard.js";
import type { UsageSnapshot } from "./usage/index.js";
import { tempHome } from "../test-home.js";

// Tests that omit `home` would otherwise open the developer's real
// ~/.local/share/llm-budget store (an active override there flips results).
process.env.HOME = tempHome("llm-budget-guard-home-");

function config(overrides: {
  claudeEnabled?: boolean;
  codexEnabled?: boolean;
  claudeFiveHourBlockAt?: number | null;
  codexSessionBlockAt?: number | null;
  failClosed?: boolean;
}): Config {
  const c = structuredClone(DEFAULT_CONFIG);
  if (overrides.claudeEnabled !== undefined) c.claude.enabled = overrides.claudeEnabled;
  if (overrides.codexEnabled !== undefined) c.codex.enabled = overrides.codexEnabled;
  if (overrides.claudeFiveHourBlockAt !== undefined)
    c.claude.windows.five_hour.blockAtPercent = overrides.claudeFiveHourBlockAt;
  if (overrides.codexSessionBlockAt !== undefined)
    c.codex.windows.session.blockAtPercent = overrides.codexSessionBlockAt;
  if (overrides.failClosed !== undefined) c.enforcement.failClosed = overrides.failClosed;
  return c;
}

function snapshot(
  providers: Array<{
    providerId: string;
    status?: "available" | "unavailable" | "error";
    windows?: Array<{ id: string; label: string; usedPct?: number | null; resetsAt?: string | null }>;
    error?: string | null;
  }>,
): UsageSnapshot {
  return {
    fetchedAt: "2026-08-25T00:00:00.000Z",
    providers: providers.map((p) => ({
      providerId: p.providerId,
      displayName: p.providerId,
      status: p.status ?? ("available" as const),
      planLabel: null,
      windows: (p.windows ?? []).map((w) => ({
        id: w.id,
        label: w.label,
        usedPct: w.usedPct ?? null,
        resetsAt: w.resetsAt ?? null,
      })),
      error: p.error ?? null,
    })),
  };
}

const CLAUDE_SNAPSHOT = () =>
  snapshot([
    {
      providerId: "claude",
      windows: [
        { id: "weekly", label: "Weekly", usedPct: 10, resetsAt: "2026-08-31T00:00:00.000Z" },
        { id: "five_hour", label: "Session", usedPct: 5 },
      ],
    },
  ]);

test("disabled agents short-circuit before any usage fetch", async () => {
  let fetchCalls = 0;
  const decision = await runGuard("codex", config({ codexEnabled: false }), {
    fetchUsage: () => {
      fetchCalls += 1;
      throw new Error("must not fetch for disabled agents");
    },
  });
  assert.equal(decision.allow, true);
  assert.equal(fetchCalls, 0);
});

test("claude gates on weekly and 5h windows", async () => {
  const decision = await runGuard("claude", config({}), { fetchUsage: CLAUDE_SNAPSHOT });
  assert.equal(decision.allow, true);

  const over = snapshot([
    {
      providerId: "claude",
      windows: [
        { id: "weekly", label: "Weekly", usedPct: 85 },
        { id: "five_hour", label: "Session", usedPct: 5 },
      ],
    },
  ]);
  const denied = await runGuard("claude", config({}), { fetchUsage: () => over });
  assert.equal(denied.allow, false);
  const reason = denied.evaluation.reasons[0];
  assert.equal(reason?.kind, "window");
  if (reason?.kind !== "window") throw new Error("expected window reason");
  assert.equal(reason.windowLabel, "Weekly");
  assert.equal(reason.usedPct, 85);
  assert.equal(reason.blockAtPercent, 80);
  assert.equal(reason.resetsAt, null);
});

test("codex displays both OpenAI windows but enforces weekly only by default", async () => {
  const codex = () =>
    snapshot([
      {
        providerId: "codex",
        windows: [
          { id: "session", label: "Session", usedPct: 90, resetsAt: "2026-08-26T09:24:26.000Z" },
          { id: "weekly", label: "Weekly", usedPct: 13, resetsAt: "2026-08-31T16:04:13.000Z" },
        ],
      },
    ]);

  const allowed = await runGuard("codex", config({}), { fetchUsage: codex });
  assert.equal(allowed.allow, true);
  assert.equal(allowed.evaluation.reasons.length, 0);
  // Session is measured and shown, but monitor-only by default — it must not enforce.
  const session = allowed.evaluation.displayMeasurements?.find((m) => m.windowId === "session");
  assert.equal(session?.blockAtPercent, null);
});

test("codex session usage does not block when weekly usage is under threshold", async () => {
  const decision = await runGuard("codex", config({}), {
    fetchUsage: () =>
      snapshot([{ providerId: "codex", windows: [
        { id: "session", label: "Session", usedPct: 90, resetsAt: "2026-08-26T09:24:26.000Z" },
        { id: "weekly", label: "Weekly", usedPct: 10, resetsAt: "2026-08-31T16:04:13.000Z" },
      ] }]),
  });
  assert.equal(decision.allow, true);
});

test("codex session usage blocks once explicitly enforced", async () => {
  const decision = await runGuard("codex", config({ codexSessionBlockAt: 80 }), {
    fetchUsage: () =>
      snapshot([{ providerId: "codex", windows: [
        { id: "session", label: "Session", usedPct: 95, resetsAt: "2026-08-26T09:24:26.000Z" },
        { id: "weekly", label: "Weekly", usedPct: 10, resetsAt: "2026-08-31T16:04:13.000Z" },
      ] }]),
  });
  assert.equal(decision.allow, false);
});

test("codex weekly usage blocks and message includes both windows", async () => {
  const decision = await runGuard("codex", config({}), {
    fetchUsage: () =>
      snapshot([{ providerId: "codex", windows: [
        { id: "session", label: "Session", usedPct: 10, resetsAt: "2026-08-26T09:24:26.000Z" },
        { id: "weekly", label: "Weekly", usedPct: 90, resetsAt: "2026-08-31T16:04:13.000Z" },
      ] }]),
  });
  assert.equal(decision.allow, false);
  assert.equal(decision.evaluation.reasons.length, 1);
  const reason = decision.evaluation.reasons[0];
  assert.equal(reason?.kind, "window");
  if (reason?.kind !== "window") throw new Error("expected window reason");
  assert.equal(reason.windowLabel, "Weekly (OpenAI)");
  assert.equal(reason.usedPct, 90);
  assert.equal(reason.resetsAt, "2026-08-31T16:04:13.000Z");
  const message = formatGuardDeny(decision, "codex");
  assert.match(message, /Weekly \(OpenAI\)/);
  assert.match(message, /90%/);
  assert.match(message, /2026-08-31T16:04:13.000Z/);
  assert.match(message, /Session \(OpenAI 5h\)/);
  assert.match(message, /10%/);
  assert.match(message, /2026-08-26T09:24:26.000Z/);
});

test("codex keeps the weekly gate when the session window is omitted", async () => {
  const decision = await runGuard("codex", config({}), {
    fetchUsage: () =>
      snapshot([
        {
          providerId: "codex",
          windows: [{ id: "weekly", label: "Weekly", usedPct: 13 }],
        },
      ]),
  });
  assert.equal(decision.allow, true);
});

test("codex fails closed when the required weekly window is omitted", async () => {
  const decision = await runGuard("codex", config({}), {
    fetchUsage: () =>
      snapshot([
        {
          providerId: "codex",
          windows: [{ id: "session", label: "Session", usedPct: 0 }],
        },
      ]),
  });
  assert.equal(decision.allow, false);
  const reason = decision.evaluation.reasons[0];
  assert.equal(reason?.kind, "usageUnknown");
  if (reason?.kind !== "usageUnknown") throw new Error("expected usageUnknown reason");
  assert.match(reason.detail, /weekly/);
});

test("unreachable usage API fails closed with a reason", async () => {
  const decision = await runGuard("codex", config({}), {
    fetchUsage: () => {
      throw new Error("connect ECONNREFUSED");
    },
  });
  assert.equal(decision.allow, false);
  const reason = decision.evaluation.reasons[0];
  assert.equal(reason?.kind, "usageUnknown");
  if (reason?.kind !== "usageUnknown") throw new Error("expected usageUnknown reason");
  assert.match(reason.detail, /Could not fetch codex usage/);
});

test("fail-open configs allow when usage is unknown", async () => {
  const decision = await runGuard("codex", config({ failClosed: false }), {
    fetchUsage: () => {
      throw new Error("connect ECONNREFUSED");
    },
  });
  assert.equal(decision.allow, true);
});

test("missing provider entry or windows count as unknown usage", async () => {
  const noEntry = await runGuard("codex", config({}), { fetchUsage: () => snapshot([]) });
  assert.equal(noEntry.allow, false);
  const noEntryReason = noEntry.evaluation.reasons[0];
  assert.equal(noEntryReason?.kind, "usageUnknown");
  if (noEntryReason?.kind === "usageUnknown") {
    assert.match(noEntryReason.detail, /No codex usage entry/);
  }

  const noWindows = await runGuard("codex", config({}), {
    fetchUsage: () =>
      snapshot([{ providerId: "codex", status: "unavailable", error: "not signed in" }]),
  });
  assert.equal(noWindows.allow, false);
  const noWindowsReason = noWindows.evaluation.reasons[0];
  assert.equal(noWindowsReason?.kind, "usageUnknown");
  if (noWindowsReason?.kind === "usageUnknown") {
    assert.match(noWindowsReason.detail, /unavailable — not signed in/);
  }
});

test("claude fails closed when a numeric five_hour window is omitted", async () => {
  const decision = await runGuard("claude", config({}), {
    fetchUsage: () =>
      snapshot([
        {
          providerId: "claude",
          windows: [{ id: "weekly", label: "Weekly", usedPct: 10 }],
        },
      ]),
  });
  assert.equal(decision.allow, false);
  const reason = decision.evaluation.reasons[0];
  assert.equal(reason?.kind, "usageUnknown");
  if (reason?.kind !== "usageUnknown") throw new Error("expected usageUnknown reason");
  assert.match(reason.detail, /five_hour/);
});

test("claude still enforces weekly when five_hour is monitor-only and omitted", async () => {
  const decision = await runGuard("claude", config({ claudeFiveHourBlockAt: null }), {
    fetchUsage: () =>
      snapshot([
        {
          providerId: "claude",
          windows: [{ id: "weekly", label: "Weekly", usedPct: 85 }],
        },
      ]),
  });
  assert.equal(decision.allow, false);
  const reason = decision.evaluation.reasons[0];
  assert.equal(reason?.kind, "window");
  if (reason?.kind !== "window") throw new Error("expected window reason");
  assert.equal(reason.windowLabel, "Weekly");
});

test("claude five_hour with null threshold does not require the API window", async () => {
  const decision = await runGuard("claude", config({ claudeFiveHourBlockAt: null }), {
    fetchUsage: () =>
      snapshot([
        {
          providerId: "claude",
          windows: [{ id: "weekly", label: "Weekly", usedPct: 10 }],
        },
      ]),
  });
  assert.equal(decision.allow, true);
  assert.equal(
    decision.evaluation.displayMeasurements?.find((m) => m.windowId === "five_hour"),
    undefined,
  );
});

test("claude fails closed when the required weekly window is omitted", async () => {
  const decision = await runGuard("claude", config({}), {
    fetchUsage: () =>
      snapshot([
        {
          providerId: "claude",
          windows: [{ id: "five_hour", label: "Session", usedPct: 5 }],
        },
      ]),
  });
  assert.equal(decision.allow, false);
  const reason = decision.evaluation.reasons[0];
  assert.equal(reason?.kind, "usageUnknown");
  if (reason?.kind !== "usageUnknown") throw new Error("expected usageUnknown reason");
  assert.match(reason.detail, /weekly/);
});

test("codex fails closed when a numeric session window is omitted", async () => {
  const decision = await runGuard("codex", config({ codexSessionBlockAt: 80 }), {
    fetchUsage: () =>
      snapshot([
        {
          providerId: "codex",
          windows: [{ id: "weekly", label: "Weekly", usedPct: 13 }],
        },
      ]),
  });
  assert.equal(decision.allow, false);
  const reason = decision.evaluation.reasons[0];
  assert.equal(reason?.kind, "usageUnknown");
  if (reason?.kind !== "usageUnknown") throw new Error("expected usageUnknown reason");
  assert.match(reason.detail, /session/);
});

test("override and exceptions bypass every gate", async () => {
  const over = snapshot([
    {
      providerId: "codex",
      windows: [{ id: "session", label: "Session", usedPct: 99 }],
    },
  ]);
  const overridden = await runGuard("codex", config({ codexSessionBlockAt: 50 }), {
    fetchUsage: () => over,
    now: new Date(),
  });
  // No override stored in this temp home — still blocked.
  assert.equal(overridden.allow, false);

  const excluded = await runGuard("codex", config({ codexSessionBlockAt: 50 }), {
    fetchUsage: () => over,
    sessionId: "sess-exempt",
  });
  assert.equal(excluded.allow, false); // not registered yet

  // Register the exception through the same store the guard reads.
  const home = tempHome("llm-budget-guard-exc-");
  const cfg = structuredClone(config({ codexSessionBlockAt: 50 }));
  cfg.excludeSessionIds = ["sess-exempt"];
  const exempted = await runGuard("codex", cfg, {
    home,
    fetchUsage: () => over,
    sessionId: "sess-exempt",
  });
  assert.equal(exempted.allow, true);
});

test("claude weekly window uses the vendor's own window id", async () => {
  const forkNaming = snapshot([
    {
      providerId: "claude",
      windows: [
        { id: "weekly", label: "Weekly", usedPct: 85 },
        { id: "five_hour", label: "Session", usedPct: 5 },
      ],
    },
  ]);
  const denied = await runGuard("claude", config({}), { fetchUsage: () => forkNaming });
  assert.equal(denied.allow, false);
  const reason = denied.evaluation.reasons[0];
  assert.equal(reason?.kind, "window");
  if (reason?.kind === "window") {
    assert.equal(reason.windowLabel, "Weekly");
  }

  const allowed = await runGuard("claude", config({}), { fetchUsage: CLAUDE_SNAPSHOT });
  assert.equal(allowed.allow, true);
});

test("a stale reading still gates and the deny message says how old it is", async () => {
  const stale = (): UsageSnapshot => {
    const s = snapshot([
      { providerId: "claude", windows: [{ id: "weekly", label: "Weekly", usedPct: 85 }, { id: "five_hour", label: "Session", usedPct: 5 }] },
    ]);
    const p = s.providers[0];
    if (p) p.stale = { ageMs: 240_000, reason: "Claude usage API HTTP 429 (rate limited)" };
    return s;
  };
  const decision = await runGuard("claude", config({}), { fetchUsage: stale });
  assert.equal(decision.allow, false);
  assert.equal(decision.evaluation.reasons[0]?.kind, "window");
  const message = formatGuardDeny(decision, "claude", "s1");
  assert.match(message, /Note: Usage reading is 4m old \(refresh: Claude usage API HTTP 429/);
});

function tooStale(weeklyPct: number, resetsAt: string | null): () => UsageSnapshot {
  return () => {
    const s = snapshot([
      { providerId: "claude", status: "error", error: "HTTP 429; last good usage is 30m old (max 10m)" },
    ]);
    const p = s.providers[0];
    if (p) {
      p.lastGood = {
        fetchedAt: "2026-08-24T23:30:00.000Z",
        windows: [
          { id: "weekly", label: "Weekly", usedPct: weeklyPct, resetsAt },
          { id: "five_hour", label: "Session", usedPct: 1, resetsAt: null },
        ],
      };
    }
    return s;
  };
}

test("too-stale data over threshold still blocks even with failClosed off", async () => {
  const now = new Date("2026-08-25T00:00:00.000Z");
  const decision = await runGuard("claude", config({ failClosed: false }), {
    now,
    fetchUsage: tooStale(95, "2026-08-31T00:00:00.000Z"),
  });
  assert.equal(decision.allow, false);
  assert.equal(decision.evaluation.reasons[0]?.kind, "window");
  assert.match(formatGuardDeny(decision, "claude"), /last good usage reading .* current usage is unknown/);
});

test("too-stale data never loosens: under threshold is unknown usage (failClosed decides)", async () => {
  const now = new Date("2026-08-25T00:00:00.000Z");
  const closed = await runGuard("claude", config({}), { now, fetchUsage: tooStale(10, null) });
  assert.equal(closed.allow, false);
  assert.equal(closed.evaluation.reasons[0]?.kind, "usageUnknown");
  const open = await runGuard("claude", config({ failClosed: false }), { now, fetchUsage: tooStale(10, null) });
  assert.equal(open.allow, true);
  // A tripped window that has since reset is no longer evidence of anything.
  const reset = await runGuard("claude", config({ failClosed: false }), {
    now,
    fetchUsage: tooStale(95, "2026-08-24T23:45:00.000Z"),
  });
  assert.equal(reset.allow, true);
});
