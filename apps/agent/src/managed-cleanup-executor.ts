import type { BackupJob } from "@nexus-backup/core";
import type { ExecutionEventSink } from "./execution-events.js";
import { noopExecutionEventSink } from "./execution-events.js";
import type { JobExecutionResult, JobExecutor } from "./executor.js";
import type { CommandRunner, CommandResult } from "./process-runner.js";
import { ToolExitError } from "./process-runner.js";
import type { AgentRuntimeConfig } from "./runtime-config.js";

interface CleanupPayload {
  ruleId: string;
  destinationEndpointId: string;
  destinationPath: string;
  relPath: string;
  expectedSize: number;
  objectKey: string;
  cleanupAttempt: number;
}

export class ManagedCleanupExecutor implements JobExecutor {
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
    const endpoint = this.#config.rcloneEndpoint(payload.destinationEndpointId);
    const target = joinTarget(endpoint.fs, joinRelative(payload.destinationPath, payload.relPath));

    this.#events.emit({ type: "log", tool: "rclone", stream: "stdout", message: `Checking cleanup provenance for ${payload.relPath}` });
    const stat = await this.#runRclone(["lsjson", target, "--stat", "--no-mimetype"], signal, false);
    const value = parseJson(stat.stdoutTail);
    const actual = numberValue(value?.Size ?? value?.size);
    if (actual === undefined) throw new Error("cleanup provenance check did not return a file size");
    if (actual !== payload.expectedSize) {
      throw new Error(`cleanup refused modified destination: expected ${payload.expectedSize} bytes, got ${actual}`);
    }

    await this.#runRclone(["deletefile", target], signal);
    this.#events.emit({
      type: "summary",
      tool: "rclone",
      data: {
        operation: "managed-cleanup",
        ruleId: payload.ruleId,
        objectKey: payload.objectKey,
        relPath: payload.relPath,
        expectedSize: payload.expectedSize,
        cleanupAttempt: payload.cleanupAttempt,
        deleted: true,
      },
    });
    return { status: "completed" };
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
}

function parsePayload(value: unknown): CleanupPayload {
  if (!isRecord(value)) throw new Error("managed cleanup payload must be an object");
  const expectedSize = Number(value.expectedSize);
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0) throw new Error("expectedSize must be a non-negative integer");
  return {
    ruleId: requireId(value.ruleId, "ruleId"),
    destinationEndpointId: requireId(value.destinationEndpointId, "destinationEndpointId"),
    destinationPath: normalizeBase(value.destinationPath, "destinationPath"),
    relPath: normalizeObjectPath(value.relPath),
    expectedSize,
    objectKey: requireHex(value.objectKey, "objectKey"),
    cleanupAttempt: positiveInteger(value.cleanupAttempt, "cleanupAttempt"),
  };
}
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
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
