import { access, lstat, mkdir, readdir, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

// All user-controlled storage paths go through this boundary. The root is
// created once and then every existing component is resolved to catch symlink
// escapes, including symlinks introduced after a record was created.
export function createBackupPathService({ root = "/backup" } = {}) {
  const configuredRoot = resolve(root);

  async function ensureRoot() {
    await mkdir(configuredRoot, { recursive: true });
    return realpath(configuredRoot);
  }

  async function resolveRelative(relativePath = "", { allowMissing = true } = {}) {
    const normalized = normalizeRelativePath(relativePath);
    const canonicalRoot = await ensureRoot();
    const candidate = resolve(canonicalRoot, ...normalized ? normalized.split("/") : []);
    assertBelow(canonicalRoot, candidate);
    const existing = await nearestExisting(candidate);
    const canonicalExisting = await realpath(existing);
    assertBelow(canonicalRoot, canonicalExisting);
    if (!allowMissing && existing !== candidate) {
      throw pathError(404, `Storage path does not exist: ${normalized || "/"}`);
    }
    return { absolute: candidate, relative: normalized, root: canonicalRoot };
  }

  async function ensureDirectory(relativePath = "") {
    const target = await resolveRelative(relativePath);
    await mkdir(target.absolute, { recursive: true });
    const canonical = await realpath(target.absolute);
    assertBelow(target.root, canonical);
    return { ...target, absolute: canonical };
  }

  async function listDirectory(relativePath = "") {
    const target = await resolveRelative(relativePath, { allowMissing: false });
    const stat = await lstat(target.absolute);
    if (!stat.isDirectory()) throw pathError(400, "Storage path is not a directory");
    const entries = await readdir(target.absolute, { withFileTypes: true });
    return Promise.all(entries.sort((a, b) => a.name.localeCompare(b.name)).map(async (entry) => {
      const childRelative = target.relative ? `${target.relative}/${entry.name}` : entry.name;
      const child = await resolveRelative(childRelative);
      let childStat;
      try { childStat = await lstat(child.absolute); } catch { childStat = null; }
      return {
        name: entry.name,
        relativePath: child.relative,
        type: entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink" : "file",
        size: childStat?.isFile() ? childStat.size : null,
        modifiedAt: childStat?.mtime?.toISOString() ?? null,
      };
    }));
  }

  return { root: configuredRoot, ensureRoot, resolveRelative, ensureDirectory, listDirectory };
}

export function normalizeRelativePath(value) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") throw pathError(400, "Storage path must be a string");
  const normalized = value.trim().replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  if (!normalized) return "";
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || /[\u0000\r\n]/.test(part))) {
    throw pathError(400, "Storage path contains an unsafe path segment");
  }
  if (normalized.length > 4096) throw pathError(400, "Storage path is too long");
  return parts.join("/");
}

export function safeName(value, field = "name") {
  if (typeof value !== "string") throw pathError(400, `${field} must be a string`);
  const name = value.trim();
  if (!name || name === "." || name === ".." || /[\\/\u0000\r\n]/.test(name) || name.length > 255) {
    throw pathError(400, `${field} must be a safe folder name`);
  }
  return name;
}

async function nearestExisting(candidate) {
  let current = candidate;
  while (true) {
    try { await access(current, constants.F_OK); return current; }
    catch { const parent = dirname(current); if (parent === current) throw new Error("Unable to resolve storage path"); current = parent; }
  }
}

function assertBelow(root, candidate) {
  const value = resolve(candidate);
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (value !== root && !value.startsWith(prefix)) throw pathError(400, "Storage path must remain under /backup");
}

function pathError(statusCode, message) { const error = new Error(message); error.statusCode = statusCode; return error; }
