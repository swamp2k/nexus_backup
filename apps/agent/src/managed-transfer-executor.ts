import type { BackupJob } from "@nexus-backup/core";
import type { ExecutionEventSink } from "./execution-events.js";
import { noopExecutionEventSink, progressEvent } from "./execution-events.js";
import type { JobExecutionResult, JobExecutor } from "./executor.js";
import type { CommandRunner, CommandResult } from "./process-runner.js";
import { ToolExitError } from "./process-runner.js";
import type { AgentRuntimeConfig } from "./runtime-config.js";

interface TransferItem {
  relPath: string;
  size: number;
  modTime: string;
  objectKey: string;
}

interface ManagedTransferPayload {
  ruleId: string;
  sourceEndpointId: string;
  sourcePath: string;
  destinationEndpointId: string;
  destinationPath: string;
  mode: "copy" | "move";
  verification: "size";
  transferAttempt: number;
  items: TransferItem[];
}

export class ManagedTransferExecutor implements JobExecutor {
  readonly #config: AgentRuntimeConfig;
  readonly #runner: CommandRunner;
  readonly #events: ExecutionEventSink;

  constructor(config: AgentRuntimeConfig, runner: CommandRunner, events: ExecutionEventSink = noopExecutionEventSink) {
    this.#config = config;
    this.#runner = runner;
    this.#events = events;
  }

  async execute(job: BackupJob, signal: AbortSignal): Promise<JobExecutionResult> {
    const payload = parsePayload(job.payload);
    const sourceEndpoint = this.#config.rcloneEndpoint(payload.sourceEndpointId);
    const destinationEndpoint = this.#config.rcloneEndpoint(payload.destinationEndpointId);
    if (payload.mode === "move" && sourceEndpoint.allowMove !== true) {
      throw new Error(`rclone move is not allowed for source endpoint: ${sourceEndpoint.id}`);
    }

    const totalBytes = payload.items.reduce((sum, item) => sum + item.size, 0);
    const stageBase = joinTarget(destinationEndpoint.fs, joinRelative(payload.destinationPath, ".nexus-backup-staging", job.id));
    let completedBytes = 0;
    let completedFiles = 0;

    this.#events.emit({ type: "log", tool: "rclone", stream: "stdout", message: `Preparing staged transfer ${payload.ruleId} (${payload.items.length} file${payload.items.length === 1 ? "" : "s"})` });

    if (payload.transferAttempt > 1) {
      await this.#purgeBestEffort(stageBase, signal, "stale staging");
    }

    for (const item of payload.items) {
      const source = joinTarget(sourceEndpoint.fs, joinRelative(payload.sourcePath, item.relPath));
      const stage = joinTarget(stageBase, item.relPath);
      await this.#copyTo(source, stage, signal, {
        completedBytes,
        completedFiles,
        totalBytes,
        totalFiles: payload.items.length,
      });
      completedBytes += item.size;
      completedFiles += 1;
    }

    this.#events.emit(progressEvent("rclone", {
      bytesDone: completedBytes,
      bytesTotal: totalBytes,
      filesDone: completedFiles,
      filesTotal: payload.items.length,
      speedBytesPerSecond: 0,
      etaSeconds: 0,
      errors: 0,
    }));

    this.#events.emit({ type: "log", tool: "rclone", stream: "stdout", message: "Verifying staged manifest by exact byte size" });
    for (const item of payload.items) {
      const stage = joinTarget(stageBase, item.relPath);
      await this.#verifySize(stage, item.size, signal);
    }

    this.#events.emit({ type: "log", tool: "rclone", stream: "stdout", message: "Committing verified staging to final destination" });
    for (const item of payload.items) {
      const stage = joinTarget(stageBase, item.relPath);
      const final = joinTarget(destinationEndpoint.fs, joinRelative(payload.destinationPath, item.relPath));
      await this.#runRclone(["moveto", stage, final], signal);
    }

    this.#events.emit({ type: "log", tool: "rclone", stream: "stdout", message: "Verifying committed destination" });
    for (const item of payload.items) {
      const final = joinTarget(destinationEndpoint.fs, joinRelative(payload.destinationPath, item.relPath));
      await this.#verifySize(final, item.size, signal);
    }

    let deleted = 0;
    if (payload.mode === "move") {
      this.#events.emit({ type: "log", tool: "rclone", stream: "stdout", message: "Destination verified; deleting only committed source files" });
      for (const item of payload.items) {
        const source = joinTarget(sourceEndpoint.fs, joinRelative(payload.sourcePath, item.relPath));
        await this.#runRclone(["deletefile", source], signal);
        deleted += 1;
      }
    }

    await this.#purgeBestEffort(stageBase, signal, "empty staging");
    this.#events.emit({
      type: "summary",
      tool: "rclone",
      data: {
        operation: "managed-transfer",
        ruleId: payload.ruleId,
        mode: payload.mode,
        files: payload.items.length,
        bytes: totalBytes,
        verified: true,
        sourceFilesDeleted: deleted,
        transferAttempt: payload.transferAttempt,
      },
    });
    return { status: "completed" };
  }

  async #copyTo(
    source: string,
    destination: string,
    signal: AbortSignal,
    base: { completedBytes: number; completedFiles: number; totalBytes: number; totalFiles: number },
  ): Promise<void> {
    const args = [
      "copyto", source, destination,
      "--use-json-log",
      "--stats", "1s",
      "--stats-log-level", "NOTICE",
      "--stats-file-name-length", "0",
      ...(this.#config.tools.rcloneArgs ?? []),
    ];
    if (this.#config.tools.rcloneConfigPath) args.push("--config", this.#config.tools.rcloneConfigPath);
    const result = await this.#runner.run({ executable: this.#config.tools.rcloneBinary ?? "rclone", args }, signal, {
      stdout: (line) => this.#events.emit({ type: "log", tool: "rclone", stream: "stdout", message: compactLog(line) }),
      stderr: (line) => this.#handleStats(line, base),
    });
    if (result.exitCode !== 0) throw new ToolExitError("rclone", result);
  }

  #handleStats(line: string, base: { completedBytes: number; completedFiles: number; totalBytes: number; totalFiles: number }): void {
    const message = parseJson(line);
    const stats = isRecord(message?.stats) ? message.stats : null;
    if (!stats) {
      this.#events.emit({ type: "log", tool: "rclone", stream: "stderr", message: compactLog(line) });
      return;
    }
    const currentBytes = numberValue(stats.bytes) ?? 0;
    const currentFiles = numberValue(stats.transfers) ?? 0;
    this.#events.emit(progressEvent("rclone", {
      bytesDone: Math.min(base.totalBytes, base.completedBytes + currentBytes),
      bytesTotal: base.totalBytes,
      filesDone: Math.min(base.totalFiles, base.completedFiles + currentFiles),
      filesTotal: base.totalFiles,
      speedBytesPerSecond: numberValue(stats.speed),
      etaSeconds: nullableNumberValue(stats.eta),
      errors: numberValue(stats.errors),
    }));
  }

  async #verifySize(target: string, expected: number, signal: AbortSignal): Promise<void> {
    const result = await this.#runRclone(["lsjson", target, "--stat", "--no-mimetype"], signal, false);
    const value = parseJson(result.stdoutTail);
    const actual = numberValue(value?.Size ?? value?.size);
    if (actual === undefined) throw new Error("rclone verification did not return a file size");
    if (actual !== expected) throw new Error(`rclone size verification failed: expected ${expected} bytes, got ${actual}`);
  }

  async #runRclone(args: string[], signal: AbortSignal, log = true): Promise<CommandResult> {
    const fullArgs = [...args, ...(this.#config.tools.rcloneArgs ?? [])];
    if (this.#config.tools.rcloneConfigPath) fullArgs.push("--config", this.#config.tools.rcloneConfigPath);
    const result = await this.#runner.run({ executable: this.#config.tools.rcloneBinary ?? "rclone", args: fullArgs }, signal, log ? {
      stdout: (line) => this.#events.emit({ type: "log", tool: "rclone", stream: "stdout", message: compactLog(line) }),
      stderr: (line) => this.#events.emit({ type: "log", tool: "rclone", stream: "stderr", message: compactLog(line) }),
    } : {});
    if (result.exitCode !== 0) throw new ToolExitError("rclone", result);
    return result;
  }

  async #purgeBestEffort(target: string, signal: AbortSignal, label: string): Promise<void> {
    try {
      await this.#runRclone(["purge", target], signal, false);
    } catch (error) {
      this.#events.emit({ type: "log", tool: "rclone", stream: "stderr", message: `Could not clean ${label}; continuing safely (${error instanceof Error ? error.message : String(error)})` });
    }
  }
}

function parsePayload(value: unknown): ManagedTransferPayload {
  if (!isRecord(value)) throw new Error("managed transfer payload must be an object");
  const mode = value.mode;
  if (mode !== "copy" && mode !== "move") throw new Error("managed transfer mode must be copy or move");
  if (value.verification !== "size") throw new Error("managed transfer verification must be size");
  if (!Array.isArray(value.items) || value.items.length === 0 || value.items.length > 5000) throw new Error("managed transfer requires 1-5000 manifest items");
  const items = value.items.map(parseItem);
  const paths = new Set<string>();
  for (const item of items) {
    if (paths.has(item.relPath)) throw new Error(`duplicate managed transfer path: ${item.relPath}`);
    paths.add(item.relPath);
  }
  return {
    ruleId: requireId(value.ruleId, "ruleId"),
    sourceEndpointId: requireId(value.sourceEndpointId, "sourceEndpointId"),
    sourcePath: normalizeBase(value.sourcePath, "sourcePath"),
    destinationEndpointId: requireId(value.destinationEndpointId, "destinationEndpointId"),
    destinationPath: normalizeBase(value.destinationPath, "destinationPath"),
    mode,
    verification: "size",
    transferAttempt: positiveInteger(value.transferAttempt, "transferAttempt"),
    items,
  };
}
function parseItem(value: unknown): TransferItem { if (!isRecord(value)) throw new Error("managed transfer item must be an object"); const size = Number(value.size); if (!Number.isSafeInteger(size) || size < 0) throw new Error("managed transfer item size is invalid"); const modTime = typeof value.modTime === "string" && Number.isFinite(Date.parse(value.modTime)) ? new Date(value.modTime).toISOString() : (() => { throw new Error("managed transfer item modTime is invalid"); })(); return { relPath: normalizeObjectPath(value.relPath), size, modTime, objectKey: requireHex(value.objectKey, "objectKey") }; }
function joinTarget(base: string, relative: string): string { if (!relative) return base; if (base.endsWith(":") || base.endsWith("/")) return `${base}${relative}`; return `${base}/${relative}`; }
function joinRelative(...parts: string[]): string { return parts.filter(Boolean).map((part) => part.replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/"); }
function normalizeBase(value: unknown, name: string): string { if (value === undefined || value === null || value === "") return ""; if (typeof value !== "string") throw new Error(`${name} must be a string`); const normalized = value.trim().replaceAll("\\", "/").replace(/^\/+|\/+$/g, ""); if (!normalized) return ""; if (normalized.split("/").some((part) => !part || part === "." || part === "..")) throw new Error(`${name} may not contain dot segments`); return normalized; }
function normalizeObjectPath(value: unknown): string { if (typeof value !== "string") throw new Error("relPath must be a string"); const normalized = value.replaceAll("\\", "/").replace(/^\/+|\/+$/g, ""); if (!normalized || normalized.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("relPath must be a safe relative path"); return normalized; }
function requireId(value: unknown, name: string): string { if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value.trim())) throw new Error(`${name} is invalid`); return value.trim(); }
function requireHex(value: unknown, name: string): string { if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value)) throw new Error(`${name} must be a sha256 hex string`); return value.toLowerCase(); }
function positiveInteger(value: unknown, name: string): number { const number = Number(value); if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${name} must be a positive integer`); return number; }
function parseJson(value: string): Record<string, unknown> | null { try { const parsed = JSON.parse(value) as unknown; return isRecord(parsed) ? parsed : null; } catch { return null; } }
function compactLog(line: string): string { const parsed = parseJson(line); if (typeof parsed?.msg === "string") return parsed.msg; return line.length > 4000 ? `${line.slice(0, 4000)}…` : line; }
function numberValue(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined; }
function nullableNumberValue(value: unknown): number | null | undefined { return value === null ? null : numberValue(value); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
