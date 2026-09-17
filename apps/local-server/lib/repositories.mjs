import { randomUUID } from "node:crypto";
import { createBackupPathService, normalizeRelativePath, safeName } from "./backup-paths.mjs";

export function createRepositoryService({ db, backupRoot = "/backup", now = () => new Date(), id = () => `repo-${randomUUID()}` } = {}) {
  if (!db) throw new TypeError("db is required");
  const paths = createBackupPathService({ root: backupRoot });

  async function list() {
    const rows = (await db.prepare("SELECT * FROM repositories ORDER BY name COLLATE NOCASE ASC, id ASC").all()).results ?? [];
    return rows.map(present);
  }
  async function get(repositoryId) {
    const row = await db.prepare("SELECT * FROM repositories WHERE id=?").bind(requireId(repositoryId)).first();
    return row ? present(row) : null;
  }
  async function create(input = {}) {
    const name = safeName(input.name, "name");
    const relativePath = input.relativePath === undefined || input.relativePath === null || input.relativePath === ""
      ? normalizeRelativePath(name) : normalizeRelativePath(input.relativePath);
    if (!relativePath) throw new RangeError("Repository location cannot be the backup root");
    const existing = await db.prepare("SELECT id FROM repositories WHERE name=? OR relative_path=? LIMIT 1").bind(name, relativePath).first();
    if (existing) throw statusError(409, "A repository with that name or location already exists");
    await paths.ensureDirectory(relativePath);
    const at = nowDate(now).toISOString();
    const repositoryId = requireId(id());
    await db.prepare("INSERT INTO repositories(id,name,relative_path,created_at,updated_at) VALUES(?,?,?,?,?)")
      .bind(repositoryId, name, relativePath, at, at).run();
    return get(repositoryId);
  }
  async function browse(relativePath = "") {
    const normalized = normalizeRelativePath(relativePath);
    return { path: normalized, entries: await paths.listDirectory(normalized) };
  }
  async function createFolder(relativePath = "", input = {}) {
    const parent = normalizeRelativePath(relativePath);
    const name = safeName(input.name, "name");
    const child = parent ? `${parent}/${name}` : name;
    await paths.ensureDirectory(child);
    return { path: child };
  }
  async function resolve(repositoryId, subpath = "") {
    const row = await db.prepare("SELECT * FROM repositories WHERE id=?").bind(requireId(repositoryId)).first();
    if (!row) throw statusError(404, `Repository not found: ${repositoryId}`);
    const relativeSubpath = normalizeRelativePath(subpath);
    const combined = relativeSubpath ? `${row.relative_path}/${relativeSubpath}` : row.relative_path;
    return { repository: present(row), relativePath: combined, ...(await paths.resolveRelative(combined)) };
  }
  return { list, get, create, browse, createFolder, resolve, paths };
}

export function present(row) {
  return { id: String(row.id), name: String(row.name), relativePath: String(row.relative_path), path: `/backup/${row.relative_path}`, createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
}
function requireId(value) { if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.trim())) throw new RangeError("repository id is invalid"); return value.trim(); }
function nowDate(now) { const date = new Date(now()); if (!Number.isFinite(date.getTime())) throw new TypeError("now() must return a valid date"); return date; }
function statusError(statusCode, message) { const error = new Error(message); error.statusCode = statusCode; return error; }
