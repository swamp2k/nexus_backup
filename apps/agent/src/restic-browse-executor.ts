import type { BackupJob } from "@nexus-backup/core";
import type { ExecutionEventSink, RepositorySnapshotBrowseEntryEvent } from "./execution-events.js";
import { noopExecutionEventSink } from "./execution-events.js";
import type { JobExecutionResult, JobExecutor } from "./executor.js";
import type { CommandRunner } from "./process-runner.js";
import { ToolExitError } from "./process-runner.js";
import type { AgentRuntimeConfig, LocalResticRepository } from "./runtime-config.js";

const MAX_ENTRIES = 1000;

export interface ResticBrowsePayload {
  repositoryId: string;
  snapshotId: string;
  path: string;
}

export class ResticBrowseExecutor implements JobExecutor {
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
    const entries: RepositorySnapshotBrowseEntryEvent[] = [];
    let seenEntries = 0;

    this.#events.emit({
      type: "log",
      tool: "restic",
      stream: "stdout",
      message: `Browsing snapshot ${payload.snapshotId.slice(0, 8)}`,
    });

    const result = await this.#runner.run({
      executable: this.#config.tools.resticBinary ?? "restic",
      args: ["ls", "--json", payload.snapshotId, payload.path],
      env: resticEnvironment(repository),
    }, signal, {
      stdout: (line) => {
        const entry = parseNodeLine(line);
        if (!entry) return;
        seenEntries += 1;
        if (entries.length < MAX_ENTRIES) entries.push(entry);
      },
      stderr: (line) => {
        const message = line.trim();
        if (message) this.#events.emit({ type: "log", tool: "restic", stream: "stderr", message: message.slice(0, 12_000) });
      },
    });

    if (result.exitCode !== 0) throw new ToolExitError("restic", result);

    entries.sort((left, right) => {
      const leftDirectory = left.nodeType === "dir" ? 0 : 1;
      const rightDirectory = right.nodeType === "dir" ? 0 : 1;
      return leftDirectory - rightDirectory || left.name.localeCompare(right.name) || left.path.localeCompare(right.path);
    });

    this.#events.emit({
      type: "snapshot-browse",
      tool: "restic",
      repositoryId: payload.repositoryId,
      snapshotId: payload.snapshotId,
      path: payload.path,
      entries,
      entryLimit: MAX_ENTRIES,
      truncated: seenEntries > entries.length,
    });
    this.#events.emit({
      type: "log",
      tool: "restic",
      stream: "stdout",
      message: `Snapshot browse complete: ${entries.length}${seenEntries > entries.length ? "+" : ""} entries`,
    });
    return { status: "completed" };
  }
}

function parsePayload(value: unknown): ResticBrowsePayload {
  if (!isRecord(value)) throw new Error("restic browse payload must be an object");
  return {
    repositoryId: requireString(value.repositoryId, "repositoryId", 1, 128),
    snapshotId: requireSnapshotId(value.snapshotId),
    path: requireSnapshotPath(value.path),
  };
}

function parseNodeLine(line: string): RepositorySnapshotBrowseEntryEvent | null {
  let value: unknown;
  try { value = JSON.parse(line); } catch { return null; }
  if (!isRecord(value)) return null;
  const messageType = value.message_type ?? value.struct_type;
  if (messageType !== "node") return null;
  if (typeof value.path !== "string" || !value.path.startsWith("/")) return null;
  const path = value.path.slice(0, 4096);
  const fallbackName = path === "/" ? "/" : path.split("/").filter(Boolean).at(-1) ?? path;
  const name = typeof value.name === "string" && value.name ? value.name.slice(0, 1024) : fallbackName.slice(0, 1024);
  const nodeType = typeof value.type === "string" && value.type ? value.type.slice(0, 64) : "other";
  return {
    path,
    name,
    nodeType,
    size: nonNegativeNumberOrNull(value.size),
    mtime: validDateOrNull(value.mtime),
    permissions: typeof value.permissions === "string" ? value.permissions.slice(0, 64) : null,
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

function requireSnapshotId(value: unknown): string {
  const id = requireString(value, "snapshotId", 8, 64);
  if (!/^[A-Fa-f0-9]{8,64}$/.test(id)) throw new Error("snapshotId must be a hexadecimal Restic snapshot id");
  return id;
}

function requireSnapshotPath(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 4096) throw new Error("path must be 1-4096 characters");
  const path = value;
  if (!path.startsWith("/")) throw new Error("snapshot path must be absolute");
  if (path.includes("\0")) throw new Error("snapshot path contains an invalid character");
  if (path.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new Error("snapshot path may not contain dot segments");
  }
  return path.length > 1 ? path.replace(/\/+$/, "") || "/" : "/";
}

function validDateOrNull(value: unknown): string | null {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function nonNegativeNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function requireString(value: unknown, name: string, min: number, max: number): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const normalized = value.trim();
  if (normalized.length < min || normalized.length > max) throw new Error(`${name} must be ${min}-${max} characters`);
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
