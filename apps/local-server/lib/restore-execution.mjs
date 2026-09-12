import { randomUUID } from "node:crypto";

const ACTIVE_STATES = new Set(["queued", "leased", "preparing", "running", "finalizing"]);
const PREVIEW_MAX_AGE_MS = 30 * 60 * 1000;

export async function assertRecentRestorePreview(
  db,
  { repositoryId, snapshotId, targetId, path, now = () => new Date() },
) {
  const scope = normalizeScope({ repositoryId, snapshotId, targetId, path });
  const rows = (await db.prepare(`
    SELECT id, state, payload_json, finished_at, last_error
    FROM backup_jobs
    WHERE type = 'restic-restore-preview'
      AND state = 'completed'
      AND finished_at IS NOT NULL
    ORDER BY finished_at DESC
    LIMIT 300
  `).all()).results ?? [];
  const cutoff = nowDate(now).getTime() - PREVIEW_MAX_AGE_MS;
  for (const row of rows) {
    const finishedAt = Date.parse(String(row.finished_at));
    if (!Number.isFinite(finishedAt) || finishedAt < cutoff) continue;
    const payload = parseJsonObject(row.payload_json);
    if (!payload) continue;
    if (sameScope(scope, normalizeScope(payload))) {
      return { id: String(row.id), finishedAt: String(row.finished_at) };
    }
  }
  throw statusError(409, "A successful restore preview for this exact selection is required within the last 30 minutes");
}

export async function queueRestoreExecution(
  db,
  {
    repositoryId,
    snapshotId,
    targetId,
    path,
    repositories,
    restoreTargets,
    enqueueJob,
    now = () => new Date(),
    id = () => randomUUID(),
  },
) {
  const scope = normalizeScope({ repositoryId, snapshotId, targetId, path });
  requireConfiguredRepository(scope.repositoryId, repositories);
  const target = requireWriteTarget(scope.targetId, restoreTargets);
  await assertSnapshotExists(db, scope.repositoryId, scope.snapshotId);
  if (scope.path && scope.path !== "/") await assertKnownBrowseEntry(db, scope.repositoryId, scope.snapshotId, scope.path);
  await assertRecentRestorePreview(db, { ...scope, now });

  const active = await findActiveRestore(db, scope);
  if (active) return { job: active, alreadyRunning: true, target: publicTarget(target) };

  const at = nowDate(now);
  const job = await enqueueJob({
    operationKey: `restore:${scope.repositoryId}:${scope.snapshotId.slice(0, 12)}:${at.getTime()}:${id()}`,
    type: "restic-restore",
    payload: {
      repositoryId: scope.repositoryId,
      snapshotId: scope.snapshotId,
      targetId: scope.targetId,
      ...(scope.path ? { path: scope.path } : {}),
    },
  });
  return { job, alreadyRunning: false, target: publicTarget(target) };
}

export function normalizeRestoreScope(value) {
  return normalizeScope(value);
}

async function assertSnapshotExists(db, repositoryId, snapshotId) {
  const row = await db.prepare(`SELECT snapshot_id FROM repository_snapshots WHERE repository_id = ? AND snapshot_id = ?`)
    .bind(repositoryId, snapshotId).first();
  if (!row) throw statusError(404, `Snapshot not found in repository inventory: ${snapshotId}`);
}

async function assertKnownBrowseEntry(db, repositoryId, snapshotId, path) {
  const rows = (await db.prepare(`
    SELECT entries_json FROM repository_snapshot_browse
    WHERE repository_id = ? AND snapshot_id = ?
  `).bind(repositoryId, snapshotId).all()).results ?? [];
  for (const row of rows) {
    for (const entry of parseJsonArray(row.entries_json)) {
      if (entry && typeof entry === "object" && entry.path === path) return;
    }
  }
  throw statusError(400, `Snapshot path has not been discovered by the browser: ${path}`);
}

async function findActiveRestore(db, scope) {
  const rows = (await db.prepare(`
    SELECT id, state, payload_json, created_at, updated_at, finished_at, last_error
    FROM backup_jobs
    WHERE type = 'restic-restore'
      AND state IN ('queued','leased','preparing','running','finalizing')
    ORDER BY created_at DESC
    LIMIT 200
  `).all()).results ?? [];
  for (const row of rows) {
    const payload = parseJsonObject(row.payload_json);
    if (payload && sameScope(scope, normalizeScope(payload))) {
      return {
        id: String(row.id), state: String(row.state), createdAt: String(row.created_at),
        updatedAt: String(row.updated_at), finishedAt: nullable(row.finished_at), error: nullable(row.last_error),
      };
    }
  }
  return null;
}

function requireConfiguredRepository(id, repositories) {
  if (!(repositories ?? []).some((repository) => repository.id === id)) throw statusError(404, `Repository not found: ${id}`);
}

function requireWriteTarget(id, targets) {
  const target = (targets ?? []).find((candidate) => candidate.id === id);
  if (!target) throw statusError(404, `Restore target not found: ${id}`);
  if (target.writeEnabled !== true) throw statusError(403, `Restore target is preview-only: ${id}`);
  return target;
}

function publicTarget(target) { return { id: target.id, label: target.label ?? target.id, overwrite: target.overwrite ?? "never", writeEnabled: true }; }
function normalizeScope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RangeError("restore scope must be an object");
  return {
    repositoryId: requireString(value.repositoryId, "repositoryId", 1, 128),
    snapshotId: requireSnapshotId(value.snapshotId),
    targetId: requireString(value.targetId, "targetId", 1, 128),
    path: value.path === undefined || value.path === null || value.path === "" ? null : requireSnapshotPath(value.path),
  };
}
function sameScope(a, b) { return a.repositoryId === b.repositoryId && a.snapshotId === b.snapshotId && a.targetId === b.targetId && a.path === b.path; }
function requireSnapshotId(value) { const id = requireString(value, "snapshotId", 8, 64); if (!/^[A-Fa-f0-9]{8,64}$/.test(id)) throw new RangeError("snapshotId must be a hexadecimal Restic snapshot id"); return id; }
function requireSnapshotPath(value) { if (typeof value !== "string" || value.length < 1 || value.length > 4096) throw new RangeError("path must be 1-4096 characters"); if (!value.startsWith("/")) throw new RangeError("snapshot path must be absolute"); if (value.includes("\0")) throw new RangeError("snapshot path contains an invalid character"); if (value.split("/").some((part) => part === "." || part === "..")) throw new RangeError("snapshot path may not contain dot segments"); return value.length > 1 ? value.replace(/\/+$/, "") || "/" : "/"; }
function requireString(value, name, min, max) { if (typeof value !== "string") throw new RangeError(`${name} must be a string`); const normalized = value.trim(); if (normalized.length < min || normalized.length > max) throw new RangeError(`${name} must be ${min}-${max} characters`); return normalized; }
function parseJsonObject(value) { if (typeof value !== "string") return null; try { const parsed = JSON.parse(value); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null; } catch { return null; } }
function parseJsonArray(value) { if (typeof value !== "string") return []; try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; } }
function nowDate(now) { const value = now(); const date = value instanceof Date ? new Date(value) : new Date(value); if (!Number.isFinite(date.getTime())) throw new TypeError("now() must return a valid date"); return date; }
function nullable(value) { return value === null || value === undefined ? null : String(value); }
function statusError(statusCode, message) { const error = new Error(message); error.statusCode = statusCode; return error; }
