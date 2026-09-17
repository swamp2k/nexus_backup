import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, rm, stat } from "node:fs/promises";
import { D1JobRepository } from "../../control-plane/dist/index.js";
import { JobService } from "@nexus-backup/core";

const LOCAL_AGENT_ID = "nexus-local-executor";
const RESERVED_RCLONE_FLAGS = new Set(["-n", "--config", "--dry-run", "--use-json-log", "--partial-suffix", "--backup-dir", "--compare-dest", "--copy-dest", "--suffix", "--suffix-keep-extension", "--log-file", "--password-command"]);

// Repository destinations are executed by the gateway process. The job record is
// retained for UI/history, but no agent registration, token, or lease service is
// required to make the transfer run.
export function createLocalRepositoryTransferExecutor({ db, repositories, enqueueJob, loadConfig, command = runCommand, now = () => new Date(), id = () => randomUUID() } = {}) {
  if (!db || !repositories || typeof enqueueJob !== "function" || typeof loadConfig !== "function") throw new TypeError("local repository transfer dependencies are required");
  const jobs = new JobService(new D1JobRepository(db), { eventIdFactory: id });

  async function execute(payload) {
    const normalized = normalizeTransferPayload(payload);
    const job = await enqueueJob({
      operationKey: normalized.operationKey,
      type: "managed-transfer",
      payload: normalized.payload,
    });
    const acquired = await jobs.acquire({ jobId: String(job.id), agentId: LOCAL_AGENT_ID, token: id(), now: date(now), ttlMs: 600_000 });
    const token = acquired.lease?.token;
    if (!token) throw new Error("local transfer job did not acquire a lease");
    let current = await jobs.transition(acquired.id, LOCAL_AGENT_ID, token, "preparing", date(now));
    try {
      current = await jobs.transition(current.id, LOCAL_AGENT_ID, token, "running", date(now));
      await transfer({ ...normalized.payload, jobId: current.id }, { signal: new AbortController().signal });
      current = await jobs.transition(current.id, LOCAL_AGENT_ID, token, "finalizing", date(now));
      current = await jobs.transition(current.id, LOCAL_AGENT_ID, token, "completed", date(now));
      return { job: current, completed: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      current = await jobs.transition(current.id, LOCAL_AGENT_ID, token, "failed", date(now), message);
      return { job: current, completed: false, error: message };
    }
  }

  async function transfer(payload, { signal }) {
    const config = await loadConfig();
    const endpoint = (config.rcloneEndpoints ?? []).find((item) => String(item.id) === payload.sourceEndpointId);
    if (!endpoint || typeof endpoint.fs !== "string" || !endpoint.fs.trim()) throw new Error(`unknown sourceEndpointId: ${payload.sourceEndpointId}`);
    if (payload.mode === "move" && endpoint.allowMove !== true) throw new Error(`source endpoint does not allow move: ${payload.sourceEndpointId}`);
    const repository = await repositories.get(payload.destinationRepositoryId);
    if (!repository) throw new Error(`repository not found: ${payload.destinationRepositoryId}`);
    const destination = await repositories.resolve(payload.destinationRepositoryId, payload.destinationPath);
    const stage = await repositories.paths.resolveRelative(`${repository.relativePath}/.nexus-backup-staging/${payload.jobId}`);
    await repositories.paths.ensureDirectory(`${repository.relativePath}/.nexus-backup-staging/${payload.jobId}`);
    const tool = config.tools ?? {};
    const common = ["--partial-suffix", ".nexus-part", "--use-json-log", "--stats", "1s", "--stats-log-level", "NOTICE", "--stats-file-name-length", "0", ...(tool.rcloneArgs ?? []), ...payload.rcloneArgs];
    try {
      for (const item of payload.items) {
        const source = joinTarget(endpoint.fs, joinRelative(payload.sourcePath, item.relPath));
        const staged = joinTarget(stage.absolute, item.relPath);
        await invoke(tool, ["copyto", source, staged, ...common], command, signal);
      }
      for (const item of payload.items) await verify(tool, joinTarget(stage.absolute, item.relPath), item.size, command, signal);
      for (const item of payload.items) {
        const staged = joinTarget(stage.absolute, item.relPath);
        const finalPath = joinTarget(destination.absolute, item.relPath);
        await invoke(tool, ["moveto", staged, finalPath], command, signal);
      }
      for (const item of payload.items) await verify(tool, joinTarget(destination.absolute, item.relPath), item.size, command, signal);
      if (payload.mode === "move") {
        for (const item of payload.items) {
          const source = joinTarget(endpoint.fs, joinRelative(payload.sourcePath, item.relPath));
          await invoke(tool, ["deletefile", source], command, signal);
        }
      }
    } finally {
      await invoke(tool, ["purge", stage.absolute], command, signal, false).catch(() => {});
    }
  }

  async function executeCleanup(payload) {
    const normalized = normalizeCleanupPayload(payload);
    const job = await enqueueJob({ operationKey: normalized.operationKey, type: "managed-cleanup", payload: normalized.payload });
    const acquired = await jobs.acquire({ jobId: String(job.id), agentId: LOCAL_AGENT_ID, token: id(), now: date(now), ttlMs: 600_000 });
    const token = acquired.lease?.token;
    if (!token) throw new Error("local cleanup job did not acquire a lease");
    let current = await jobs.transition(acquired.id, LOCAL_AGENT_ID, token, "preparing", date(now));
    try {
      current = await jobs.transition(current.id, LOCAL_AGENT_ID, token, "running", date(now));
      const repository = await repositories.get(normalized.payload.destinationRepositoryId);
      if (!repository) throw new Error(`repository not found: ${normalized.payload.destinationRepositoryId}`);
      const target = await repositories.resolve(normalized.payload.destinationRepositoryId, joinRelative(normalized.payload.destinationPath, normalized.payload.relPath));
      const info = await stat(target.absolute);
      if (!info.isFile()) throw new Error("cleanup target is not a regular file");
      if (info.size !== normalized.payload.expectedSize) throw new Error(`cleanup refused modified destination: expected ${normalized.payload.expectedSize} bytes, got ${info.size}`);
      if (info.mtimeMs !== Date.parse(normalized.payload.expectedModTime)) throw new Error(`cleanup refused modified destination: expected modification time ${normalized.payload.expectedModTime}, got ${info.mtime.toISOString()}`);
      await rm(target.absolute);
      current = await jobs.transition(current.id, LOCAL_AGENT_ID, token, "finalizing", date(now));
      current = await jobs.transition(current.id, LOCAL_AGENT_ID, token, "completed", date(now));
      return { job: current, completed: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      current = await jobs.transition(current.id, LOCAL_AGENT_ID, token, "failed", date(now), message);
      return { job: current, completed: false, error: message };
    }
  }

  return { execute, executeCleanup };
}

export async function loadLocalRcloneConfig(path) {
  const value = JSON.parse(await readFile(path, "utf8"));
  return { rcloneEndpoints: Array.isArray(value?.rcloneEndpoints) ? value.rcloneEndpoints : [], tools: isRecord(value?.tools) ? value.tools : {} };
}

function normalizeTransferPayload(value) {
  if (!isRecord(value)) throw new RangeError("managed transfer payload must be an object");
  const items = Array.isArray(value.items) ? value.items.map((item) => ({ relPath: safePath(item.relPath), size: nonNegative(item.size, "item.size") })) : [];
  if (!items.length) throw new RangeError("managed transfer requires at least one item");
  const rcloneArgs = Array.isArray(value.rcloneArgs) ? value.rcloneArgs.map(String) : [];
  for (const arg of rcloneArgs) if (RESERVED_RCLONE_FLAGS.has(arg.split("=", 1)[0]) || arg.startsWith("--stats") || arg.startsWith("--multi-thread") || arg.startsWith("--delete-")) throw new RangeError(`rcloneArgs may not override managed transfer safety flag: ${arg}`);
  const destinationRepositoryId = requireId(value.destinationRepositoryId, "destinationRepositoryId");
  const ruleId = requireId(value.ruleId, "ruleId");
  const attempt = positive(value.transferAttempt, "transferAttempt");
  return {
    operationKey: `transfer:${ruleId}:${String(value.objectKey ?? items[0].relPath)}:attempt:${attempt}`,
    payload: {
      ruleId,
      sourceEndpointId: requireId(value.sourceEndpointId, "sourceEndpointId"),
      sourcePath: safeBase(value.sourcePath),
      destinationRepositoryId,
      destinationPath: safeBase(value.destinationPath),
      mode: value.mode === "move" ? "move" : "copy",
      rcloneArgs,
      items,
    },
  };
}

function normalizeCleanupPayload(value) {
  if (!isRecord(value)) throw new RangeError("managed cleanup payload must be an object");
  const ruleId = requireId(value.ruleId, "ruleId");
  const destinationRepositoryId = requireId(value.destinationRepositoryId, "destinationRepositoryId");
  const relPath = safePath(value.relPath);
  const expectedSize = nonNegative(value.expectedSize, "expectedSize");
  const expectedModTime = typeof value.expectedModTime === "string" && Number.isFinite(Date.parse(value.expectedModTime)) ? new Date(value.expectedModTime).toISOString() : null;
  if (!expectedModTime) throw new RangeError("expectedModTime must be a valid timestamp");
  const attempt = positive(value.cleanupAttempt, "cleanupAttempt");
  return {
    operationKey: `transfer-cleanup:${ruleId}:${String(value.objectKey)}:attempt:${attempt}`,
    payload: { ruleId, destinationRepositoryId, destinationPath: safeBase(value.destinationPath), relPath, expectedSize, expectedModTime, objectKey: String(value.objectKey), cleanupAttempt: attempt },
  };
}

async function verify(tool, target, expected, command, signal) {
  const result = await invoke(tool, ["lsjson", target, "--stat", "--no-mimetype"], command, signal);
  let value;
  try { value = JSON.parse(result.stdout); } catch { throw new Error("rclone verification returned invalid JSON"); }
  const actual = Number(value?.Size ?? value?.size);
  if (!Number.isSafeInteger(actual) || actual !== expected) throw new Error(`rclone size verification failed: expected ${expected} bytes, got ${Number.isFinite(actual) ? actual : "unknown"}`);
}

async function invoke(tool, args, command, signal, required = true) {
  const full = [...args];
  if (tool.rcloneConfigPath) full.push("--config", String(tool.rcloneConfigPath));
  const result = await command(String(tool.rcloneBinary || "rclone"), full, signal);
  if (required && result.code !== 0) throw new Error(`rclone exited with code ${result.code}: ${(result.stderr || "").trim().slice(-1000)}`);
  return result;
}

function runCommand(executable, args, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout = (stdout + chunk).slice(-65536); });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-65536); });
    const abort = () => child.kill("SIGTERM");
    signal.addEventListener("abort", abort, { once: true });
    child.once("error", reject);
    child.once("close", (code) => { signal.removeEventListener("abort", abort); resolve({ code, stdout, stderr }); });
  });
}

function joinTarget(base, relative) { return !relative ? base : base.endsWith(":") || base.endsWith("/") ? `${base}${relative}` : `${base}/${relative}`; }
function joinRelative(...parts) { return parts.filter(Boolean).map((part) => String(part).replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/"); }
function safePath(value) { if (typeof value !== "string") throw new RangeError("transfer path must be a string"); const normalized = value.replaceAll("\\", "/").replace(/^\/+|\/+$/g, ""); if (!normalized || normalized.split("/").some((part) => !part || part === "." || part === "..")) throw new RangeError("transfer path must be safe and relative"); return normalized; }
function safeBase(value) { if (value === undefined || value === null || value === "") return ""; if (typeof value !== "string") throw new RangeError("transfer base path must be a string"); const normalized = value.trim().replaceAll("\\", "/").replace(/^\/+|\/+$/g, ""); if (normalized.split("/").some((part) => !part || part === "." || part === "..")) throw new RangeError("transfer base path may not contain dot segments"); return normalized; }
function requireId(value, name) { if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value.trim())) throw new RangeError(`${name} is invalid`); return value.trim(); }
function positive(value, name) { const result = Number(value); if (!Number.isSafeInteger(result) || result < 1) throw new RangeError(`${name} must be positive`); return result; }
function nonNegative(value, name) { const result = Number(value); if (!Number.isSafeInteger(result) || result < 0) throw new RangeError(`${name} must be non-negative`); return result; }
function date(now) { const result = new Date(now()); if (!Number.isFinite(result.getTime())) throw new TypeError("now() must return a valid date"); return result; }
function isRecord(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
