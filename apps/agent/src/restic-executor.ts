import type { BackupJob } from "@nexus-backup/core";
import type { ExecutionEventSink } from "./execution-events.js";
import { noopExecutionEventSink, progressEvent } from "./execution-events.js";
import type { JobExecutionResult, JobExecutor } from "./executor.js";
import type { CommandRunner } from "./process-runner.js";
import { ToolExitError } from "./process-runner.js";
import type { AgentRuntimeConfig } from "./runtime-config.js";

export interface ResticBackupPayload {
  sourceId: string;
  repositoryId: string;
  tags?: readonly string[];
}

export interface ResticBackupRequest {
  paths: readonly string[];
  repositoryId: string;
  tags?: readonly string[];
}

export class ResticBackupExecutor implements JobExecutor {
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
    const source = this.#config.source(payload.sourceId);
    return runResticBackup(
      this.#config,
      this.#runner,
      this.#events,
      {
        paths: source.paths,
        repositoryId: payload.repositoryId,
        ...(payload.tags === undefined ? {} : { tags: payload.tags }),
      },
      signal,
    );
  }
}

export async function runResticBackup(
  config: AgentRuntimeConfig,
  runner: CommandRunner,
  events: ExecutionEventSink,
  request: ResticBackupRequest,
  signal: AbortSignal,
): Promise<JobExecutionResult> {
  if (request.paths.length === 0) throw new Error("restic backup requires at least one local source path");
  const repository = config.resticRepository(request.repositoryId);
  const args = ["backup", "--json"];
  for (const tag of request.tags ?? []) args.push("--tag", tag);
  args.push("--", ...request.paths);

  const env: Record<string, string> = {
    ...(repository.environment ?? {}),
    RESTIC_REPOSITORY: repository.repository,
    RESTIC_PROGRESS_FPS: repository.environment?.RESTIC_PROGRESS_FPS ?? "1",
  };
  if (repository.passwordFile) env.RESTIC_PASSWORD_FILE = repository.passwordFile;

  const result = await runner.run({
    executable: config.tools.resticBinary ?? "restic",
    args,
    env,
  }, signal, {
    stdout: (line) => handleStdout(events, line),
    stderr: (line) => events.emit({ type: "log", tool: "restic", stream: "stderr", message: line }),
  });

  if (result.exitCode === 0) return { status: "completed" };
  if (result.exitCode === 3) {
    return { status: "partial", message: "Restic created an incomplete snapshot because some source files could not be read" };
  }
  throw new ToolExitError("restic", result);
}

function handleStdout(events: ExecutionEventSink, line: string): void {
  const message = parseJsonLine(line);
  if (!message) {
    events.emit({ type: "log", tool: "restic", stream: "stdout", message: line });
    return;
  }
  if (message.message_type === "status") {
    events.emit(progressEvent("restic", {
      bytesDone: numberValue(message.bytes_done),
      bytesTotal: numberValue(message.total_bytes),
      filesDone: numberValue(message.files_done),
      filesTotal: numberValue(message.total_files),
      etaSeconds: nullableNumberValue(message.seconds_remaining),
      errors: numberValue(message.error_count),
    }));
    return;
  }
  if (message.message_type === "summary") {
    events.emit({ type: "summary", tool: "restic", data: message });
    return;
  }
  if (message.message_type === "error") {
    events.emit({ type: "log", tool: "restic", stream: "stdout", message: jsonErrorMessage(message) });
  }
}

function parsePayload(value: unknown): ResticBackupPayload {
  const record = requireRecord(value, "restic backup payload");
  const sourceId = requireString(record.sourceId, "sourceId");
  const repositoryId = requireString(record.repositoryId, "repositoryId");
  const tags = parseTags(record.tags);
  return tags === undefined ? { sourceId, repositoryId } : { sourceId, repositoryId, tags };
}

export function parseResticTags(value: unknown): readonly string[] | undefined {
  return parseTags(value);
}

function parseTags(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((tag) => typeof tag !== "string" || !tag.trim())) {
    throw new Error("tags must be an array of non-empty strings");
  }
  return value.map((tag) => tag.trim());
}

function parseJsonLine(line: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(line) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

function jsonErrorMessage(message: Record<string, unknown>): string {
  const error = message.error;
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null && "message" in error && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  return "restic reported an error";
}

function numberValue(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function nullableNumberValue(value: unknown): number | null | undefined { return value === null ? null : numberValue(value); }
function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}
function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}
