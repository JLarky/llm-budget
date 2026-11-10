#!/usr/bin/env node
import { homedir } from "node:os";
import { formatUsd, formatWindowBar, formatWindowLine, type WindowMeasurement } from "../budget/evaluator.js";
import { parseDuration } from "../budget/windows.js";
import {
  ClaudeHookInputError,
  handleClaudeHook,
  readClaudeHookEvent,
  type ClaudeHookEvent,
} from "./claude-hook.js";
import { installClaudeHooks, uninstallClaudeHooks, claudeHooksInstalled } from "./claude-install.js";
import {
  ensureConfig,
  formatConfigFile,
  loadConfigForRead,
  writeConfig,
} from "../config.js";
import { runWatchdog } from "./codex-watchdog.js";
import {
  installCodexHooks,
  uninstallCodexHooks,
  codexHooksInstalled,
  codexHookTrustStatus,
} from "./codex-install.js";
import { handleCodexHook, readCodexHookEvent, CodexHookInputError, type CodexHookEvent } from "./codex-hook.js";
import { buildMeasurements } from "./guard.js";
import { buildCopilotMeasurements } from "./copilot-measurements.js";
import { getState, openLlmDb, setState } from "./db.js";
import { getCursorOverride } from "../db/client.js";
import { configPath } from "../paths.js";
import {
  fetchDirectUsage,
  type ProviderUsage,
} from "./usage/index.js";
import type { Config } from "../config.js";
import type { DatabaseSync } from "./db.js";
import { streamInOrder } from "./stream-in-order.js";
// Cursor Agent scope — dashboard API; config lives in ~/.config/llm-budget with the other agents.
import { getCursorPeriodUsage } from "../accounting/cursor-api.js";
import { buildCursorMeasurements } from "../cursor-measurements.js";
import { exceptCommand as cursorExceptCommand } from "../commands/except.js";
import { historyCommand as cursorHistoryCommand } from "../commands/history.js";
import { installCommand as cursorInstallCommand, cursorHooksInstalled } from "../commands/install.js";
import { overrideCommand as cursorOverrideCommand } from "../commands/override.js";
import { statusCommand as cursorStatusCommand } from "../commands/status.js";
import { uninstallCommand as cursorUninstallCommand } from "../commands/uninstall.js";
import { configCommand as cursorConfigCommand } from "../commands/config.js";
import { spendingCommand as cursorSpendingCommand } from "../commands/spending.js";
import { handleHook, readStdinJson } from "../hook.js";
import { grokScope, grokStatusSection } from "../grok/scope.js";
import { grokDenyJson, installGrokHook } from "../grok/install.js";

async function main(): Promise<void> {
  // Piping into `head` and friends closes stdout early; exit quietly on EPIPE
  // instead of dumping an unhandled-error stack after the user got their data.
  process.stdout.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") process.exit(0);
    throw err;
  });
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "cursor":
      await cursorScope(rest);
      return;
    case "claude": {
      const sub = rest[0];
      if (sub === "install") {
        process.stdout.write(`${installClaudeHooks()}\n`);
        return;
      }
      if (sub === "uninstall") {
        process.stdout.write(uninstallClaudeHooks());
        return;
      }
      if (sub === "hook") {
        // Internal: registered by `claude install`.
        const event = await readClaudeHookEvent();
        await respondToClaudeHook(event);
        return;
      }
      if (sub === undefined || sub === "-h" || sub === "--help" || sub === "help") {
        process.stdout.write(CLAUDE_SCOPE_HELP);
        return;
      }
      throw new Error(
        "Unknown command: llm-budget claude " + sub +
          "\nRun `llm-budget claude help`.",
      );
    }
    case "codex": {
      const sub = rest[0];
      if (sub === "install") {
        process.stdout.write(`${installCodexHooks()}\n`);
        return;
      }
      if (sub === "uninstall") {
        process.stdout.write(uninstallCodexHooks());
        return;
      }
      if (sub === "hook") {
        const event = await readCodexHookEvent();
        await respondToCodexHook(event);
        return;
      }
      if (sub === undefined || sub === "-h" || sub === "--help" || sub === "help") {
        process.stdout.write(CODEX_SCOPE_HELP);
        return;
      }
      throw new Error(
        "Unknown command: llm-budget codex " + sub +
          "\nRun `llm-budget codex help`.",
      );
    }
    case "grok":
      await grokScope(rest);
      return;
    case "watchdog": {
      const once = rest.includes("--once");
      const intervalFlag = rest.indexOf("--interval");
      const intervalMs =
        intervalFlag >= 0 ? (parseDuration(rest[intervalFlag + 1] ?? "") ?? undefined) : undefined;
      await runWatchdog({ once, intervalMs });
      return;
    }
    case "install": {
      process.stdout.write(installAll());
      return;
    }
    case "status":
    case "usage":
      await statusCommand();
      return;
    case "override":
      process.stdout.write(overrideCommand(rest[0]));
      return;
    case "except":
    case "exclude":
      process.stdout.write(exceptCommand(rest));
      return;
    case "config": {
      process.stdout.write(formatConfigFile());
      return;
    }
    case undefined:
      // No arguments: show the live budget view up front; the help wall is
      // one keystroke away.
      await statusCommand();
      process.stdout.write(
        "\nRun `llm-budget help` for all commands and scopes.\n",
      );
      return;
    case "-h":
    case "--help":
    case "help":
      process.stdout.write(HELP);
      return;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

/** `llm-budget cursor ...` — Cursor Agent scope. */
async function cursorScope(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "hook": {
      const event = await readStdinJson();
      const response = await handleHook(event);
      process.stdout.write(JSON.stringify(response));
      process.exitCode = 0;
      return;
    }
    case "status":
      process.stdout.write(`${await cursorStatusCommand()}\n`);
      return;
    case "spending":
    case "usage-api":
      process.stdout.write(await cursorSpendingCommand());
      return;
    case "config":
      process.stdout.write(cursorConfigCommand());
      return;
    case "override":
      process.stdout.write(cursorOverrideCommand(rest[0]));
      return;
    case "history":
      process.stdout.write(cursorHistoryCommand());
      return;
    case "except":
    case "exclude":
      process.stdout.write(cursorExceptCommand(rest));
      return;
    case "install":
      process.stdout.write(cursorInstallCommand());
      return;
    case "uninstall":
      process.stdout.write(cursorUninstallCommand(rest.includes("--purge-data")));
      return;
    case undefined:
    case "-h":
    case "--help":
    case "help":
      process.stdout.write(CURSOR_HELP);
      return;
    default:
      throw new Error(`Unknown cursor command: ${sub}`);
  }
}

async function respondToClaudeHook(event: ClaudeHookEvent): Promise<void> {
  let response;
  try {
    response = await handleClaudeHook(event);
  } catch (error) {
    blockClaudeHook(
      "UserPromptSubmit",
      `llm-budget failed while checking budget:\n  ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }

  if (response.block && response.message) {
    blockClaudeHook(response.eventName, response.message);
    return;
  }

  // Allow: silent success.
}

/**
 * Block path for Claude Code hooks: the human-readable message goes to stderr
 * (fed back by every hook type) and exit code 2 is the portable blocking
 * error. We deliberately do NOT also write stdout JSON: mixing protocols is
 * ambiguous across client versions — exit 2 + stderr is honored everywhere.
 */
function blockClaudeHook(_eventName: string, message: string): void {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

async function respondToCodexHook(event: CodexHookEvent): Promise<void> {
  const response = await handleCodexHook(event);
  if (response.block && response.message) {
    process.stderr.write(`${response.message}\n`);
    process.exit(2);
  }
}

const CURSOR_HELP = `llm-budget cursor — Cursor Agent usage guard

Usage:
  llm-budget cursor status
  llm-budget cursor spending
  llm-budget cursor config
  llm-budget cursor override <duration>
  llm-budget cursor override off
  llm-budget cursor except add <session-id>
  llm-budget cursor except remove <session-id>
  llm-budget cursor except list
  llm-budget cursor history
  llm-budget cursor install
  llm-budget cursor uninstall [--purge-data]
  llm-budget cursor hook                # Used by the installed hooks

Primary gate uses Cursor dashboard period usage (Cursor Models / Other Models).
Backstop is a local rolling-hour event count.
`;

const CLAUDE_SCOPE_HELP = `llm-budget claude \u2014 Claude Code guard

Commands:
  llm-budget claude install     Register UserPromptSubmit + PreToolUse hooks
                                in ~/.claude/settings.json
  llm-budget claude uninstall   Remove those hooks
  llm-budget claude help        This text
`;

const CODEX_SCOPE_HELP = `llm-budget codex \u2014 Codex guard

Commands:
  llm-budget codex install      Register native UserPromptSubmit + PreToolUse hooks
  llm-budget codex uninstall    Remove native hooks
  llm-budget codex hook         Used by installed hooks
  llm-budget codex help         This text

Optional legacy startup belt:
  llm-budget watchdog [--interval <duration>] [--once]
`;

const HELP = `llm-budget \u2014 percent-based guards for Claude Code, Codex, Cursor Agent, and Grok CLI

Usage:
  llm-budget                    Live status for Claude, Codex, Copilot, Cursor, and Grok
  llm-budget status | usage     Same as the bare invocation
  llm-budget install            Register Claude, Codex, Cursor, and Grok guards
  llm-budget help               This text

Scopes \u2014 every agent supports: install | uninstall | help
  llm-budget claude help        Claude Code \u2014 native hooks in ~/.claude/settings.json
  llm-budget codex help         Codex CLI \u2014 native hooks
  llm-budget cursor help        Cursor Agent \u2014 dashboard API + ~/.cursor/hooks.json
  llm-budget grok help          Grok CLI \u2014 weekly credit pool + ~/.grok/hooks/llm-budget.json

Claude Code, Codex, Cursor Agent, and Grok CLI share
~/.config/llm-budget/config.jsonc. Override and exceptions stay per-scope
so unblocking one agent does not unblock another.

  llm-budget override <duration>         Bypass Claude Code + Codex gates
  llm-budget cursor override <duration>  Bypass Cursor Agent gates
  llm-budget grok override <duration>    Bypass the Grok gate
  llm-budget except add <session-id>
  llm-budget cursor except add <session-id>
  llm-budget grok except add <session-id>
  llm-budget config
  llm-budget cursor config

How limits work: Claude Code and Codex read percentages from Anthropic
and OpenAI usage APIs (local login files). Cursor Agent reads the
Cursor dashboard API. Grok CLI reads xAI's weekly credit-usage API.
Each gate blocks when usage reaches its configured percent. If usage is
unknown the guards block by default (fail closed).
`;

interface Latch<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function pushWindowLines(lines: string[], m: WindowMeasurement, now: Date): void {
  lines.push(`  ${formatWindowLine(m, now)}`);
  const bar = formatWindowBar(m);
  if (bar) lines.push(`  ${bar}`);
}

/** Resolves once, ignoring every resolve() after the first. */
function createLatch<T>(): Latch<T> {
  let settled = false;
  let resolveFn!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolveFn = res;
  });
  return {
    promise,
    resolve(value: T) {
      if (settled) return;
      settled = true;
      resolveFn(value);
    },
  };
}

interface ProviderResult {
  usage: ProviderUsage | null;
  error: string | null;
}

/** Never let a stale reading pass as live in status. */
function pushStaleLine(lines: string[], provider: ProviderUsage): void {
  if (!provider.stale) return;
  const minutes = Math.max(0, Math.round(provider.stale.ageMs / 60_000));
  const age = minutes < 1 ? `${Math.round(provider.stale.ageMs / 1000)}s` : `${minutes}m`;
  lines.push(`  Stale: showing the reading from ${age} ago — ${provider.stale.reason}`);
}

function buildAgentSection(
  agent: "claude" | "codex",
  config: Config,
  db: DatabaseSync,
  home: string,
  now: Date,
  result: ProviderResult,
): string {
  const enabled = agent === "claude" ? config.claude.enabled : config.codex.enabled;
  const lines: string[] = [agent === "claude" ? "Claude Code:" : "Codex:"];
  if (agent === "claude") {
    lines.push(`  Hooks: ${formatInstallState(claudeHooksInstalled(home), "llm-budget claude install")}`);
  } else {
    lines.push(`  Hooks: ${formatInstallState(codexHooksInstalled(home), "llm-budget codex install")}`);
    if (codexHooksInstalled(home)) {
      lines.push(`  Trust: ${codexHookTrustStatus(home)}`);
    }
  }
  if (!enabled) {
    lines.push("  disabled in config");
    return lines.join("\n");
  }

  const { usage: provider, error: fetchError } = result;
  if (!provider && !fetchError) {
    lines.push(`  Usage unknown — no ${agent} entry`);
  } else if (!provider && fetchError) {
    lines.push(`  Usage unknown — ${fetchError}`);
  } else if (provider) {
    if (provider.status !== "available") {
      lines.push(
        `  Usage ${provider.status}` + (provider.error ? ` — ${provider.error}` : ""),
      );
    }
    if (provider.windows.length === 0) {
      lines.push("  No usage windows reported yet");
    }
    for (const m of buildMeasurements(agent, config, provider)) {
      pushWindowLines(lines, m, now);
    }
    pushStaleLine(lines, provider);
  }

  // Escape hatches for this store (Claude Code and Codex share it).
  // Cursor Agent's override/exceptions render in its own block below.
  // Expired overrides must display as none — same rule as Cursor status.
  const overrideRaw = getState(db, "override_until");
  const overrideUntil = overrideRaw ? new Date(overrideRaw) : null;
  const overrideActive = Boolean(overrideUntil && overrideUntil.getTime() > now.getTime());
  lines.push(`  Override: ${overrideActive ? `until ${overrideUntil?.toLocaleString()}` : "none"}`);
  lines.push(
    `  Exceptions: ${config.excludeSessionIds.length > 0 ? config.excludeSessionIds.join(", ") : "none"}`,
  );
  return lines.join("\n");
}

function buildCopilotSection(now: Date, result: ProviderResult): string {
  const lines: string[] = ["GitHub Copilot:"];
  const { usage: copilot, error: fetchError } = result;
  if (!copilot && fetchError) {
    lines.push(`  Usage unknown — ${fetchError}`);
  } else if (!copilot) {
    lines.push("  Usage unknown — no copilot entry");
  } else if (copilot.status !== "available") {
    lines.push(`  Usage ${copilot.status}` + (copilot.error ? ` — ${copilot.error}` : ""));
  } else {
    if (copilot.planLabel) lines.push(`  Plan: ${copilot.planLabel}`);
    const measurements = buildCopilotMeasurements(copilot);
    if (measurements.length === 0) {
      lines.push("  not metered on this plan");
    } else {
      for (const m of measurements) {
        pushWindowLines(lines, m, now);
      }
    }
    pushStaleLine(lines, copilot);
  }
  return lines.join("\n");
}

async function buildCursorSection(config: Config, home: string, now: Date): Promise<string> {
  const lines: string[] = ["Cursor Agent:"];
  lines.push(`  Hooks: ${formatInstallState(cursorHooksInstalled(home), "llm-budget cursor install")}`);
  if (!config.cursor.enabled) {
    lines.push("  disabled in config");
    return lines.join("\n");
  }
  try {
    const result = await getCursorPeriodUsage({ home, cacheTtlMs: config.cursor.cacheTtlMs, now });
    const plan = result.usage.planUsage;
    for (const m of buildCursorMeasurements(config, plan)) {
      pushWindowLines(lines, m, now);
    }
    lines.push(
      `  Period spend: ${
        plan.limitUsd != null
          ? `${formatUsd(plan.totalSpendUsd)} / ${formatUsd(plan.limitUsd)}`
          : formatUsd(plan.totalSpendUsd)
      }`,
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message.split(":")[0] : String(error);
    lines.push(`  Dashboard usage: unavailable (${detail}) — sign in with cursor-agent`);
  }
  const cursorOverrideRaw = getCursorOverride(openLlmDb(home));
  const cursorOverrideUntil = cursorOverrideRaw ? new Date(cursorOverrideRaw) : null;
  const cursorOverrideActive = cursorOverrideUntil && cursorOverrideUntil.getTime() > now.getTime();
  lines.push(
    `  Override: ${cursorOverrideActive ? `until ${cursorOverrideUntil?.toLocaleString()}` : "none"}`,
  );
  lines.push(
    `  Exceptions: ${
      config.cursor.excludeConversationIds.length > 0
        ? config.cursor.excludeConversationIds.join(", ")
        : "none"
    }`,
  );
  return lines.join("\n");
}

async function statusCommand(home = homedir()): Promise<void> {
  const { config, warning } = loadConfigForRead(home);
  const db = openLlmDb(home);
  const now = new Date();
  const header: string[] = ["llm-budget"];
  if (warning) header.push(warning, "");
  header.push(`Config: ${configPath(home)}`);
  header.push(
    `On unknown usage: ${config.enforcement.failClosed ? "block (failClosed)" : "allow (failClosed off)"}`,
  );
  process.stdout.write(`${header.join("\n")}\n`);

  // Fan out: claude/codex/copilot are fetched together (they share a cache),
  // cursor and grok independently — each resolves its own latch as soon as
  // its own data is ready so the printer isn't stuck waiting on the others.
  const claudeLatch = createLatch<ProviderResult>();
  const codexLatch = createLatch<ProviderResult>();
  const copilotLatch = createLatch<ProviderResult>();
  fetchDirectUsage({
    home,
    maxStaleMs: { claude: config.claude.maxStaleMs, codex: config.codex.maxStaleMs },
    onProvider: (usage) => {
      const result = { usage, error: null };
      if (usage.providerId === "claude") claudeLatch.resolve(result);
      else if (usage.providerId === "codex") codexLatch.resolve(result);
      else if (usage.providerId === "copilot") copilotLatch.resolve(result);
    },
  })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      const result = { usage: null, error: message };
      claudeLatch.resolve(result);
      codexLatch.resolve(result);
      copilotLatch.resolve(result);
    })
    .then(() => {
      // Belt-and-suspenders: a provider missing from the snapshot must not
      // hang the printer forever.
      const missing = { usage: null, error: null };
      claudeLatch.resolve(missing);
      codexLatch.resolve(missing);
      copilotLatch.resolve(missing);
    });

  await streamInOrder(
    [
      async () => buildAgentSection("claude", config, db, home, now, await claudeLatch.promise),
      async () => buildAgentSection("codex", config, db, home, now, await codexLatch.promise),
      async () => buildCopilotSection(now, await copilotLatch.promise),
      () => buildCursorSection(config, home, now),
      () => grokStatusSection(home, now),
    ],
    200,
  );
}

function overrideCommand(spec: string | undefined): string {
  ensureConfig();
  const db = openLlmDb();
  if (!spec || spec === "off") {
    setState(db, "override_until", "");
    return "Override cleared. Limits will be enforced again.\n";
  }
  const ms = parseDuration(spec);
  if (ms == null) {
    throw new Error("Override duration must look like 15m, 30m, 1h, or off");
  }
  const until = new Date(Date.now() + ms);
  setState(db, "override_until", until.toISOString());
  return `Override active until ${until.toLocaleString()}.\n`;
}

function exceptCommand(args: string[], home = homedir()): string {
  const config = ensureConfig(home);
  const [actionOrId, maybeId] = args;
  if (!actionOrId || actionOrId === "list") {
    return formatList(config.excludeSessionIds);
  }
  if (actionOrId === "remove" || actionOrId === "rm") {
    const id = maybeId?.trim() ?? "";
    if (!id) throw new Error("Usage: llm-budget except remove <session-id>");
    const next = config.excludeSessionIds.filter((existing) => existing !== id);
    writeConfig({ ...config, excludeSessionIds: next }, home);
    return next.length === config.excludeSessionIds.length
      ? `No exception for ${id}.\n`
      : `Removed exception for ${id}.\n${formatList(next)}`;
  }
  if (actionOrId.startsWith("-")) {
    throw new Error(
      "Usage: llm-budget except add <session-id>\n       llm-budget except remove <session-id>\n       llm-budget except list",
    );
  }
  const id = (actionOrId === "add" ? (maybeId ?? "") : actionOrId).trim();
  if (!id || (actionOrId === "add" && !maybeId) || id.startsWith("-")) {
    throw new Error("Usage: llm-budget except add <session-id>");
  }
  if (config.excludeSessionIds.includes(id)) {
    return `Already excepted: ${id}\n${formatList(config.excludeSessionIds)}`;
  }
  const next = [...config.excludeSessionIds, id];
  writeConfig({ ...config, excludeSessionIds: next }, home);
  return `Excepted ${id}. It will bypass every gate.\n${formatList(next)}`;
}

function formatList(ids: string[]): string {
  if (ids.length === 0) return "No session exceptions.\n";
  return `Session exceptions (${ids.length}):\n${ids.map((id) => `  ${id}`).join("\n")}\n`;
}

function formatInstallState(installed: boolean, installCommand: string): string {
  return installed ? "installed" : `not installed — run ${installCommand}`;
}

function installAll(home = homedir()): string {
  const sections = [
    installClaudeHooks(home),
    installCodexHooks(home),
    cursorInstallCommand(home),
    installGrokHook(home),
  ];
  return `${sections.map((section) => section.trimEnd()).join("\n\n")}\n`;
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  const argv = process.argv.slice(2);
  if (argv[0] === "claude" && argv[1] === "hook") {
    // Unreadable stdin / unexpected crash must fail closed: Claude Code always
    // sends JSON, so silence or garbage means something upstream is broken.
    const detail =
      error instanceof ClaudeHookInputError
        ? message
        : `unexpected hook failure: ${message}`;
    blockClaudeHook(
      "UserPromptSubmit",
      [
        "llm-budget could not verify your budget:",
        `  ${detail}`,
        "",
        "Blocked because enforcement.failClosed is on (the default).",
        "",
        "Recover with:",
        "  llm-budget override 30m",
        "  llm-budget status",
      ].join("\n"),
    );
    return;
  }
  if (argv[0] === "codex" && argv[1] === "hook") {
    const detail = error instanceof CodexHookInputError ? message : `unexpected hook failure: ${message}`;
    process.stderr.write(`llm-budget could not verify your budget:\n  ${detail}\n\nBlocked because enforcement.failClosed is on (the default).\n\nRecover with:\n  llm-budget override 30m\n  llm-budget status\n`);
    process.exit(2);
    return;
  }
  if (argv[0] === "grok" && argv[1] === "hook") {
    process.stdout.write(
      `${grokDenyJson(`llm-budget could not verify the Grok budget: ${message}. Recover with: llm-budget grok override 30m | llm-budget grok status`)}\n`,
    );
    process.exit(2);
    return;
  }
  if (argv[0] === "watchdog") {
    process.stderr.write(`llm-budget ${argv[0]} failed: ${message}\n`);
    process.exit(2);
  }
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
