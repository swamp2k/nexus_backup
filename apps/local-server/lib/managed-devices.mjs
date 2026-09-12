import { createHash, randomBytes, randomUUID } from "node:crypto";

const ONLINE_AFTER_MS = 3 * 60 * 1000;
const MAX_CAPABILITIES = 32;
const MAX_REMOTES = 64;

export function createManagedDeviceService({
  db,
  now = () => new Date(),
  id = () => `device-${randomUUID()}`,
  token = () => `nxbdev_${randomBytes(32).toString("base64url")}`,
} = {}) {
  if (!db) throw new TypeError("db is required");

  async function list() {
    const current = nowDate(now);
    const rows = (await db.prepare(`
      SELECT id,name,kind,enabled,version,hostname,platform,capabilities_json,remotes_json,
             first_seen_at,last_seen_at,created_at,updated_at
      FROM managed_devices
      ORDER BY name COLLATE NOCASE ASC, id ASC
    `).all()).results ?? [];
    return rows.map((row) => present(row, current));
  }

  async function create(input) {
    const name = requireString(input?.name, "name", 1, 100);
    const kind = optionalKind(input?.kind ?? "pcwatch");
    const deviceId = requireId(id(), "generated device id");
    const rawToken = requireToken(token());
    const at = nowDate(now).toISOString();
    await db.prepare(`
      INSERT INTO managed_devices(id,name,kind,token_hash,enabled,created_at,updated_at)
      VALUES(?,?,?,?,1,?,?)
    `).bind(deviceId, name, kind, hashToken(rawToken), at, at).run();
    const row = await byId(db, deviceId);
    return { device: present(row, nowDate(now)), token: rawToken };
  }

  async function rotateToken(deviceId) {
    const normalizedId = requireId(deviceId, "device id");
    if (!await byId(db, normalizedId)) throw statusError(404, `Device not found: ${normalizedId}`);
    const rawToken = requireToken(token());
    const at = nowDate(now).toISOString();
    await db.prepare("UPDATE managed_devices SET token_hash=?,updated_at=? WHERE id=?")
      .bind(hashToken(rawToken), at, normalizedId).run();
    return { device: present(await byId(db, normalizedId), nowDate(now)), token: rawToken };
  }

  async function update(deviceId, input) {
    const normalizedId = requireId(deviceId, "device id");
    const existing = await byId(db, normalizedId);
    if (!existing) throw statusError(404, `Device not found: ${normalizedId}`);
    const name = input?.name === undefined ? String(existing.name) : requireString(input.name, "name", 1, 100);
    const enabled = input?.enabled === undefined ? Number(existing.enabled) === 1 : requireBoolean(input.enabled, "enabled");
    const at = nowDate(now).toISOString();
    await db.prepare("UPDATE managed_devices SET name=?,enabled=?,updated_at=? WHERE id=?")
      .bind(name, enabled ? 1 : 0, at, normalizedId).run();
    return present(await byId(db, normalizedId), nowDate(now));
  }

  async function report(rawToken, input) {
    const supplied = requireToken(rawToken);
    const row = await db.prepare(`
      SELECT * FROM managed_devices WHERE token_hash=? LIMIT 1
    `).bind(hashToken(supplied)).first();
    if (!row || Number(row.enabled) !== 1) throw statusError(401, "Invalid or disabled device token");

    const report = normalizeReport(input);
    const at = nowDate(now).toISOString();
    await db.prepare(`
      UPDATE managed_devices
      SET version=?, hostname=?, platform=?, capabilities_json=?, remotes_json=?,
          first_seen_at=COALESCE(first_seen_at,?), last_seen_at=?, updated_at=?
      WHERE id=?
    `).bind(
      report.version,
      report.hostname,
      report.platform,
      JSON.stringify(report.capabilities),
      JSON.stringify(report.remotes),
      at,
      at,
      at,
      row.id,
    ).run();
    return {
      ok: true,
      device: present(await byId(db, String(row.id)), nowDate(now)),
      nextReportSeconds: 60,
    };
  }

  return { list, create, rotateToken, update, report };
}

export function normalizeDeviceReport(input) {
  return normalizeReport(input);
}

function normalizeReport(value) {
  if (!isRecord(value)) throw new RangeError("device report must be an object");
  const version = optionalString(value.version, "version", 64);
  const hostname = optionalString(value.hostname, "hostname", 128);
  const platform = optionalString(value.platform, "platform", 64);
  const capabilities = uniqueStrings(value.capabilities, "capabilities", MAX_CAPABILITIES, 64);
  const remotes = uniqueStrings(value.remotes, "remotes", MAX_REMOTES, 128);
  if (value.runtime_settings !== undefined) {
    if (!isRecord(value.runtime_settings) || JSON.stringify(value.runtime_settings).length > 16_384) {
      throw new RangeError("runtime_settings must be a small object");
    }
  }
  return { version, hostname, platform, capabilities, remotes };
}

function present(row, current) {
  if (!row) return null;
  const lastSeenAt = nullableString(row.last_seen_at);
  const lastSeenMs = lastSeenAt ? Date.parse(lastSeenAt) : NaN;
  return {
    id: String(row.id),
    name: String(row.name),
    kind: String(row.kind),
    enabled: Number(row.enabled) === 1,
    version: nullableString(row.version),
    hostname: nullableString(row.hostname),
    platform: nullableString(row.platform),
    capabilities: parseArray(row.capabilities_json),
    remotes: parseArray(row.remotes_json),
    firstSeenAt: nullableString(row.first_seen_at),
    lastSeenAt,
    online: Number(row.enabled) === 1 && Number.isFinite(lastSeenMs) && current.getTime() - lastSeenMs <= ONLINE_AFTER_MS,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

async function byId(db, id) {
  return db.prepare("SELECT * FROM managed_devices WHERE id=?").bind(id).first();
}
function hashToken(value) { return createHash("sha256").update(value).digest("hex"); }
function requireToken(value) {
  if (typeof value !== "string" || value.length < 24 || value.length > 256) throw statusError(401, "Invalid device token");
  return value;
}
function requireId(value, name) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.trim())) throw new RangeError(`${name} is invalid`);
  return value.trim();
}
function optionalKind(value) {
  const kind = requireString(value, "kind", 1, 32).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(kind)) throw new RangeError("kind is invalid");
  return kind;
}
function requireString(value, name, min, max) {
  if (typeof value !== "string") throw new RangeError(`${name} must be a string`);
  const result = value.trim();
  if (result.length < min || result.length > max) throw new RangeError(`${name} must be ${min}-${max} characters`);
  return result;
}
function optionalString(value, name, max) {
  if (value === undefined || value === null || value === "") return null;
  return requireString(value, name, 1, max);
}
function requireBoolean(value, name) {
  if (typeof value !== "boolean") throw new RangeError(`${name} must be a boolean`);
  return value;
}
function uniqueStrings(value, name, maxItems, maxLength) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maxItems) throw new RangeError(`${name} may contain at most ${maxItems} items`);
  const seen = new Set();
  const result = [];
  for (const item of value) {
    const normalized = requireString(item, name, 1, maxLength);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}
function parseArray(value) {
  if (typeof value !== "string") return [];
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : []; }
  catch { return []; }
}
function nullableString(value) { return typeof value === "string" && value ? value : null; }
function nowDate(now) { const value = now(); const date = value instanceof Date ? new Date(value) : new Date(value); if (!Number.isFinite(date.getTime())) throw new TypeError("now() must return a valid date"); return date; }
function isRecord(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
function statusError(statusCode, message) { const error = new Error(message); error.statusCode = statusCode; return error; }
