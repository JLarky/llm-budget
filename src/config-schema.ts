import * as v from "valibot";

const percent0to100 = v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(100));
const nonNegativeFinite = v.pipe(v.number(), v.finite(), v.minValue(0));
const warningFraction = v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(1));

/**
 * One usage window. `blockAtPercent` is a number to enforce at that
 * threshold, or `null` for monitor-only: measured and shown in status, but
 * never blocks. There is no inheritance between windows or agents — every
 * window states its own value.
 */
export const WindowSchema = v.strictObject({
  blockAtPercent: v.optional(v.nullable(percent0to100)),
});

export const ClaudeSchema = v.strictObject({
  enabled: v.optional(v.boolean()),
  windows: v.optional(
    v.strictObject({
      weekly: v.optional(WindowSchema),
      five_hour: v.optional(WindowSchema),
    }),
  ),
  maxStaleMs: v.optional(nonNegativeFinite),
});

export const CodexSchema = v.strictObject({
  enabled: v.optional(v.boolean()),
  windows: v.optional(
    v.strictObject({
      weekly: v.optional(WindowSchema),
      session: v.optional(WindowSchema),
    }),
  ),
  maxStaleMs: v.optional(nonNegativeFinite),
});

export const CursorSchema = v.strictObject({
  enabled: v.optional(v.boolean()),
  windows: v.optional(
    v.strictObject({
      cursorModels: v.optional(WindowSchema),
      otherModels: v.optional(WindowSchema),
      total: v.optional(WindowSchema),
    }),
  ),
  rateLimit: v.optional(
    v.strictObject({ maxEventsPerHour: v.optional(v.nullable(nonNegativeFinite)) }),
  ),
  maxStaleMs: v.optional(nonNegativeFinite),
  cacheTtlMs: v.optional(nonNegativeFinite),
  warnings: v.optional(v.array(warningFraction)),
  excludeConversationIds: v.optional(v.array(v.string())),
});

export const GrokSchema = v.strictObject({
  enabled: v.optional(v.boolean()),
  windows: v.optional(v.strictObject({ weekly: v.optional(WindowSchema) })),
  excludeSessionIds: v.optional(v.array(v.pipe(v.string(), v.trim(), v.minLength(1)))),
});

/** One schema for the shared config.jsonc — every agent key is typed. */
export const ConfigFileSchema = v.strictObject({
  $schema: v.optional(v.string()),
  _comment: v.optional(v.string()),
  claude: v.optional(ClaudeSchema),
  codex: v.optional(CodexSchema),
  cursor: v.optional(CursorSchema),
  grok: v.optional(GrokSchema),
  enforcement: v.optional(
    v.strictObject({
      failClosed: v.optional(v.boolean()),
    }),
  ),
  excludeSessionIds: v.optional(v.array(v.pipe(v.string(), v.trim(), v.minLength(1)))),
});
