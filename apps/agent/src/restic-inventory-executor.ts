import type { BackupJob } from "@nexus-backup/core";
import type { ExecutionEventSink } from "./execution-events.js";
import { noopExecutionEventSink } from "./execution-events.js";
import type { JobExecutionResult, JobExecutor } from "./executor.js";
import type { CommandRunner } from "./process-runner.js";
import { ToolExitError } from "./process-runner.js";
import type { AgentRuntimeConfig, LocalResticRepository } from "./runtime-config.js";

const MAX_SNAPSHOTS = 250;
const MAX_OUTPUT_CHARS = 2 * 1024 * 1024;

export interface ResticInventoryPayload {
  repositoryId: string;
}

export class ResticInventoryExecutor implements JobExecutor {
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
    const repository = this.#config.resticRepository(payload.repositoryId);
    const env = resticEnvironment(repository);

    this.#events.emit({
      type: "log",
      tool: "restic",
      stream: "stdout",
      message: `Scanning repository inventory: ${payload.repositoryId}`,
    });

    const snapshotsOutput = await this.#runJson(
      ["snapshots", "--json", "--latest", String(MAX_SNAPSHOTS), "--group-by", ""],
      env,
      signal,
    );
    const snapshotsValue = parseJson(snapshotsOutput, "restic snapshots");
    if (!Array.isArray(snapshotsValue)) throw new Error("restic snapshots JSON must be an array");
    const snapshots = snapshotsValue
      .map(normalizeSnapshot)
      .filter((snapshot): snapshot is RepositorySnapshot => snapshot !== null)
      .sort((left, right) => Date.parse(right.time) - Date.parse(left.time));

    const statsOutput = await this.#runJson(["stats", "--json", "--mode", "raw-data"], env, signal);
    const statsValue = parseJson(statsOutput, "restic stats");
    if (!isRecord(statsValue)) throw new Error("restic stats JSON must be an object");
    const stats = normalizeStats(statsValue);

    this.#events.emit({
      type: "inventory",
      tool: "restic",
      repositoryId: payload.repositoryId,
      stats,
      snapshots,
      snapshotLimit: MAX_SNAPSHOTS,
      truncated: stats.snapshotsCount !== null && stats.snapshotsCount > snapshots.length,
    });
    this.#events.emit({
      type: "log",
      tool: "restic",
      stream: "stdout",
      message: `Repository inventory complete: ${snapshots.length} snapshot${snapshots.length === 1 ? "" : "s"} loaded`,
    });
    return { status: "completed" };
  }

  async #runJson(args: readonly string[], env: Readonly<Record<string, string>>, signal: AbortSignal): Promise<string> {
    let output = "";
    let overflow = false;
    const result = await this.#runner.run({
      executable: this.#config.tools.resticBinary ?? "restic",
      args,
      env,
    }, signal, {
      stdout: (line) => {
        if (overflow) return;
        if (output.length + line.length + 1 > MAX_OUTPUT_CHARS) {
          overflow = true;
          return;
        }
        output += `${line}\n`;
      },
      stderr: (line) => {
        const message = line.trim();
        if (message) this.#events.emit({ type: "log", tool: "restic", stream: "stderr", message: message.slice(0, 12_000) });
      },
    });
    if (result.exitCode !== 0) throw new ToolExitError("restic", result);
    if (overflow) throw new Error(`restic inventory JSON exceeded ${MAX_OUTPUT_CHARS} characters`);
    return output.trim() || result.stdoutTail.trim();
  }
}

interface RepositorySnapshot {
  id: string;
  shortId: string | null;
  time: string;
  parent: string | null;
  hostname: string | null;
  username: string | null;
  paths: string[];
  tags: string[];
  programVersion: string | null;
  totalFilesProcessed: number | null;
  totalBytesProcessed: number | null;
  dataAdded: number | null;
  dataAddedPacked: number | null;
}

function normalizeSnapshot(value: unknown): RepositorySnapshot | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.time !== "string") return null;
  if (!Number.isFinite(Date.parse(value.time))) return null;
  const summary = isRecord(value.summary) ? value.summary : {};
  return {
    id: value.id,
    shortId: optionalString(value.short_id),
    time: new Date(value.time).toISOString(),
    parent: optionalString(value.parent),
    hostname: optionalString(value.hostname),
    username: optionalString(value.username),
    paths: stringArray(value.paths, 64, 4_096),
    tags: stringArray(value.tags, 64, 256),
    programVersion: optionalString(value.program_version),
    totalFilesProcessed: optionalNonNegativeInteger(summary.total_files_processed),
    totalBytesProcessed: optionalNonNegativeNumber(summary.total_bytes_processed),
    dataAdded: optionalNonNegativeNumber(summary.data_added),
    dataAddedPacked: optionalNonNegativeNumber(summary.data_added_packed),
  };
}

function normalizeStats(value: Record<string, unknown>) {
  return {
    totalSize: optionalNonNegativeNumber(value.total_size),
    totalFileCount: optionalNonNegativeInteger(value.total_file_count),
    totalBlobCount: optionalNonNegativeInteger(value.total_blob_count),
    snapshotsCount: optionalNonNegativeInteger(value.snapshots_count),
    totalUncompressedSize: optionalNonNegativeNumber(value.total_uncompressed_size),
    compressionRatio: optionalNonNegativeNumber(value.compression_ratio),
    compressionProgress: optionalNonNegativeNumber(value.compression_progress),
    compressionSpaceSaving: optionalNumber(value.compression_space_saving),
  };
}

function resticEnvironment(repository: LocalResticRepository): Record<string, string> {
  const env: Record<string, string> = {
    ...(repository.environment ?? {}),
    RESTIC_REPOSITORY: repository.repository,
  };
  if (repository.passwordFile) env.RESTIC_PASSWORD_FILE = repository.passwordFile;
  return env;
}

function parsePayload(value: unknown): ResticInventoryPayload {
  if (!isRecord(value)) throw new Error("restic inventory payload must be an object");
  return { repositoryId: requireString(value.repositoryId, "repositoryId") };
}

function parseJson(value: string, source: string): unknown {
  try { return JSON.parse(value); } catch (error) { throw new Error(`${source} returned invalid JSON`, { cause: error }); }
}

function stringArray(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, maxItems).filter((item): item is string => typeof item === "string").map((item) => item.slice(0, maxLength));
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function optionalNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function optionalNonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
