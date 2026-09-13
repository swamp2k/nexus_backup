import { randomUUID } from "node:crypto";

const ACTIVE_STATES = new Set(["queued", "leased", "preparing", "running", "finalizing"]);

export async function listRepositoryChecks(db, repositories) {
  const rows = (await db.prepare(`
    SELECT id,state,payload_json,created_at,updated_at,started_at,finished_at,last_error
    FROM backup_jobs
    WHERE type='restic-check'
    ORDER BY created_at DESC,id DESC
    LIMIT 1000
  `).all()).results ?? [];

  const latestByRepository = new Map();
  const activeByRepository = new Map();
  for (const row of rows) {
    const payload = parseJsonObject(row.payload_json);
    const repositoryId = typeof payload?.repositoryId === "string" ? payload.repositoryId : null;
    if (!repositoryId) continue;
    const check = presentCheck(row);
    if (!latestByRepository.has(repositoryId)) latestByRepository.set(repositoryId, check);
    if (ACTIVE_STATES.has(check.state) && !activeByRepository.has(repositoryId)) activeByRepository.set(repositoryId, check);
  }

  return (repositories ?? []).map((repository) => {
    const repositoryId = String(repository.id);
    const lastCheck = latestByRepository.get(repositoryId) ?? null;
    const activeCheck = activeByRepository.get(repositoryId) ?? null;
    return {
      ...repository,
      integrity: {
        status: activeCheck ? "checking" : integrityStatus(lastCheck),
        lastCheck,
        activeCheck,
      },
    };
  });
}

export async function queueRepositoryCheck(
  db,
  { repositoryId, repositories, enqueueJob, now = () => new Date(), id = () => randomUUID() },
) {
  const normalizedId = requireRepository(repositoryId, repositories);
  const rows = (await db.prepare(`
    SELECT id,state,payload_json,created_at,updated_at,started_at,finished_at,last_error
    FROM backup_jobs
    WHERE type='restic-check'
      AND state IN ('queued','leased','preparing','running','finalizing')
    ORDER BY created_at DESC,id DESC
    LIMIT 200
  `).all()).results ?? [];
  for (const row of rows) {
    const payload = parseJsonObject(row.payload_json);
    if (payload?.repositoryId === normalizedId) {
      return { job: presentCheck(row), alreadyRunning: true };
    }
  }

  const at = nowDate(now);
  const job = await enqueueJob({
    operationKey: `repository:${normalizedId}:check:${at.toISOString()}:${id()}`,
    type: "restic-check",
    payload: { repositoryId: normalizedId },
  });
  return { job, alreadyRunning: false };
}

function integrityStatus(lastCheck) {
  if (!lastCheck) return "unknown";
  if (lastCheck.state === "completed") return "ok";
  if (lastCheck.state === "failed" || lastCheck.state === "partial" || lastCheck.state === "cancelled" || lastCheck.state === "interrupted") return "failed";
  return ACTIVE_STATES.has(lastCheck.state) ? "checking" : "unknown";
}

function presentCheck(row) {
  return {
    id: String(row.id),
    state: String(row.state),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    startedAt: nullableString(row.started_at),
    finishedAt: nullableString(row.finished_at),
    error: nullableString(row.last_error),
  };
}

function requireRepository(value, repositories) {
  if (typeof value !== "string" || !value.trim() || value.length > 128) throw new RangeError("repositoryId is required");
  const normalized = value.trim();
  if (!(repositories ?? []).some((repository) => repository.id === normalized)) {
    throw statusError(404, `Repository not found: ${normalized}`);
  }
  return normalized;
}

function parseJsonObject(value) {
  if (typeof value !== "string") return null;
  try { const parsed = JSON.parse(value); return isRecord(parsed) ? parsed : null; } catch { return null; }
}

function nowDate(now) {
  const value = now();
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("now() must return a valid date");
  return date;
}

function nullableString(value) { return value === null || value === undefined ? null : String(value); }
function statusError(statusCode, message) { const error = new Error(message); error.statusCode = statusCode; return error; }
function isRecord(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
