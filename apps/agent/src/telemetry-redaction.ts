import type { ExecutionEvent, ExecutionEventSink } from "./execution-events.js";

const REDACTED = "[REDACTED]";
const MAX_DEPTH = 8;

export function createRedactingExecutionEventSink(
  target: ExecutionEventSink,
  values: readonly string[] = [],
): ExecutionEventSink {
  const needles = normalizeValues(values);
  if (needles.length === 0) return target;
  return {
    emit(event) {
      if (event.type === "log") {
        target.emit({ ...event, message: redactText(event.message, needles) });
        return;
      }
      if (event.type === "summary") {
        target.emit({ ...event, data: redactValue(event.data, needles, 0) as Readonly<Record<string, unknown>> });
        return;
      }
      // Inventory/browse/discovery events are structured protocol data. Do not alter
      // identifiers or paths that the controller uses for exact recovery/transfer binding.
      target.emit(event);
    },
  };
}

export function redactTelemetryText(text: string, values: readonly string[]): string {
  return redactText(text, normalizeValues(values));
}

function normalizeValues(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => typeof value === "string").map((value) => value.trim()).filter(Boolean))]
    .sort((left, right) => right.length - left.length || left.localeCompare(right));
}

function redactText(text: string, needles: readonly string[]): string {
  let result = text;
  for (const needle of needles) {
    if (!result.includes(needle)) continue;
    if (needle.length >= 4) {
      result = result.split(needle).join(REDACTED);
      continue;
    }
    // Very short passwords/tokens are still secrets, but replacing every matching
    // character would destroy otherwise harmless logs. Redact short values only
    // when they occur as delimited tokens (for example `password=x` or `:x@`).
    const pattern = new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(needle)}(?=$|[^A-Za-z0-9])`, "g");
    result = result.replace(pattern, (_match, prefix: string) => `${prefix}${REDACTED}`);
  }
  return result;
}

function redactValue(value: unknown, needles: readonly string[], depth: number): unknown {
  if (depth > MAX_DEPTH) return REDACTED;
  if (typeof value === "string") return redactText(value, needles);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, needles, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item, needles, depth + 1)]));
  }
  return value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
