import { randomUUID } from "node:crypto";

const ACTIVE_STATES = new Set(["queued", "leased", "preparing", "running", "finalizing"]);
const MAX_ENTRIES = 1000;
const MAX_EVENT_JSON = 700_000;

export async function persistSnapshotBrowse(
  db,
  { jobId, attempt, agentId, expectedRepositoryId, expectedSnapshotId, expectedPath, event, at = new Date() },
) {
  const normalized = normalizeSnapshotBrowseEvent(event, {
    expectedRepositoryId,
    expectedSnapshotId,
    expectedPath,
    now: at,
  });
  await db.prepare(`
    INSERT INTO repository_snapshot_browse (
      repository_id, snapshot_id, browse_path, job_id, attempt, agent_id,
      scanned_at, entries_json, entry_limit, returned_entries, truncated
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(repository_id, snapshot_id, browse_path) DO UPDATE SET
      job_id = excluded.job_id,
      attempt = excluded.attempt,
      agent_id = excluded.agent_id,
      scanned_at = excluded.scanned_at,
      entries_json = excluded.entries_json,
      entry_limit = excluded.entry_limit,
      returned_entries = excluded.returned_entries,
      truncated = excluded.truncated
  `).bind(
    normalized.repositoryId,
    normalized.snapshotId,
    normalized.path,
    jobId,
    attempt,
    agentId,
    normalized.at,
    JSON.stringify(normalized.entries),
    normalized.entryLimit,
    normalized.entries.length,
    normalized.truncated ? 1 : 0,
  ).run();
  return normalized;
}

export async function getSnapshotBrowse(db, { repositoryId, snapshotId, path }) {
  const normalizedRepositoryId = requireString(repositoryId, "repositoryId", 1, 128);
  const normalizedSnapshotId = requireSnapshotId(snapshotId);
  const normalizedPath = requireSnapshotPath(path ?? "/");
  await assertSnapshotExists(db, normalizedRepositoryId, normalizedSnapshotId);

  const row = await db.prepare(`
    SELECT * FROM repository_snapshot_browse
    WHERE repository_id = ? AND snapshot_id = ? AND browse_path = ?
  `).bind(normalizedRepositoryId, normalizedSnapshotId, normalizedPath).first();
  const jobs = await browseJobs(db, normalizedRepositoryId, normalizedSnapshotId, normalizedPath);

  return {
    repositoryId: normalizedRepositoryId,
    snapshotId: normalizedSnapshotId,
    path: normalizedPath,
    browse: row ? browseRow(row) : null,
    activeJob: jobs.find((job) => ACTIVE_STATES.has(job.state)) ?? null,
    lastJob: jobs[0] ?? null,
  };
}

export async function queueSnapshotBrowse(
  db,
  { repositoryId, snapshotId, path = "/", repositories, enqueueJob, now = () => new Date(), id = () => randomUUID() },
) {
  const normalizedRepositoryId = requireConfiguredRepository(repositoryId, repositories);
  const normalizedSnapshotId = requireSnapshotId(snapshotId);
  const normalizedPath = requireSnapshotPath(path);
  await assertSnapshotExists(db, normalizedRepositoryId, normalizedSnapshotId);
  if (normalizedPath !== "/") await assertKnownBrowseDirectory(db, normalizedRepositoryId, normalizedSnapshotId, normalizedPath);

  const jobs = await browseJobs(db, normalizedRepositoryId, normalizedSnapshotId, normalizedPath);
  const active = jobs.find((job) => ACTIVE_STATES.has(job.state));
  if (active) return { job: active, alreadyRunning: true };

  const at = nowDate(now);
  const job = await enqueueJob({
    operationKey: `browse:${normalizedRepositoryId}:${normalizedSnapshotId.slice(0, 12)}:${at.getTime()}:${id()}`,
    type: "restic-browse",
    payload: {
      repositoryId: normalizedRepositoryId,
      snapshotId: normalizedSnapshotId,
      path: normalizedPath,
    },
  });
  return { job, alreadyRunning: false };
}

export async function queueRestorePreview(
  db,
  { repositoryId, snapshotId, targetId, path, repositories, restoreTargets, enqueueJob, now = () => new Date(), id = () => randomUUID() },
) {
  const normalizedRepositoryId = requireConfiguredRepository(repositoryId, repositories);
  const normalizedSnapshotId = requireSnapshotId(snapshotId);
  const normalizedTargetId = requireConfiguredTarget(targetId, restoreTargets);
  const normalizedPath = path === undefined || path === null || path === "" ? null : requireSnapshotPath(path);
  await assertSnapshotExists(db, normalizedRepositoryId, normalizedSnapshotId);
  if (normalizedPath && normalizedPath !== "/") {
    await assertKnownBrowseEntry(db, normalizedRepositoryId, normalizedSnapshotId, normalizedPath);
  }

  const active = await findActivePreview(db, {
    repositoryId: normalizedRepositoryId,
    snapshotId: normalizedSnapshotId,
    targetId: normalizedTargetId,
    path: normalizedPath,
  });
  if (active) return { job: active, alreadyRunning: true };

  const at = nowDate(now);
  const job = await enqueueJob({
    operationKey: `restore-preview:${normalizedRepositoryId}:${normalizedSnapshotId.slice(0, 12)}:${at.getTime()}:${id()}`,
    type: "restic-restore-preview",
    payload: {
      repositoryId: normalizedRepositoryId,
      snapshotId: normalizedSnapshotId,
      targetId: normalizedTargetId,
      ...(normalizedPath ? { path: normalizedPath } : {}),
    },
  });
  return { job, alreadyRunning: false };
}

export function normalizeSnapshotBrowseEvent(value, {
  expectedRepositoryId,
  expectedSnapshotId,
  expectedPath,
  now = new Date(),
} = {}) {
  if (!isRecord(value) || value.type !== "snapshot-browse" || value.tool !== "restic") {
    throw new RangeError("snapshot browse event must be a restic snapshot-browse object");
  }
  const repositoryId = requireString(value.repositoryId, "repositoryId", 1, 128);
  const snapshotId = requireSnapshotId(value.snapshotId);
  const path = requireSnapshotPath(value.path);
  if (repositoryId !== expectedRepositoryId) throw new RangeError("snapshot browse repositoryId does not match the job payload");
  if (snapshotId !== expectedSnapshotId) throw new RangeError("snapshot browse snapshotId does not match the job payload");
  if (path !== requireSnapshotPath(expectedPath ?? "/")) throw new RangeError("snapshot browse path does not match the job payload");
  if (!Array.isArray(value.entries)) throw new RangeError("snapshot browse entries must be an array");
  if (value.entries.length > MAX_ENTRIES) throw new RangeError(`snapshot browse may contain at most ${MAX_ENTRIES} entries`);
  const entryLimit = integerRange(value.entryLimit, "entryLimit", 1, MAX_ENTRIES);
  if (value.entries.length > entryLimit) throw new RangeError("snapshot browse entries exceed entryLimit");
  if (typeof value.truncated !== "boolean") throw new RangeError("snapshot browse truncated must be a boolean");

  const entries = value.entries.map((entry) => normalizeBrowseEntry(entry, path));
  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry.path)) throw new RangeError(`duplicate snapshot entry path: ${entry.path}`);
    seen.add(entry.path);
  }
  const encoded = JSON.stringify(entries);
  if (encoded.length > MAX_EVENT_JSON) throw new RangeError("snapshot browse payload is too large");

  return {
    type: "snapshot-browse",
    tool: "restic",
    repositoryId,
    snapshotId,
    path,
    at: normalizeAt(value.at, now),
    entries,
    entryLimit,
    truncated: value.truncated,
  };
}

function normalizeBrowseEntry(value, browsePath) {
  if (!isRecord(value)) throw new RangeError("snapshot browse entry must be an object");
  const path = requireSnapshotPath(value.path);
  if (!isWithinPath(path, browsePath)) throw new RangeError(`snapshot entry is outside requested path: ${path}`);
  const name = requireString(value.name, "entry.name", 1, 1024, false);
  const nodeType = requireString(value.nodeType, "entry.nodeType", 1, 64);
  return {
    path,
    name,
    nodeType,
    size: nullableNonNegativeNumber(value.size, "entry.size"),
    mtime: nullableDate(value.mtime, "entry.mtime"),
    permissions: nullableString(value.permissions, "entry.permissions", 64),
  };
}

async function assertSnapshotExists(db, repositoryId, snapshotId) {
  const row = await db.prepare(`
    SELECT snapshot_id FROM repository_snapshots
    WHERE repository_id = ? AND snapshot_id = ?
  `).bind(repositoryId, snapshotId).first();
  if (!row) throw statusError(404, `Snapshot not found in repository inventory: ${snapshotId}`);
}

async function assertKnownBrowseDirectory(db, repositoryId, snapshotId, path) {
  const entry = await findCachedEntry(db, repositoryId, snapshotId, path);
  if (!entry || entry.nodeType !== "dir") {
    throw statusError(400, `Snapshot directory has not been discovered by the browser: ${path}`);
  }
}

async function assertKnownBrowseEntry(db, repositoryId, snapshotId, path) {
  const entry = await findCachedEntry(db, repositoryId, snapshotId, path);
  if (!entry) throw statusError(400, `Snapshot path has not been discovered by the browser: ${path}`);
}

async function findCachedEntry(db, repositoryId, snapshotId, path) {
  const rows = (await db.prepare(`
    SELECT entries_json FROM repository_snapshot_browse
    WHERE repository_id = ? AND snapshot_id = ?
  `).bind(repositoryId, snapshotId).all()).results ?? [];
  for (const row of rows) {
    const entries = parseJsonArray(row.entries_json);
    for (const entry of entries) {
      if (isRecord(entry) && entry.path === path) return entry;
    }
  }
  return null;
}

async function browseJobs(db, repositoryId, snapshotId, path) {
  const rows = (await db.prepare(`
    SELECT id, state, payload_json, created_at, updated_at, finished_at, last_error
    FROM backup_jobs
    WHERE type = 'restic-browse'
    ORDER BY created_at DESC, id DESC
    LIMIT 300
  `).all()).results ?? [];
  return rows.flatMap((row) => {
    const payload = parseJsonObject(row.payload_json);
    if (payload?.repositoryId !== repositoryId || payload?.snapshotId !== snapshotId || payload?.path !== path) return [];
    return [jobRow(row)];
  });
}

async function findActivePreview(db, wanted) {
  const rows = (await db.prepare(`
    SELECT id, state, payload_json, created_at, updated_at, finished_at, last_error
    FROM backup_jobs
    WHERE type = 'restic-restore-preview'
      AND state IN ('queued','leased','preparing','running','finalizing')
    ORDER BY created_at DESC
    LIMIT 200
  `).all()).results ?? [];
  for (const row of rows) {
    const payload = parseJsonObject(row.payload_json);
    if (payload?.repositoryId !== wanted.repositoryId) continue;
    if (payload?.snapshotId !== wanted.snapshotId) continue;
    if (payload?.targetId !== wanted.targetId) continue;
    const rowPath = typeof payload?.path === "string" ? payload.path : null;
    if (rowPath !== wanted.path) continue;
    return jobRow(row);
  }
  return null;
}

function browseRow(row) {
  return {
    scannedAt: String(row.scanned_at),
    jobId: row.job_id === null ? null : String(row.job_id),
    attempt: Number(row.attempt),
    entries: parseJsonArray(row.entries_json).filter(isRecord),
    entryLimit: Number(row.entry_limit),
    returnedEntries: Number(row.returned_entries),
    truncated: Number(row.truncated) === 1,
  };
}

function jobRow(row) {
  return {
    id: String(row.id),
    state: String(row.state),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    finishedAt: nullableOutput(row.finished_at),
    error: nullableOutput(row.last_error),
  };
}

function requireConfiguredRepository(value, repositories) {
  const id = requireString(value, "repositoryId", 1, 128);
  if (!(repositories ?? []).some((repository) => repository.id === id)) throw statusError(404, `Repository not found: ${id}`);
  return id;
}

function requireConfiguredTarget(value, targets) {
  const id = requireString(value, "targetId", 1, 128);
  if (!(targets ?? []).some((target) => target.id === id)) throw statusError(404, `Restore target not found: ${id}`);
  return id;
}

function requireSnapshotId(value) {
  const id = requireString(value, "snapshotId", 8, 64);
  if (!/^[A-Fa-f0-9]{8,64}$/.test(id)) throw new RangeError("snapshotId must be a hexadecimal Restic snapshot id");
  return id;
}

function requireSnapshotPath(value) {
  const path = requireString(value, "path", 1, 4096, false);
  if (!path.startsWith("/")) throw new RangeError("snapshot path must be absolute");
  if (path.includes("\0")) throw new RangeError("snapshot path contains an invalid character");
  if (path.split("/").some((segment) => segment === "." || segment === "..")) throw new RangeError("snapshot path may not contain dot segments");
  return path.length > 1 ? path.replace(/\/+$/, "") || "/" : "/";
}

function isWithinPath(path, parent) {
  if (parent === "/") return path.startsWith("/");
  return path === parent || path.startsWith(`${parent}/`);
}

function requireString(value, name, min, max, trim = true) {
  if (typeof value !== "string") throw new RangeError(`${name} must be a string`);
  const normalized = trim ? value.trim() : value;
  if (normalized.length < min || normalized.length > max) throw new RangeError(`${name} must be ${min}-${max} characters`);
  return normalized;
}

function nullableString(value, name, max) {
  if (value === null || value === undefined) return null;
  return requireString(value, name, 0, max, false);
}

function nullableNonNegativeNumber(value, name) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be a non-negative number`);
  return value;
}

function nullableDate(value, name) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new RangeError(`${name} must be a valid date`);
  return new Date(value).toISOString();
}

function integerRange(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw new RangeError(`${name} must be an integer between ${min} and ${max}`);
  return value;
}

function normalizeAt(value, fallback) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return fallback.toISOString();
  return new Date(value).toISOString();
}

function nowDate(now) {
  const value = now();
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("now() must return a valid date");
  return date;
}

function parseJsonObject(value) {
  if (typeof value !== "string") return null;
  try { const parsed = JSON.parse(value); return isRecord(parsed) ? parsed : null; } catch { return null; }
}

function parseJsonArray(value) {
  if (typeof value !== "string") return [];
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}

function nullableOutput(value) { return value === null || value === undefined ? null : String(value); }
function statusError(statusCode, message) { const error = new Error(message); error.statusCode = statusCode; return error; }
function isRecord(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
