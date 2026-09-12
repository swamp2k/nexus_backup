import type { BackupJob } from "@nexus-backup/core";
import type { ExecutionEventSink } from "./execution-events.js";
import { noopExecutionEventSink, progressEvent } from "./execution-events.js";
import type { JobExecutionResult, JobExecutor } from "./executor.js";
import type { CommandRunner } from "./process-runner.js";
import { ToolExitError } from "./process-runner.js";
import type { AgentRuntimeConfig } from "./runtime-config.js";

export interface RcloneTransferPayload {
  sourceEndpointId: string;
  destinationEndpointId: string;
  mode: "copy" | "move";
}

export class RcloneTransferExecutor implements JobExecutor {
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
    const source = this.#config.rcloneEndpoint(payload.sourceEndpointId);
    const destination = this.#config.rcloneEndpoint(payload.destinationEndpointId);
    if (source.fs === destination.fs) throw new Error("rclone source and destination must not resolve to the same filesystem");
    if (payload.mode === "move" && source.allowMove !== true) {
      throw new Error(`rclone move is not allowed for source endpoint: ${source.id}`);
    }
    const args = [
      payload.mode,
      source.fs,
      destination.fs,
      "--use-json-log",
      "--stats", "1s",
      "--stats-log-level", "NOTICE",
      "--stats-file-name-length", "0",
      ...(this.#config.tools.rcloneArgs ?? []),
    ];
    if (this.#config.tools.rcloneConfigPath) args.push("--config", this.#config.tools.rcloneConfigPath);

    const result = await this.#runner.run({
      executable: this.#config.tools.rcloneBinary ?? "rclone",
      args,
    }, signal, {
      stdout: (line) => this.#events.emit({ type: "log", tool: "rclone", stream: "stdout", message: line }),
      stderr: (line) => this.#handleLog(line),
    });

    if (result.exitCode !== 0) throw new ToolExitError("rclone", result);
    return { status: "completed" };
  }

  #handleLog(line: string): void {
    const message = parseJsonLine(line);
    if (!message) {
      this.#events.emit({ type: "log", tool: "rclone", stream: "stderr", message: line });
      return;
    }
    const stats = message.stats;
    if (typeof stats === "object" && stats !== null && !Array.isArray(stats)) {
      const record = stats as Record<string, unknown>;
      this.#events.emit(progressEvent("rclone", {
        bytesDone: numberValue(record.bytes),
        bytesTotal: numberValue(record.totalBytes),
        filesDone: numberValue(record.transfers),
        filesTotal: numberValue(record.totalTransfers),
        speedBytesPerSecond: numberValue(record.speed),
        etaSeconds: nullableNumberValue(record.eta),
        errors: numberValue(record.errors),
      }));
      return;
    }
    const msg = typeof message.msg === "string" ? message.msg : line;
    this.#events.emit({ type: "log", tool: "rclone", stream: "stderr", message: msg });
  }
}

function parsePayload(value: unknown): RcloneTransferPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("rclone transfer payload must be an object");
  const record = value as Record<string, unknown>;
  const sourceEndpointId = requireString(record.sourceEndpointId, "sourceEndpointId");
  const destinationEndpointId = requireString(record.destinationEndpointId, "destinationEndpointId");
  if (record.mode !== "copy" && record.mode !== "move") throw new Error("mode must be copy or move");
  return { sourceEndpointId, destinationEndpointId, mode: record.mode };
}

function parseJsonLine(line: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(line) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

function numberValue(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function nullableNumberValue(value: unknown): number | null | undefined { return value === null ? null : numberValue(value); }
function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}
