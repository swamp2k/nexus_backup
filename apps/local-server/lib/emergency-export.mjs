import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, lstat, mkdir, readFile, readdir, readlink, realpath, rm, stat, writeFile, chmod } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const REQUIRED_CONTROL_FILES = ["control-token", "agent-token"];
const OPTIONAL_CONTROL_FILES = ["auth.json", "setup-token"];
const DEFAULT_RUNBOOK_PATH = fileURLToPath(new URL("../../../docs/emergency-recovery.md", import.meta.url));

export async function createEmergencyBundle({
  configDir = "/config",
  agentConfigDir = "/agent-config",
  outputDir,
  databaseName = "nexus-backup.sqlite",
  runbookPath = DEFAULT_RUNBOOK_PATH,
  version = process.env.NEXUS_BACKUP_VERSION ?? "unknown",
  revision = process.env.NEXUS_BACKUP_REVISION ?? "unknown",
  now = () => new Date(),
} = {}) {
  if (typeof outputDir !== "string" || !outputDir.trim()) throw new TypeError("outputDir is required");
  assertSafeDatabaseName(databaseName);

  const controlRequested = resolve(configDir);
  const agentRequested = resolve(agentConfigDir);
  const runbookSource = resolve(runbookPath);
  await requireDirectory(controlRequested, "control config directory");
  await requireDirectory(agentRequested, "agent config directory");
  await requireRegularFile(runbookSource, "emergency recovery runbook");
  const controlSource = await realpath(controlRequested);
  const agentSource = await realpath(agentRequested);

  const databasePath = join(controlSource, databaseName);
  await requireRegularFile(databasePath, "control database");
  for (const name of REQUIRED_CONTROL_FILES) await requireRegularFile(join(controlSource, name), name);

  const output = await resolveProspectivePath(resolve(outputDir));
  assertNoPathOverlap(output, controlSource, "control config");
  assertNoPathOverlap(output, agentSource, "agent config");

  await mkdir(dirname(output), { recursive: true });
  await mkdir(output, { mode: 0o700 });
  await chmod(output, 0o700);

  try {
    const controlTarget = join(output, "control");
    const agentTarget = join(output, "agent-config");
    await mkdir(controlTarget, { mode: 0o700 });

    const snapshotPath = join(controlTarget, databaseName);
    const sourceQuickCheck = snapshotDatabase(databasePath, snapshotPath);

    for (const name of REQUIRED_CONTROL_FILES) {
      await cp(join(controlSource, name), join(controlTarget, name), { preserveTimestamps: true });
    }
    for (const name of OPTIONAL_CONTROL_FILES) {
      if (await exists(join(controlSource, name))) {
        await cp(join(controlSource, name), join(controlTarget, name), { preserveTimestamps: true });
      }
    }
    await cp(agentSource, agentTarget, { recursive: true, preserveTimestamps: true, errorOnExist: true });

    const snapshotInfo = inspectSnapshot(snapshotPath);
    if (!snapshotInfo.integrityOk) throw new Error(`Emergency database snapshot failed integrity_check: ${snapshotInfo.integrity.join("; ")}`);

    const readme = emergencyReadme({ version, revision });
    await writeFile(join(output, "RECOVERY.txt"), readme, { mode: 0o600 });
    await cp(runbookSource, join(output, "EMERGENCY-RECOVERY.md"), { preserveTimestamps: true });
    await chmod(join(output, "EMERGENCY-RECOVERY.md"), 0o600);

    const files = await collectBundleFiles(output, { exclude: new Set(["manifest.json"]) });
    const createdAt = normalizeDate(now()).toISOString();
    const manifest = {
      formatVersion: 1,
      createdAt,
      nexusBackup: { version: String(version), revision: String(revision) },
      containsSecrets: true,
      recoveryRunbook: "EMERGENCY-RECOVERY.md",
      database: {
        path: `control/${databaseName}`,
        sourceQuickCheck,
        integrityCheck: snapshotInfo.integrity,
        migrations: snapshotInfo.migrations,
      },
      requiredRestoreRoots: ["control", "agent-config"],
      excludedByDesign: [
        "backup repository payloads",
        "source data",
        "restore staging data",
        "runtime token mirror",
        "disposable agent caches/state",
        "workstation-local repository credentials",
        "container image archives",
      ],
      files,
    };
    await writeFile(join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    await chmod(join(output, "manifest.json"), 0o600);
    return manifest;
  } catch (error) {
    await rm(output, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function verifyEmergencyBundle(bundleDir) {
  const root = resolve(bundleDir);
  const manifestPath = join(root, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest?.formatVersion !== 1 || !Array.isArray(manifest.files)) throw new Error("Unsupported or invalid emergency bundle manifest");

  const actual = await collectBundleFiles(root, { exclude: new Set(["manifest.json"]) });
  const expected = [...manifest.files].sort(compareEntries);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("Emergency bundle file inventory or SHA-256 verification failed");

  const runbookRelativePath = safeBundleRelativePath(manifest.recoveryRunbook, "recoveryRunbook");
  if (!expected.some((entry) => entry?.path === runbookRelativePath)) {
    throw new Error("Emergency recovery runbook is not present in the verified file manifest");
  }
  const runbookFile = resolve(root, runbookRelativePath);
  if (!sameOrInside(runbookFile, root)) throw new Error("Emergency recovery runbook path escapes the bundle root");
  await requireRegularFile(runbookFile, "emergency recovery runbook");

  const databaseRelativePath = safeBundleRelativePath(manifest.database?.path, "database.path");
  if (!expected.some((entry) => entry?.path === databaseRelativePath)) {
    throw new Error("Emergency database snapshot is not present in the verified file manifest");
  }
  const databasePath = resolve(root, databaseRelativePath);
  if (!sameOrInside(databasePath, root)) throw new Error("Emergency database path escapes the bundle root");
  await requireRegularFile(databasePath, "emergency database snapshot");
  const snapshot = inspectSnapshot(databasePath);
  if (!snapshot.integrityOk) throw new Error(`Emergency database snapshot failed integrity_check: ${snapshot.integrity.join("; ")}`);
  return { ok: true, manifest, database: snapshot };
}

function snapshotDatabase(sourcePath, targetPath) {
  const database = new DatabaseSync(sourcePath);
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    const quick = pragmaValues(database, "quick_check");
    if (quick.length !== 1 || quick[0] !== "ok") throw new Error(`Control database quick_check failed: ${quick.join("; ")}`);
    database.exec(`VACUUM INTO '${sqlString(targetPath)}'`);
    return quick;
  } finally {
    database.close();
  }
}

function inspectSnapshot(path) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    database.exec("PRAGMA foreign_keys = ON");
    const integrity = pragmaValues(database, "integrity_check");
    let migrations = [];
    try {
      migrations = database.prepare("SELECT name, applied_at AS appliedAt FROM nexus_backup_migrations ORDER BY name").all();
    } catch {}
    return { integrityOk: integrity.length === 1 && integrity[0] === "ok", integrity, migrations };
  } finally {
    database.close();
  }
}

function pragmaValues(database, pragma) {
  return database.prepare(`PRAGMA ${pragma}`).all().map((row) => String(Object.values(row)[0] ?? ""));
}

async function collectBundleFiles(root, { exclude = new Set() } = {}) {
  const entries = [];
  await walk(root, "", entries, exclude);
  return entries.sort(compareEntries);
}

async function walk(root, relativeDir, entries, exclude) {
  const absoluteDir = join(root, relativeDir);
  const children = await readdir(absoluteDir, { withFileTypes: true });
  children.sort((a, b) => a.name.localeCompare(b.name));
  for (const child of children) {
    const relativePath = relativeDir ? `${relativeDir}/${child.name}` : child.name;
    if (exclude.has(relativePath)) continue;
    const absolutePath = join(root, relativePath);
    if (child.isDirectory()) {
      await walk(root, relativePath, entries, exclude);
      continue;
    }
    if (child.isSymbolicLink()) {
      const target = await readlink(absolutePath);
      throw new Error(`Emergency bundle must be self-contained; symlink found at ${relativePath} -> ${target}`);
    }
    if (!child.isFile()) throw new Error(`Unsupported filesystem entry in emergency bundle: ${relativePath}`);
    const fileStat = await stat(absolutePath);
    entries.push({ path: relativePath, size: fileStat.size, sha256: await sha256File(absolutePath) });
  }
}

async function sha256File(path) {
  const hash = createHash("sha256");
  await new Promise((resolvePromise, rejectPromise) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", rejectPromise);
    stream.on("end", resolvePromise);
  });
  return hash.digest("hex");
}

async function requireRegularFile(path, label) {
  let info;
  try { info = await lstat(path); }
  catch (error) { if (error?.code === "ENOENT") throw new Error(`Missing ${label}: ${path}`); throw error; }
  if (!info.isFile()) throw new Error(`${label} must be a regular file: ${path}`);
}

async function requireDirectory(path, label) {
  let info;
  try { info = await lstat(path); }
  catch (error) { if (error?.code === "ENOENT") throw new Error(`Missing ${label}: ${path}`); throw error; }
  if (!info.isDirectory()) throw new Error(`${label} must be a directory: ${path}`);
}

async function exists(path) {
  try { await lstat(path); return true; }
  catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}

async function resolveProspectivePath(path) {
  let current = resolve(path);
  const missing = [];
  for (;;) {
    try {
      const existing = await realpath(current);
      return resolve(existing, ...missing.reverse());
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      missing.push(basename(current));
      current = parent;
    }
  }
}

function assertNoPathOverlap(output, source, label) {
  if (sameOrInside(output, source) || sameOrInside(source, output)) {
    throw new Error(`Emergency output must not overlap ${label}: ${source}`);
  }
}

function sameOrInside(candidate, parent) {
  const rel = relative(parent, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function assertSafeDatabaseName(value) {
  if (typeof value !== "string" || !value || value !== basename(value) || value === "." || value === "..") {
    throw new TypeError("databaseName must be a simple filename");
  }
}

function safeBundleRelativePath(value, label) {
  if (typeof value !== "string" || !value || isAbsolute(value)) throw new Error(`Emergency manifest ${label} must be a safe relative path`);
  const normalized = value.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`Emergency manifest ${label} must be a safe relative path`);
  }
  return normalized;
}

function sqlString(value) { return String(value).replaceAll("'", "''"); }
function compareEntries(a, b) { return a.path.localeCompare(b.path); }
function normalizeDate(value) { const date = value instanceof Date ? new Date(value) : new Date(value); if (!Number.isFinite(date.getTime())) throw new TypeError("now() must return a valid date"); return date; }

function emergencyReadme({ version, revision }) {
  return `Nexus Backup emergency recovery bundle\n\n` +
    `Nexus version: ${version}\nRevision: ${revision}\n\n` +
    `THIS DIRECTORY CONTAINS SECRETS. Store it encrypted and offline from the Nexus host.\n\n` +
    `Start with EMERGENCY-RECOVERY.md in this bundle; it is covered by manifest.json.\n` +
    `control/ contains a consistent SQLite snapshot plus controller/auth identity files.\n` +
    `agent-config/ contains local agent configuration and storage credentials.\n` +
    `manifest.json contains SHA-256 hashes and the applied migration list.\n\n` +
    `Backup repository payloads, source data, and container image archives are intentionally not included.\n`;
}
