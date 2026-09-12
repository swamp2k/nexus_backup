import { randomUUID } from "node:crypto";

const ACTIVE_STATES = new Set(["queued", "leased", "preparing", "running", "finalizing"]);
const MAX_SNAPSHOTS = 250;
const MAX_PATHS = 16;
const MAX_TAGS = 32;
const MAX_INVENTORY_JSON = 700_000;

export async function persistRepositoryInventory(
  db,
  { jobId, attempt, agentId, expectedRepositoryId, event, at = new Date() },
) {
  const normalized = normalizeInventoryEvent(event, expectedRepositoryId, at);
  const statements = [
    db.prepare(`
      INSERT INTO repository_inventory (
        repository_id, job_id, attempt, agent_id, scanned_at, stats_json,
        snapshot_limit, returned_snapshots, truncated
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(repository_id) DO UPDATE SET
        job_id = excluded.job_id,
        attempt = excluded.attempt,
        agent_id = excluded.agent_id,
        scanned_at = excluded.scanned_at,
        stats_json = excluded.stats_json,
        snapshot_limit = excluded.snapshot_limit,
        returned_snapshots = excluded.returned_snapshots,
        truncated = excluded.truncated
    `).bind(
      normalized.repositoryId,
      jobId,
      attempt,
      agentId,
      normalized.at,
      JSON.stringify(normalized.stats),
      normalized.snapshotLimit,
      normalized.snapshots.length,
      normalized.truncated ? 1 : 0,
    ),
    db.prepare("DELETE FROM repository_snapshots WHERE repository_id = ?").bind(normalized.repositoryId),
  ];

  for (const snapshot of normalized.snapshots) {
    statements.push(db.prepare(`
      INSERT INTO repository_snapshots (
        repository_id, snapshot_id, short_id, snapshot_time, parent_id,
        hostname, username, paths_json, tags_json, program_version,
        total_files_processed, total_bytes_processed, data_added, data_added_packed
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      normalized.repositoryId,
      snapshot.id,
      snapshot.shortId,
      snapshot.time,
      snapshot.parent,
      snapshot.hostname,
      snapshot.username,
      JSON.stringify(snapshot.paths),
      JSON.stringify(snapshot.tags),
      snapshot.programVersion,
      snapshot.totalFilesProcessed,
      snapshot.totalBytesProcessed,
      snapshot.dataAdded,
      snapshot.dataAddedPacked,
    ));
  }
  await db.batch(statements);
  return normalized;
}

export async function listRepositoryInventories(db, repositories) {
  const inventoryRows = (await db.prepare("SELECT * FROM repository_inventory").all()).results ?? [];
  const snapshotRows = (await db.prepare(`
    SELECT * FROM repository_snapshots
    ORDER BY repository_id ASC, snapshot_time DESC, snapshot_id ASC
  `).all()).results ?? [];
  const scanRows = (await db.prepare(`
    SELECT id, state, payload_json, created_at, updated_at, finished_at, last_error
    FROM backup_jobs
    WHERE type = 'restic-inventory'
    ORDER BY created_at DESC, id DESC
    LIMIT 500
  `).all()).results ?? [];

  const inventoryByRepository = new Map(inventoryRows.map((row) => [String(row.repository_id), row]));
  const snapshotsByRepository = new Map();
  for (const row of snapshotRows) {
    const repositoryId = String(row.repository_id);
    const items = snapshotsByRepository.get(repositoryId) ?? [];
    items.push(snapshotRow(row));
    snapshotsByRepository.set(repositoryId, items);
  }

  const latestScanByRepository = new Map();
  const activeScanByRepository = new Map();
  for (const row of scanRows) {
    const payload = parseJsonObject(row.payload_json);
    const repositoryId = typeof payload?.repositoryId === "string" ? payload.repositoryId : null;
    if (!repositoryId) continue;
    const scan = scanRow(row);
    if (!latestScanByRepository.has(repositoryId)) latestScanByRepository.set(repositoryId, scan);
    if (ACTIVE_STATES.has(scan.state) && !activeScanByRepository.has(repositoryId)) activeScanByRepository.set(repositoryId, scan);
  }

  return (repositories ?? []).map((repository) => {
    const repositoryId = String(repository.id);
    const inventoryRow = inventoryByRepository.get(repositoryId);
    const inventory = inventoryRow ? {
      scannedAt: String(inventoryRow.scanned_at),
      jobId: nullableOutput(inventoryRow.job_id),
      attempt: Number(inventoryRow.attempt),
      stats: parseJsonObject(inventoryRow.stats_json) ?? {},
      snapshotLimit: Number(inventoryRow.snapshot_limit),
      returnedSnapshots: Number(inventoryRow.returned_snapshots),
      truncated: Number(inventoryRow.truncated) === 1,
      snapshots: snapshotsByRepository.get(repositoryId) ?? [],
    } : null;
    return {
      ...repository,
      inventory,
      lastScan: latestScanByRepository.get(repositoryId) ?? null,
      activeScan: activeScanByRepository.get(repositoryId) ?? null,
    };
  });
}

export async function queueRepositoryInventory(
  db,
  { repositoryId, repositories, enqueueJob, now = () => new Date(), id = () => randomUUID() },
) {
  if (typeof repositoryId !== "string" || !repositoryId.trim()) throw new RangeError("repositoryId is required");
  const normalizedId = repositoryId.trim();
  if (!(repositories ?? []).some((repository) => repository.id === normalizedId)) {
    throw statusError(404, `Repository not found: ${normalizedId}`);
  }

  const scans = (await db.prepare(`
    SELECT id, state, payload_json, created_at, updated_at, finished_at, last_error
    FROM backup_jobs
    WHERE type = 'restic-inventory'
      AND state IN ('queued','leased','preparing','running','finalizing')
    ORDER BY created_at DESC
    LIMIT 200
  `).all()).results ?? [];
  for (const row of scans) {
    const payload = parseJsonObject(row.payload_json);
    if (payload?.repositoryId === normalizedId) {
      return { job: scanRow(row), alreadyRunning: true };
    }
  }

  const at = nowDate(now);
  const job = await enqueueJob({
    operationKey: `repository:${normalizedId}:inventory:${at.toISOString()}:${id()}`,
    type: "restic-inventory",
    payload: { repositoryId: normalizedId },
  });
  return { job, alreadyRunning: false };
}

export function normalizeInventoryEvent(value, expectedRepositoryId, now = new Date()) {
  if (!isRecord(value) || value.type !== "inventory" || value.tool !== "restic") {
    throw new RangeError("inventory event must be a restic inventory object");
  }
  if (JSON.stringify(value).length > MAX_INVENTORY_JSON) {
    throw new RangeError(`inventory event exceeds ${MAX_INVENTORY_JSON} characters`);
  }
  const repositoryId = requireString(value.repositoryId, "repositoryId", 1, 128);
  if (typeof expectedRepositoryId !== "string" || repositoryId !== expectedRepositoryId) {
    throw new RangeError("inventory repositoryId does not match the job payload");
  }
  if (!isRecord(value.stats)) throw new RangeError("inventory stats must be an object");
  if (!Array.isArray(value.snapshots)) throw new RangeError("inventory snapshots must be an array");
  if (value.snapshots.length > MAX_SNAPSHOTS) throw new RangeError(`inventory may contain at most ${MAX_SNAPSHOTS} snapshots`);
  const snapshotLimit = integerRange(value.snapshotLimit, "snapshotLimit", 1, MAX_SNAPSHOTS);
  if (value.snapshots.length > snapshotLimit) throw new RangeError("inventory snapshots exceed snapshotLimit");
  if (typeof value.truncated !== "boolean") throw new RangeError("inventory truncated must be a boolean");

  const snapshots = value.snapshots.map(normalizeSnapshot);
  const ids = new Set();
  for (const snapshot of snapshots) {
    if (ids.has(snapshot.id)) throw new RangeError(`duplicate snapshot id: ${snapshot.id}`);
    ids.add(snapshot.id);
  }

  return {
    type: "inventory",
    tool: "restic",
    repositoryId,
    at: normalizeAt(value.at, now),
    stats: normalizeStats(value.stats),
    snapshots,
    snapshotLimit,
    truncated: value.truncated,
  };
}

function normalizeSnapshot(value) {
  if (!isRecord(value)) throw new RangeError("snapshot must be an object");
  const time = requireString(value.time, "snapshot.time", 1, 100);
  if (!Number.isFinite(Date.parse(time))) throw new RangeError("snapshot.time must be a valid date");
  return {
    id: requireString(value.id, "snapshot.id", 8, 128),
    shortId: nullableString(value.shortId, "snapshot.shortId", 128),
    time: new Date(time).toISOString(),
    parent: nullableString(value.parent, "snapshot.parent", 128),
    hostname: nullableString(value.hostname, "snapshot.hostname", 512),
    username: nullableString(value.username, "snapshot.username", 512),
    paths: exactStringArray(value.paths, "snapshot.paths", MAX_PATHS, 2_048),
    tags: trimmedStringArray(value.tags, "snapshot.tags", MAX_TAGS, 128),
    programVersion: nullableString(value.programVersion, "snapshot.programVersion", 256),
    totalFilesProcessed: nullableInteger(value.totalFilesProcessed, "snapshot.totalFilesProcessed"),
    totalBytesProcessed: nullableNumber(value.totalBytesProcessed, "snapshot.totalBytesProcessed"),
    dataAdded: nullableNumber(value.dataAdded, "snapshot.dataAdded"),
    dataAddedPacked: nullableNumber(value.dataAddedPacked, "snapshot.dataAddedPacked"),
  };
}

function normalizeStats(value) {
  return {
    totalSize: nullableNumber(value.totalSize, "stats.totalSize"),
    totalFileCount: nullableInteger(value.totalFileCount, "stats.totalFileCount"),
    totalBlobCount: nullableInteger(value.totalBlobCount, "stats.totalBlobCount"),
    snapshotsCount: nullableInteger(value.snapshotsCount, "stats.snapshotsCount"),
    totalUncompressedSize: nullableNumber(value.totalUncompressedSize, "stats.totalUncompressedSize"),
    compressionRatio: nullableNumber(value.compressionRatio, "stats.compressionRatio"),
    compressionProgress: nullableNumber(value.compressionProgress, "stats.compressionProgress"),
    compressionSpaceSaving: nullableFiniteNumber(value.compressionSpaceSaving, "stats.compressionSpaceSaving"),
  };
}

function snapshotRow(row) {
  return {
    id: String(row.snapshot_id),
    shortId: nullableOutput(row.short_id),
    time: String(row.snapshot_time),
    parent: nullableOutput(row.parent_id),
    hostname: nullableOutput(row.hostname),
    username: nullableOutput(row.username),
    paths: parseJsonArray(row.paths_json),
    tags: parseJsonArray(row.tags_json),
    programVersion: nullableOutput(row.program_version),
    totalFilesProcessed: nullableOutputNumber(row.total_files_processed),
    totalBytesProcessed: nullableOutputNumber(row.total_bytes_processed),
    dataAdded: nullableOutputNumber(row.data_added),
    dataAddedPacked: nullableOutputNumber(row.data_added_packed),
  };
}

function scanRow(row) {
  return {
    id: String(row.id),
    state: String(row.state),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    finishedAt: nullableOutput(row.finished_at),
    error: nullableOutput(row.last_error),
  };
}

function parseJsonObject(value) {
  if (typeof value !== "string") return null;
  try { const parsed = JSON.parse(value); return isRecord(parsed) ? parsed : null; } catch { return null; }
}

function parseJsonArray(value) {
  if (typeof value !== "string") return [];
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : []; } catch { return []; }
}

function exactStringArray(value, name, maxItems, maxLength) {
  if (!Array.isArray(value)) throw new RangeError(`${name} must be an array`);
  if (value.length > maxItems) throw new RangeError(`${name} may contain at most ${maxItems} items`);
  return value.map((item) => {
    if (typeof item !== "string" || item.length < 1 || item.length > maxLength) {
      throw new RangeError(`${name} items must be 1-${maxLength} characters`);
    }
    return item;
  });
}

function trimmedStringArray(value, name, maxItems, maxLength) {
  if (!Array.isArray(value)) throw new RangeError(`${name} must be an array`);
  if (value.length > maxItems) throw new RangeError(`${name} may contain at most ${maxItems} items`);
  return value.map((item) => requireString(item, name, 0, maxLength));
}

function nullableString(value, name, maxLength) {
  if (value === null || value === undefined) return null;
  return requireString(value, name, 0, maxLength);
}

function nullableInteger(value, name) {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative safe integer`);
  return value;
}

function nullableNumber(value, name) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be a non-negative number`);
  return value;
}

function nullableFiniteNumber(value, name) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new RangeError(`${name} must be a finite number`);
  return value;
}

function integerRange(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw new RangeError(`${name} must be an integer between ${min} and ${max}`);
  return value;
}

function requireString(value, name, min, max) {
  if (typeof value !== "string") throw new RangeError(`${name} must be a string`);
  const normalized = value.trim();
  if (normalized.length < min || normalized.length > max) throw new RangeError(`${name} must be ${min}-${max} characters`);
  return normalized;
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

function nullableOutput(value) { return value === null || value === undefined ? null : String(value); }
function nullableOutputNumber(value) { return value === null || value === undefined ? null : Number(value); }
function statusError(statusCode, message) { const error = new Error(message); error.statusCode = statusCode; return error; }
function isRecord(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
