import type { BackupJob } from "@nexus-backup/core";
import type { ExecutionEventSink } from "./execution-events.js";
import { noopExecutionEventSink } from "./execution-events.js";
import type { JobExecutionResult, JobExecutor } from "./executor.js";
import type { CommandRunner } from "./process-runner.js";
import { ToolExitError } from "./process-runner.js";
import type { AgentRuntimeConfig, LocalResticRepository } from "./runtime-config.js";

const MAX_CHANGED_LOGS = 400;

export interface ResticRestorePreviewPayload {
  repositoryId: string;
  snapshotId: string;
  targetId: string;
  path?: string;
}

export class ResticRestorePreviewExecutor implements JobExecutor {
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
    const target = this.#config.restoreTarget(payload.targetId);
    const overwrite = target.overwrite ?? "never";
    const args = [
      "restore",
      payload.snapshotId,
      "--target",
      target.path,
      "--dry-run",
      "--verbose=2",
      "--overwrite",
      overwrite,
    ];
    if (payload.path && payload.path !== "/") args.push("--include", payload.path);

    let restored = 0;
    let updated = 0;
    let unchanged = 0;
    let changedLogs = 0;
    let changedLogsTruncated = false;

    this.#events.emit({
      type: "log",
      tool: "restic",
      stream: "stdout",
      message: `Restore preview started: snapshot ${payload.snapshotId.slice(0, 8)} → target ${payload.targetId}`,
    });

    const result = await this.#runner.run({
      executable: this.#config.tools.resticBinary ?? "restic",
      args,
      env: resticEnvironment(repository),
    }, signal, {
      stdout: (line) => {
        const action = restoreAction(line);
        if (action === "restored") restored += 1;
        else if (action === "updated") updated += 1;
        else if (action === "unchanged") unchanged += 1;

        if (action === "restored" || action === "updated") {
          if (changedLogs < MAX_CHANGED_LOGS) {
            this.#events.emit({ type: "log", tool: "restic", stream: "stdout", message: line.slice(0, 12_000) });
            changedLogs += 1;
          } else {
            changedLogsTruncated = true;
          }
          return;
        }

        if (/^Summary:/i.test(line.trim())) {
          this.#events.emit({ type: "log", tool: "restic", stream: "stdout", message: line.slice(0, 12_000) });
        }
      },
      stderr: (line) => {
        const message = line.trim();
        if (message) this.#events.emit({ type: "log", tool: "restic", stream: "stderr", message: message.slice(0, 12_000) });
      },
    });

    if (result.exitCode !== 0) throw new ToolExitError("restic", result);

    this.#events.emit({
      type: "summary",
      tool: "restic",
      data: {
        operation: "restore-preview",
        repositoryId: payload.repositoryId,
        snapshotId: payload.snapshotId,
        targetId: payload.targetId,
        ...(payload.path ? { path: payload.path } : {}),
        overwrite,
        dryRun: true,
        restored,
        updated,
        unchanged,
        changedLogsTruncated,
      },
    });
    this.#events.emit({
      type: "log",
      tool: "restic",
      stream: "stdout",
      message: `Restore preview complete: ${restored} new · ${updated} updated · ${unchanged} unchanged${changedLogsTruncated ? " · changed-file log truncated" : ""}`,
    });
    return { status: "completed" };
  }
}

function parsePayload(value: unknown): ResticRestorePreviewPayload {
  if (!isRecord(value)) throw new Error("restore preview payload must be an object");
  const path = value.path === undefined || value.path === null ? undefined : requireSnapshotPath(value.path);
  return {
    repositoryId: requireString(value.repositoryId, "repositoryId", 1, 128),
    snapshotId: requireSnapshotId(value.snapshotId),
    targetId: requireString(value.targetId, "targetId", 1, 128),
    ...(path === undefined ? {} : { path }),
  };
}

function restoreAction(line: string): "restored" | "updated" | "unchanged" | null {
  const raw = line.trimStart().match(/^(restored|updated|unchanged)\s+/i)?.[1];
  if (!raw) return null;
  const action = raw.toLowerCase();
  return action === "restored" || action === "updated" || action === "unchanged" ? action : null;
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

function requireString(value: unknown, name: string, min: number, max: number): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const normalized = value.trim();
  if (normalized.length < min || normalized.length > max) throw new Error(`${name} must be ${min}-${max} characters`);
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
