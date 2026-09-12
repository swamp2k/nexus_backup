import { readFile } from "node:fs/promises";

const JOB_STATES = new Set([
  "queued", "leased", "preparing", "running", "finalizing",
  "completed", "partial", "failed", "cancelled", "interrupted",
]);

export async function listJobs(db, { limit = 100, state } = {}) {
  const normalizedLimit = clampInteger(limit, 1, 500, 100);
  const normalizedState = normalizeState(state);
  const select = `
    SELECT
      j.*,
      p.tool AS runtime_tool,
      p.updated_at AS runtime_updated_at,
      p.bytes_done AS runtime_bytes_done,
      p.bytes_total AS runtime_bytes_total,
      p.files_done AS runtime_files_done,
      p.files_total AS runtime_files_total,
      p.speed_bytes_per_second AS runtime_speed_bytes_per_second,
      p.eta_seconds AS runtime_eta_seconds,
      p.errors AS runtime_errors
    FROM backup_jobs AS j
    LEFT JOIN backup_job_runtime_progress AS p
      ON p.job_id = j.id AND p.attempt = j.attempt
  `;
  const statement = normalizedState
    ? db.prepare(`${select}
        WHERE j.state = ?
        ORDER BY j.created_at DESC, j.id DESC
        LIMIT ?
      `).bind(normalizedState, normalizedLimit)
    : db.prepare(`${select}
        ORDER BY j.created_at DESC, j.id DESC
        LIMIT ?
      `).bind(normalizedLimit);
  const result = await statement.all();
  return (result.results ?? []).map(rowToJob);
}

export async function listAgents(db) {
  const result = await db.prepare(`
    SELECT id, name, enabled, created_at, last_seen_at, version
    FROM backup_agents
    ORDER BY id ASC
  `).all();
  return (result.results ?? []).map((row) => ({
    id: String(row.id),
    name: row.name === null ? null : String(row.name),
    enabled: Number(row.enabled) === 1,
    createdAt: String(row.created_at),
    lastSeenAt: row.last_seen_at === null ? null : String(row.last_seen_at),
    version: row.version === null ? null : String(row.version),
  }));
}

export async function loadSanitizedAgentConfig(path) {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { available: false, sources: [], repositories: [], restoreTargets: [], endpoints: [], rtorrentGates: [] };
    }
    throw error;
  }

  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return {
      available: false,
      invalid: true,
      sources: [],
      repositories: [],
      restoreTargets: [],
      endpoints: [],
      rtorrentGates: [],
    };
  }

  if (!isRecord(value)) {
    return {
      available: false,
      invalid: true,
      sources: [],
      repositories: [],
      restoreTargets: [],
      endpoints: [],
      rtorrentGates: [],
    };
  }

  return {
    available: true,
    sources: sanitizeSources(value.sources),
    repositories: sanitizeRepositories(value.resticRepositories),
    restoreTargets: sanitizeRestoreTargets(value.restoreTargets),
    endpoints: sanitizeEndpoints(value.rcloneEndpoints),
    rtorrentGates: sanitizeRtorrentGates(value.rtorrentGates),
  };
}

function sanitizeSources(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .map((source) => ({
      id: stringOrEmpty(source.id),
      paths: Array.isArray(source.paths)
        ? source.paths.filter((path) => typeof path === "string").map((path) => path.trim()).filter(Boolean)
        : [],
    }))
    .filter((source) => source.id);
}

function sanitizeRepositories(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .map((repository) => ({
      id: stringOrEmpty(repository.id),
      repository: stringOrEmpty(repository.repository),
      passwordProtected: typeof repository.passwordFile === "string" && repository.passwordFile.trim().length > 0,
      cacheConfigured: isRecord(repository.environment)
        && typeof repository.environment.RESTIC_CACHE_DIR === "string"
        && repository.environment.RESTIC_CACHE_DIR.trim().length > 0,
    }))
    .filter((repository) => repository.id);
}

function sanitizeRestoreTargets(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .map((target) => {
      const id = stringOrEmpty(target.id);
      const label = stringOrEmpty(target.label) || id;
      const overwrite = ["always", "if-changed", "if-newer", "never"].includes(target.overwrite)
        ? target.overwrite
        : "never";
      return { id, label, overwrite, writeEnabled: target.allowWrite === true };
    })
    .filter((target) => target.id);
}

function sanitizeEndpoints(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .map((endpoint) => {
      const mount = isRecord(endpoint.mount)
        ? {
            enabled: true,
            vfsCacheMode: stringOrEmpty(endpoint.mount.vfsCacheMode) || "off",
            vfsCacheMaxSize: stringOrEmpty(endpoint.mount.vfsCacheMaxSize) || null,
            dirCacheTime: stringOrEmpty(endpoint.mount.dirCacheTime) || null,
            pollInterval: stringOrEmpty(endpoint.mount.pollInterval) || null,
          }
        : { enabled: false };
      return {
        id: stringOrEmpty(endpoint.id),
        fs: stringOrEmpty(endpoint.fs),
        allowMove: endpoint.allowMove === true,
        mount,
      };
    })
    .filter((endpoint) => endpoint.id);
}

function sanitizeRtorrentGates(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .map((gate) => ({
      id: stringOrEmpty(gate.id),
      required: gate.required === true,
    }))
    .filter((gate) => gate.id);
}

function rowToJob(row) {
  const hasLease = row.lease_agent_id !== null
    && row.lease_token !== null
    && row.lease_acquired_at !== null
    && row.lease_expires_at !== null
    && row.lease_heartbeat_at !== null;

  let payload = {};
  try {
    payload = JSON.parse(String(row.payload_json));
  } catch {}

  const runtime = row.runtime_tool === null || row.runtime_tool === undefined
    ? null
    : {
        tool: String(row.runtime_tool),
        updatedAt: String(row.runtime_updated_at),
        bytesDone: nullableNumber(row.runtime_bytes_done),
        bytesTotal: nullableNumber(row.runtime_bytes_total),
        filesDone: nullableNumber(row.runtime_files_done),
        filesTotal: nullableNumber(row.runtime_files_total),
        speedBytesPerSecond: nullableNumber(row.runtime_speed_bytes_per_second),
        etaSeconds: nullableNumber(row.runtime_eta_seconds),
        errors: nullableNumber(row.runtime_errors),
      };

  return {
    id: String(row.id),
    operationKey: String(row.operation_key),
    type: String(row.type),
    state: String(row.state),
    attempt: Number(row.attempt),
    revision: Number(row.revision),
    payload,
    lease: hasLease ? {
      agentId: String(row.lease_agent_id),
      acquiredAt: String(row.lease_acquired_at),
      expiresAt: String(row.lease_expires_at),
      heartbeatAt: String(row.lease_heartbeat_at),
    } : null,
    runtime,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    startedAt: row.started_at === null ? null : String(row.started_at),
    finishedAt: row.finished_at === null ? null : String(row.finished_at),
    lastError: row.last_error === null ? null : String(row.last_error),
  };
}

function normalizeState(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  return JOB_STATES.has(value) ? value : null;
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isInteger(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function nullableNumber(value) {
  return value === null || value === undefined ? null : Number(value);
}

function stringOrEmpty(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
