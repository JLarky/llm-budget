import {
  asJsonObject,
  jsonFiniteNumber,
  parseJsonText,
  type JsonObject,
  type JsonValue,
} from "../../json-value.js";

export const DEFAULT_FETCH_TIMEOUT_MS = 5_000;

export type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface JsonResponse {
  status: number;
  text: string;
  json: JsonValue | null;
  /** Parsed `Retry-After` header in ms (seconds or HTTP-date form), else null. */
  retryAfterMs: number | null;
}

/**
 * Parse an HTTP `Retry-After` value: delta-seconds or an HTTP-date.
 * Returns null when absent or unparseable; never negative.
 */
export function parseRetryAfter(value: string | null | undefined, nowMs = Date.now()): number | null {
  const raw = value?.trim();
  if (!raw) return null;
  if (/^\d+(\.\d+)?$/.test(raw)) return Math.max(0, Math.round(Number(raw) * 1000));
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - nowMs);
}

export async function fetchJson(
  url: string,
  init: RequestInit,
  options: { fetch?: FetchFn; timeoutMs?: number } = {},
): Promise<JsonResponse> {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const signal = init.signal ?? (timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined);
  const response = await fetchFn(url, { ...init, signal });
  const text = await response.text();
  let json: JsonValue | null = null;
  const trimmed = text.trim();
  if (trimmed && !trimmed.startsWith("<")) {
    try {
      json = parseJsonText(trimmed);
    } catch {
      json = null;
    }
  }
  return {
    status: response.status,
    text,
    json,
    retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
  };
}

export function asRecord(value: JsonValue | null | undefined): JsonObject | null {
  return asJsonObject(value);
}

export function finiteNumber(value: JsonValue | null | undefined): number | null {
  return jsonFiniteNumber(value);
}
