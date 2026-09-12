import { createHash, randomBytes } from "node:crypto";

const DEFAULT_TTL_MS = 15 * 60 * 1000;

export function createWorkstationInstallTicketService({
  db,
  deviceService,
  now = () => new Date(),
  ticket = () => `nxbinst_${randomBytes(32).toString("base64url")}`,
  ttlMs = DEFAULT_TTL_MS,
} = {}) {
  if (!db) throw new TypeError("db is required");
  if (!deviceService || typeof deviceService.rotateToken !== "function") throw new TypeError("deviceService.rotateToken is required");

  async function issue(deviceId) {
    const id = requireId(deviceId, "device id");
    const device = await db.prepare("SELECT id,kind,enabled FROM managed_devices WHERE id=?").bind(id).first();
    if (!device) throw statusError(404, `Device not found: ${id}`);
    if (String(device.kind) !== "workstation" || Number(device.enabled) !== 1) throw statusError(409, "Install tickets require an enabled workstation");

    const raw = requireTicket(ticket());
    const at = nowDate(now);
    const expiresAt = new Date(at.getTime() + ttlMs).toISOString();
    await db.batch([
      db.prepare("UPDATE workstation_install_tickets SET consumed_at=? WHERE device_id=? AND consumed_at IS NULL")
        .bind(at.toISOString(), id),
      db.prepare(`
        INSERT INTO workstation_install_tickets(ticket_hash,device_id,expires_at,created_at)
        VALUES(?,?,?,?)
      `).bind(hash(raw), id, expiresAt, at.toISOString()),
    ]);
    return { ticket: raw, expiresAt };
  }

  async function consume(rawTicket) {
    const raw = requireTicket(rawTicket);
    const at = nowDate(now);
    const ticketHash = hash(raw);
    const row = await db.prepare(`
      SELECT device_id FROM workstation_install_tickets
      WHERE ticket_hash=? AND consumed_at IS NULL AND expires_at>?
      LIMIT 1
    `).bind(ticketHash, at.toISOString()).first();
    if (!row) throw statusError(401, "Workstation install ticket is invalid, expired, or already used");

    const claimed = await db.prepare(`
      UPDATE workstation_install_tickets SET consumed_at=?
      WHERE ticket_hash=? AND consumed_at IS NULL AND expires_at>?
    `).bind(at.toISOString(), ticketHash, at.toISOString()).run();
    if (Number(claimed.meta?.changes ?? 0) !== 1) throw statusError(409, "Workstation install ticket was already consumed");

    const rotated = await deviceService.rotateToken(String(row.device_id));
    return { deviceId: rotated.device.id, deviceToken: rotated.token };
  }

  return { issue, consume };
}

export function workstationInstallCommand(origin, installTicket) {
  const base = String(origin ?? "").replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base)) throw new RangeError("origin must be http(s)");
  const raw = requireTicket(installTicket);
  const q = (value) => String(value).replace(/'/g, "''");
  return `$env:NEXUS_BACKUP_URL='${q(base)}';$env:NEXUS_BACKUP_ENROLLMENT='${q(raw)}';irm '${q(base)}/install.ps1'|iex`;
}

function hash(value) { return createHash("sha256").update(value).digest("hex"); }
function requireTicket(value) {
  if (typeof value !== "string" || !/^nxbinst_[A-Za-z0-9_-]{24,128}$/.test(value)) throw statusError(401, "Invalid workstation install ticket");
  return value;
}
function requireId(value, name) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.trim())) throw new RangeError(`${name} is invalid`);
  return value.trim();
}
function nowDate(now) {
  const value = now();
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("now() must return a valid date");
  return date;
}
function statusError(statusCode, message) { const error = new Error(message); error.statusCode = statusCode; return error; }
