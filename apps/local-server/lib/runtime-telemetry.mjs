import { randomUUID } from "node:crypto";
import { normalizeTransferGroupsEvent, persistTransferGroups } from "./transfer-groups.mjs";
import { normalizeTransferDiscoveryEvent, persistTransferDiscovery } from "./transfer-rules.mjs";

const TOOLS = new Set(["rclone"]);
const STREAMS = new Set(["stdout", "stderr"]);
const RUNTIME_KINDS = new Set(["standard", "transfer-discovery"]);
const MAX_BATCH = 100;
const MAX_MESSAGE = 16_000;
const MAX_SUMMARY_JSON = 65_536;

export async function recordRuntimeEvents(
  db,
  {
    jobId,
    attempt,
    agentId,
    events,
    runtimeKind,
    expectedRepositoryId,
    expectedSnapshotId,
    expectedPath,
    expectedRuleId,
    now = new Date(),
    logLimit = 500,
  },
) {
  const normalized = normalizeRuntimeEvents(events, now, {
    runtimeKind,
    expectedRepositoryId,
    expectedSnapshotId,
    expectedPath,
    expectedRuleId,
  });
  const statements = [];
  const discoveries = [];
  const transferGroups = [];
  let wroteLog = false;

  for (const event of normalized) {
    if (event.type === "transfer-discovery") { discoveries.push(event); continue; }
    if (event.type === "transfer-groups") { transferGroups.push(event); continue; }

    if (event.type === "progress") {
      statements.push(db.prepare(`
        INSERT INTO backup_job_runtime_progress (
          job_id, attempt, agent_id, tool, updated_at,
          bytes_done, bytes_total, files_done, files_total,
          speed_bytes_per_second, eta_seconds, errors
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(job_id, attempt) DO UPDATE SET
          agent_id = excluded.agent_id,
          tool = excluded.tool,
          updated_at = excluded.updated_at,
          bytes_done = excluded.bytes_done,
          bytes_total = excluded.bytes_total,
          files_done = excluded.files_done,
          files_total = excluded.files_total,
          speed_bytes_per_second = excluded.speed_bytes_per_second,
          eta_seconds = excluded.eta_seconds,
          errors = excluded.errors
      `).bind(
        jobId, attempt, agentId, event.tool, event.at,
        event.bytesDone ?? null, event.bytesTotal ?? null,
        event.filesDone ?? null, event.filesTotal ?? null,
        event.speedBytesPerSecond ?? null, event.etaSeconds ?? null, event.errors ?? null,
      ));
      continue;
    }

    if (event.type === "summary") {
      statements.push(db.prepare(`
        INSERT INTO backup_job_runtime_progress (
          job_id, attempt, agent_id, tool, updated_at, summary_json
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(job_id, attempt) DO UPDATE SET
          agent_id = excluded.agent_id,
          tool = excluded.tool,
          updated_at = excluded.updated_at,
          summary_json = excluded.summary_json
      `).bind(jobId, attempt, agentId, event.tool, event.at, JSON.stringify(event.data)));
      continue;
    }

    wroteLog = true;
    statements.push(db.prepare(`
      INSERT INTO backup_job_runtime_logs (
        id, job_id, attempt, agent_id, at, tool, stream, message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(randomUUID(), jobId, attempt, agentId, event.at, event.tool, event.stream, event.message));
  }

  if (wroteLog) {
    const keep = clampInteger(logLimit, 1, 5_000, 500);
    statements.push(db.prepare(`
      DELETE FROM backup_job_runtime_logs
      WHERE job_id = ? AND attempt = ?
        AND id NOT IN (
          SELECT id FROM backup_job_runtime_logs
          WHERE job_id = ? AND attempt = ?
          ORDER BY at DESC, seq DESC
          LIMIT ?
        )
    `).bind(jobId, attempt, jobId, attempt, keep));
  }

  if (statements.length > 0) await db.batch(statements);
  for (const discovery of discoveries) {
    await persistTransferDiscovery(db, { jobId, attempt, agentId, expectedRuleId, event: discovery, at: now });
  }
  for (const groups of transferGroups) {
    await persistTransferGroups(db, { jobId, attempt, agentId, expectedRuleId, event: groups, at: now });
  }
  return normalized.length;
}

export async function getRuntimeTelemetry(db, jobId, attempt, { logLimit = 200 } = {}) {
  const progressRow = await db.prepare(`
    SELECT * FROM backup_job_runtime_progress
    WHERE job_id = ? AND attempt = ?
  `).bind(jobId, attempt).first();

  const limit = clampInteger(logLimit, 1, 500, 200);
  const logResult = await db.prepare(`
    SELECT id, at, tool, stream, message, seq
    FROM backup_job_runtime_logs
    WHERE job_id = ? AND attempt = ?
    ORDER BY at DESC, seq DESC
    LIMIT ?
  `).bind(jobId, attempt, limit).all();

  const logs = (logResult.results ?? []).map((row) => ({
    id: String(row.id), at: String(row.at), tool: String(row.tool), stream: String(row.stream), message: String(row.message),
  })).reverse();

  if (!progressRow) return { attempt, progress: null, summary: null, logs };
  return {
    attempt,
    progress: {
      tool: String(progressRow.tool), updatedAt: String(progressRow.updated_at),
      bytesDone: nullableNumber(progressRow.bytes_done), bytesTotal: nullableNumber(progressRow.bytes_total),
      filesDone: nullableNumber(progressRow.files_done), filesTotal: nullableNumber(progressRow.files_total),
      speedBytesPerSecond: nullableNumber(progressRow.speed_bytes_per_second), etaSeconds: nullableNumber(progressRow.eta_seconds),
      errors: nullableNumber(progressRow.errors),
    },
    summary: parseJsonObject(progressRow.summary_json),
    logs,
  };
}

export function normalizeRuntimeEvents(value, now = new Date(), {
  runtimeKind,
  expectedRepositoryId,
  expectedSnapshotId,
  expectedPath,
  expectedRuleId,
} = {}) {
  if (!Array.isArray(value) || value.length === 0) throw new RangeError("events must be a non-empty array");
  if (value.length > MAX_BATCH) throw new RangeError(`events may contain at most ${MAX_BATCH} items`);
  const effectiveKind = runtimeKind ?? inferRuntimeKind({ expectedRepositoryId, expectedSnapshotId, expectedPath, expectedRuleId });
  if (!RUNTIME_KINDS.has(effectiveKind)) throw new RangeError("runtimeKind is invalid");

  let discoveryCount = 0;
  let transferGroupCount = 0;
  return value.map((event) => {
    if (isRecord(event) && event.type === "transfer-discovery") {
      if (effectiveKind !== "transfer-discovery") throw new RangeError("transfer discovery events are only accepted from rclone-discovery jobs");
      discoveryCount += 1;
      if (discoveryCount > 1) throw new RangeError("runtime batch may contain at most one transfer discovery event");
      return normalizeTransferDiscoveryEvent(event, { expectedRuleId, now });
    }
    if (isRecord(event) && event.type === "transfer-groups") {
      if (effectiveKind !== "transfer-discovery") throw new RangeError("transfer group events are only accepted from rclone-discovery jobs");
      transferGroupCount += 1;
      if (transferGroupCount > 1) throw new RangeError("runtime batch may contain at most one transfer groups event");
      return normalizeTransferGroupsEvent(event, { expectedRuleId, now });
    }
    return normalizeRuntimeEvent(event, now);
  });
}

function inferRuntimeKind({ expectedRepositoryId, expectedSnapshotId, expectedPath, expectedRuleId }) {
	if (expectedRuleId !== undefined) return "transfer-discovery";
	return "standard";
}

function normalizeRuntimeEvent(value, now) {
  if (!isRecord(value)) throw new RangeError("runtime event must be an object");
  const type = value.type;
  const tool = requireEnum(value.tool, TOOLS, "tool");
  const at = normalizeAt(value.at, now);

  if (type === "log") {
    const stream = requireEnum(value.stream, STREAMS, "stream");
    if (typeof value.message !== "string") throw new RangeError("log message must be a string");
    const message = value.message.trimEnd();
    if (!message || message.length > MAX_MESSAGE) throw new RangeError(`log message must be 1-${MAX_MESSAGE} characters`);
    return { type, tool, stream, message, at };
  }

  if (type === "progress") {
    return {
      type, tool, at,
      bytesDone: optionalNonNegativeNumber(value.bytesDone, "bytesDone"),
      bytesTotal: optionalNonNegativeNumber(value.bytesTotal, "bytesTotal"),
      filesDone: optionalNonNegativeNumber(value.filesDone, "filesDone"),
      filesTotal: optionalNonNegativeNumber(value.filesTotal, "filesTotal"),
      speedBytesPerSecond: optionalNonNegativeNumber(value.speedBytesPerSecond, "speedBytesPerSecond"),
      etaSeconds: value.etaSeconds === null ? null : optionalNonNegativeNumber(value.etaSeconds, "etaSeconds"),
      errors: optionalNonNegativeNumber(value.errors, "errors"),
    };
  }

  if (type === "summary") {
    if (!isRecord(value.data)) throw new RangeError("summary data must be an object");
    const encoded = JSON.stringify(value.data);
    if (encoded.length > MAX_SUMMARY_JSON) throw new RangeError("summary data is too large");
    return { type, tool, data: value.data, at };
  }

  throw new RangeError("runtime event type must be log, progress, summary, transfer-discovery, or transfer-groups");
}

function normalizeAt(value, fallback) { if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return fallback.toISOString(); return new Date(value).toISOString(); }
function requireEnum(value, allowed, name) { if (typeof value !== "string" || !allowed.has(value)) throw new RangeError(`${name} is invalid`); return value; }
function optionalNonNegativeNumber(value, name) { if (value === undefined) return undefined; if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be a finite non-negative number`); return value; }
function nullableNumber(value) { return value === null || value === undefined ? null : Number(value); }
function parseJsonObject(value) { if (typeof value !== "string" || !value) return null; try { const parsed = JSON.parse(value); return isRecord(parsed) ? parsed : null; } catch { return null; } }
function clampInteger(value, min, max, fallback) { const number = Number(value); if (!Number.isInteger(number)) return fallback; return Math.min(max, Math.max(min, number)); }
function isRecord(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
