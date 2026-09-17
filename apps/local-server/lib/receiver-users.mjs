import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { normalizeRelativePath, safeName } from "./backup-paths.mjs";

const scrypt = promisify(scryptCallback);
const PASSWORD_BYTES = 32;

export function createReceiverUserService({ db, repositories, now = () => new Date(), id = () => `receiver-${randomUUID()}` } = {}) {
  if (!db || !repositories) throw new TypeError("db and repositories are required");
  async function list() {
    const rows = (await db.prepare(`SELECT u.*,r.name AS repository_name,r.relative_path AS repository_path FROM receiver_users u JOIN repositories r ON r.id=u.repository_id ORDER BY u.username COLLATE NOCASE`).all()).results ?? [];
    return rows.map(present);
  }
  async function create(input = {}) {
    const username = normalizeUsername(input.username);
    const password = input.password === undefined ? generatedPassword() : requirePassword(input.password);
    const repository = await repositories.get(input.repositoryId);
    if (!repository) throw statusError(404, "Repository not found");
    const relativeSubpath = normalizeRelativePath(input.relativeSubpath ?? "");
    await repositories.resolve(repository.id, relativeSubpath);
    const at = nowDate(now).toISOString();
    const userId = requireId(id());
    try {
      const bootstrapPassword = input.kind === "workstation" ? password : null;
      const bootstrapExpiresAt = bootstrapPassword ? new Date(Date.parse(at) + 15 * 60 * 1000).toISOString() : null;
      await db.prepare(`INSERT INTO receiver_users(id,username,password_hash,bootstrap_password,bootstrap_expires_at,repository_id,relative_subpath,enabled,kind,workstation_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,1,?,?,?,?)`)
        .bind(userId, username, await hashPassword(password), bootstrapPassword, bootstrapExpiresAt, repository.id, relativeSubpath, input.kind === "workstation" ? "workstation" : "manual", input.workstationId ?? null, at, at).run();
    } catch (error) { if (/UNIQUE/i.test(String(error))) throw statusError(409, "Receiver username is already in use"); throw error; }
    return { user: await get(userId), password };
  }
  async function get(userId) {
    const row = await db.prepare(`SELECT u.*,r.name AS repository_name,r.relative_path AS repository_path FROM receiver_users u JOIN repositories r ON r.id=u.repository_id WHERE u.id=?`).bind(requireId(userId)).first();
    return row ? present(row) : null;
  }
  async function resetPassword(userId, password = generatedPassword()) {
    const next = requirePassword(password);
    const at = nowDate(now).toISOString();
    const bootstrapExpiresAt = new Date(Date.parse(at) + 15 * 60 * 1000).toISOString();
    const result = await db.prepare("UPDATE receiver_users SET password_hash=?,bootstrap_password=CASE WHEN kind='workstation' THEN ? ELSE bootstrap_password END,bootstrap_expires_at=CASE WHEN kind='workstation' THEN ? ELSE bootstrap_expires_at END,updated_at=? WHERE id=?").bind(await hashPassword(next), next, bootstrapExpiresAt, at, requireId(userId)).run();
    if (Number(result.meta?.changes ?? 0) !== 1) throw statusError(404, "Receiver user not found");
    return { user: await get(userId), password: next };
  }
  async function consumeBootstrapPassword(workstationId) {
    const at = nowDate(now).toISOString();
    const row = await db.prepare("SELECT bootstrap_password FROM receiver_users WHERE workstation_id=? AND kind='workstation' AND enabled=1 AND bootstrap_password IS NOT NULL AND bootstrap_expires_at>? LIMIT 1").bind(requireId(workstationId), at).first();
    if (!row?.bootstrap_password) return null;
    const password = String(row.bootstrap_password);
    const result = await db.prepare("UPDATE receiver_users SET bootstrap_password=NULL,updated_at=? WHERE workstation_id=? AND kind='workstation' AND enabled=1 AND bootstrap_password=?").bind(at, requireId(workstationId), password).run();
    return Number(result.meta?.changes ?? 0) === 1 ? password : null;
  }
  async function setEnabled(userId, enabled) {
    if (typeof enabled !== "boolean") throw new RangeError("enabled must be boolean");
    const result = await db.prepare("UPDATE receiver_users SET enabled=?,updated_at=? WHERE id=?").bind(enabled ? 1 : 0, nowDate(now).toISOString(), requireId(userId)).run();
    if (Number(result.meta?.changes ?? 0) !== 1) throw statusError(404, "Receiver user not found");
    return get(userId);
  }
  async function remove(userId) {
    const result = await db.prepare("DELETE FROM receiver_users WHERE id=?").bind(requireId(userId)).run();
    if (Number(result.meta?.changes ?? 0) !== 1) throw statusError(404, "Receiver user not found");
    return { deleted: true, id: userId };
  }
  async function updateWorkstationRoot(workstationId, repositoryId, relativeSubpath) {
    const repository = await repositories.get(repositoryId);
    if (!repository) throw statusError(404, "Repository not found");
    const normalized = normalizeRelativePath(relativeSubpath ?? "");
    await repositories.resolve(repository.id, normalized);
    const result = await db.prepare("UPDATE receiver_users SET repository_id=?,relative_subpath=?,updated_at=? WHERE workstation_id=? AND kind='workstation'")
      .bind(repository.id, normalized, nowDate(now).toISOString(), requireId(workstationId)).run();
    if (Number(result.meta?.changes ?? 0) !== 1) throw statusError(404, "Workstation receiver user not found");
    return get((await db.prepare("SELECT id FROM receiver_users WHERE workstation_id=? AND kind='workstation'").bind(requireId(workstationId)).first()).id);
  }
  async function authenticate(username, password) {
    const row = await db.prepare("SELECT * FROM receiver_users WHERE username=? AND enabled=1").bind(normalizeUsername(username)).first();
    if (!row || !(await verifyPassword(password, String(row.password_hash)))) throw statusError(401, "Invalid receiver credentials");
    return present(row);
  }
  async function rootFor(username, subpath = "") {
    const row = await db.prepare("SELECT u.*,r.name AS repository_name,r.relative_path AS repository_path FROM receiver_users u JOIN repositories r ON r.id=u.repository_id WHERE u.username=? AND u.enabled=1").bind(normalizeUsername(username)).first();
    if (!row) throw statusError(401, "Invalid or disabled receiver user");
    const relativeSubpath = normalizeRelativePath(subpath);
    if (relativeSubpath && !relativeSubpath.startsWith(String(row.relative_subpath) + "/") && relativeSubpath !== String(row.relative_subpath)) throw statusError(403, "Path is outside the receiver root");
    return { user: present(row), relativePath: String(row.repository_path) + (row.relative_subpath ? `/${row.relative_subpath}` : "") };
  }
  async function resolvePath(username, subpath = "") {
    const root = await rootFor(username);
    const child = normalizeRelativePath(subpath);
    const relativePath = child ? `${root.relativePath}/${child}` : root.relativePath;
    const resolved = await repositories.paths.resolveRelative(relativePath);
    return { ...root, ...resolved, relativePath: resolved.relative };
  }
  return { list, get, create, resetPassword, consumeBootstrapPassword, setEnabled, remove, updateWorkstationRoot, authenticate, rootFor, resolvePath };
}

export function normalizeUsername(value) {
  if (typeof value !== "string") throw new RangeError("username must be a string");
  const username = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!username || username.length > 64) throw new RangeError("username must contain at least one valid character");
  return username;
}
export function generatedPassword() { return randomBytes(PASSWORD_BYTES).toString("base64url"); }
function requirePassword(value) { if (typeof value !== "string" || value.length < 20 || value.length > 256) throw new RangeError("password must be 20-256 characters"); return value; }
async function hashPassword(password) { const salt = randomBytes(16); const derived = await scrypt(password, salt, 64); return `scrypt$${salt.toString("base64url")}$${Buffer.from(derived).toString("base64url")}`; }
async function verifyPassword(password, encoded) { try { const [, saltText, hashText] = encoded.split("$"); const actual = Buffer.from(await scrypt(requirePassword(password), Buffer.from(saltText, "base64url"), 64)); const expected = Buffer.from(hashText, "base64url"); return actual.length === expected.length && timingSafeEqual(actual, expected); } catch { return false; } }
function present(row) { return { id:String(row.id), username:String(row.username), repositoryId:String(row.repository_id), repositoryName:row.repository_name == null ? null : String(row.repository_name), relativeSubpath:String(row.relative_subpath ?? ""), enabled:Number(row.enabled) === 1, kind:String(row.kind), workstationId:row.workstation_id == null ? null : String(row.workstation_id), createdAt:String(row.created_at), updatedAt:String(row.updated_at) }; }
function requireId(value) { if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.trim())) throw new RangeError("receiver id is invalid"); return value.trim(); }
function nowDate(now) { const date = new Date(now()); if (!Number.isFinite(date.getTime())) throw new TypeError("now() must return a valid date"); return date; }
function statusError(statusCode, message) { const error = new Error(message); error.statusCode = statusCode; return error; }
