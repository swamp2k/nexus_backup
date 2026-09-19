import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;

export function createSourceScanStore({ root, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  if (typeof root !== "string" || !root.trim()) throw new TypeError("source scan store root is required");
  const base = resolve(root);
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new TypeError("maxBytes must be a positive integer");

  function validatePart(value, name) {
    const text = String(value ?? "").trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(text)) throw new RangeError(`${name} is invalid`);
    return text;
  }

  function keyForRun(deviceId, runId) {
    return `${validatePart(deviceId, "device id")}/${validatePart(runId, "run id")}.ndjson.gz`;
  }

  function pathForKey(key) {
    const text = String(key ?? "");
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\/[^/]+\.ndjson\.gz$/.test(text)) throw new RangeError("source scan artifact key is invalid");
    const target = resolve(base, text);
    const rel = relative(base, target);
    if (!rel || rel.startsWith("..") || rel.includes("\0")) throw new RangeError("source scan artifact path escapes store");
    return target;
  }

  async function write(deviceId, runId, readable) {
    const key = keyForRun(deviceId, runId);
    const target = pathForKey(key);
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
    let sizeBytes = 0;
    const counter = new Transform({
      transform(chunk, _encoding, callback) {
        sizeBytes += chunk.length;
        if (sizeBytes > maxBytes) {
          callback(Object.assign(new Error(`source scan artifact exceeds ${Math.ceil(maxBytes / 1048576)} MiB`), { statusCode: 413 }));
          return;
        }
        callback(null, chunk);
      },
    });
    try {
      await pipeline(readable, counter, createWriteStream(temporary, { flags: "wx", mode: 0o600 }));
      const handle = await open(temporary, "r");
      await handle.sync();
      await handle.close();
      await rename(temporary, target);
      return { key, sizeBytes };
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }

  async function exists(deviceId, runId) {
    const target = pathForKey(keyForRun(deviceId, runId));
    const info = await stat(target).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
    return Boolean(info?.isFile());
  }

  async function openArtifact(key) {
    const target = pathForKey(key);
    const info = await stat(target);
    if (!info.isFile()) throw Object.assign(new Error("source scan artifact is not a file"), { statusCode: 404 });
    return { stream: createReadStream(target), sizeBytes: info.size };
  }

  async function removeKey(key) {
    if (!key) return;
    await rm(pathForKey(key), { force: true });
  }

  async function removeDevice(deviceId) {
    const prefix = validatePart(deviceId, "device id");
    await rm(resolve(base, prefix), { recursive: true, force: true });
  }

  return { keyForRun, write, exists, openArtifact, removeKey, removeDevice };
}
