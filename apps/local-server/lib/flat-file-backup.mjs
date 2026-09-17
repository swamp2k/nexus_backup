import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";

// A deliberately boring file copier. The destination is never mirrored: files
// absent from the source are retained, and replacements become visible only
// after the complete temporary file has been flushed and renamed.
export async function copyFlatBackup({ sourcePaths, destinationRoot, excludes = [], onProgress = () => {} } = {}) {
  if (!Array.isArray(sourcePaths) || sourcePaths.length === 0) throw new RangeError("sourcePaths must contain at least one path");
  if (typeof destinationRoot !== "string" || !destinationRoot.trim()) throw new RangeError("destinationRoot is required");
  await mkdir(destinationRoot, { recursive: true });
  const destination = resolve(destinationRoot);
  const seenRoots = new Set();
  let files = 0, bytes = 0, copiedBytes = 0;
  for (const sourceValue of sourcePaths) {
    if (typeof sourceValue !== "string" || !sourceValue.trim()) throw new RangeError("source path must be a non-empty string");
    const source = resolve(sourceValue);
    const rootName = basename(source) || "source";
    const rootDestination = join(destination, rootName);
    if (seenRoots.has(rootDestination)) throw new Error(`source folder collision: ${rootName}`);
    seenRoots.add(rootDestination);
    const stat = await lstat(source);
    if (!stat.isDirectory()) throw new Error(`source is not a directory: ${source}`);
    await walk(source, rootDestination, "", { excludes, onProgress: (item) => { files += item.files; bytes += item.bytes; copiedBytes += item.copiedBytes; onProgress({ ...item, files, bytes, copiedBytes }); } });
  }
  return { files, bytes, copiedBytes, destinationRoot: destination };
}

async function walk(sourceRoot, destinationRoot, subpath, { excludes, onProgress }) {
  const sourceDirectory = subpath ? join(sourceRoot, subpath) : sourceRoot;
  const entries = await readdir(sourceDirectory, { withFileTypes: true });
  for (const entry of entries) {
    const childPath = subpath ? `${subpath}/${entry.name}` : entry.name;
    if (matchesExclude(childPath, excludes)) continue;
    const from = join(sourceRoot, childPath);
    const to = join(destinationRoot, childPath);
    const stat = await lstat(from);
    if (stat.isDirectory()) {
      await mkdir(to, { recursive: true });
      await walk(sourceRoot, destinationRoot, childPath, { excludes, onProgress });
    } else if (stat.isFile()) {
      const result = await copyFileAtomic(from, to);
      onProgress({ path: childPath, files: 1, bytes: stat.size, copiedBytes: result.bytes });
    }
    // Symlinks and other special files are intentionally ignored. Following a
    // symlink could copy outside a selected workstation source tree.
  }
}

export async function copyFileAtomic(source, destination) {
  await mkdir(resolve(destination, ".."), { recursive: true });
  const temporary = `${destination}.nexus-upload-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let sourceHandle;
  let outputHandle;
  try {
    sourceHandle = await open(source, "r");
    outputHandle = await open(temporary, "wx", 0o600);
    const input = createReadStream(null, { fd: sourceHandle.fd, autoClose: false });
    const output = createWriteStream(null, { fd: outputHandle.fd, autoClose: false });
    await pipeline(input, output);
    await outputHandle.sync();
    await outputHandle.close();
    outputHandle = null;
    await sourceHandle.close();
    sourceHandle = null;
    await rename(temporary, destination);
    const stat = await lstat(destination);
    return { bytes: stat.size, sha256: await sha256(destination) };
  } catch (error) {
    try { await outputHandle?.close(); } catch {}
    try { await sourceHandle?.close(); } catch {}
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function sha256(path) {
  const hash = createHash("sha256");
  const stream = createReadStream(path);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}
function matchesExclude(value, excludes) { return Array.isArray(excludes) && excludes.some((pattern) => typeof pattern === "string" && wildcard(pattern, value)); }
function wildcard(pattern, value) { const expression = pattern.split("*").map(escapeRegex).join(".*"); return new RegExp(`^${expression}$`, "i").test(value) || new RegExp(`(^|/)${expression}(/|$)`, "i").test(value); }
function escapeRegex(value) { return value.replace(/[.+?^${}()|[\]\\]/g, "\\$&"); }
