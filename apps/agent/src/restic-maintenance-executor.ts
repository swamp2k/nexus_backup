import type { BackupJob } from "@nexus-backup/core";
import type { ExecutionEventSink } from "./execution-events.js";
import { noopExecutionEventSink } from "./execution-events.js";
import type { JobExecutionResult, JobExecutor } from "./executor.js";
import type { CommandRunner } from "./process-runner.js";
import { ToolExitError } from "./process-runner.js";
import type { AgentRuntimeConfig } from "./runtime-config.js";

export interface ResticMaintenancePayload {
  repositoryId: string;
  planTag: string;
  retention: {
    keepDaily: number;
    keepWeekly: number;
    keepMonthly: number;
  };
  sourceJobId?: string;
}

export class ResticMaintenanceExecutor implements JobExecutor {
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
    const args = ["forget", "--json", "--tag", payload.planTag, "--group-by", ""];
    if (payload.retention.keepDaily > 0) args.push("--keep-daily", String(payload.retention.keepDaily));
    if (payload.retention.keepWeekly > 0) args.push("--keep-weekly", String(payload.retention.keepWeekly));
    if (payload.retention.keepMonthly > 0) args.push("--keep-monthly", String(payload.retention.keepMonthly));
    args.push("--prune");

    const env: Record<string, string> = {
      ...(repository.environment ?? {}),
      RESTIC_REPOSITORY: repository.repository,
    };
    if (repository.passwordFile) env.RESTIC_PASSWORD_FILE = repository.passwordFile;

    this.#events.emit({
      type: "log",
      tool: "restic",
      stream: "stdout",
      message: `Applying retention to ${payload.planTag}: ${payload.retention.keepDaily} daily / ${payload.retention.keepWeekly} weekly / ${payload.retention.keepMonthly} monthly`,
    });

    const result = await this.#runner.run({
      executable: this.#config.tools.resticBinary ?? "restic",
      args,
      env,
    }, signal, {
      stdout: (line) => this.#handleOutput(line, "stdout"),
      stderr: (line) => this.#handleOutput(line, "stderr"),
    });

    if (result.exitCode !== 0) throw new ToolExitError("restic", result);
    this.#events.emit({
      type: "summary",
      tool: "restic",
      data: {
        operation: "retention-maintenance",
        repositoryId: payload.repositoryId,
        planTag: payload.planTag,
        retention: payload.retention,
        ...(payload.sourceJobId === undefined ? {} : { sourceJobId: payload.sourceJobId }),
      },
    });
    return { status: "completed" };
  }

  #handleOutput(line: string, stream: "stdout" | "stderr"): void {
    const compact = summarizeJson(line);
    if (compact) {
      this.#events.emit({ type: "log", tool: "restic", stream, message: compact });
      return;
    }
    const message = line.length > 12_000 ? `${line.slice(0, 12_000)}…` : line;
    if (message.trim()) this.#events.emit({ type: "log", tool: "restic", stream, message });
  }
}

function parsePayload(value: unknown): ResticMaintenancePayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("restic maintenance payload must be an object");
  const record = value as Record<string, unknown>;
  const repositoryId = requireString(record.repositoryId, "repositoryId");
  const planTag = requireString(record.planTag, "planTag");
  if (!/^nexus-plan:[A-Za-z0-9._-]+$/.test(planTag)) throw new Error("planTag must be an internal nexus-plan tag");
  if (typeof record.retention !== "object" || record.retention === null || Array.isArray(record.retention)) {
    throw new Error("retention must be an object");
  }
  const retentionRecord = record.retention as Record<string, unknown>;
  const retention = {
    keepDaily: retentionCount(retentionRecord.keepDaily, "keepDaily"),
    keepWeekly: retentionCount(retentionRecord.keepWeekly, "keepWeekly"),
    keepMonthly: retentionCount(retentionRecord.keepMonthly, "keepMonthly"),
  };
  if (retention.keepDaily === 0 && retention.keepWeekly === 0 && retention.keepMonthly === 0) {
    throw new Error("retention policy must keep at least one snapshot interval");
  }
  const sourceJobId = record.sourceJobId === undefined ? undefined : requireString(record.sourceJobId, "sourceJobId");
  return { repositoryId, planTag, retention, ...(sourceJobId === undefined ? {} : { sourceJobId }) };
}

function summarizeJson(line: string): string | null {
  try {
    const value = JSON.parse(line) as unknown;
    if (Array.isArray(value)) {
      let kept = 0;
      let removed = 0;
      for (const item of value) {
        if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
        const record = item as Record<string, unknown>;
        if (Array.isArray(record.keep)) kept += record.keep.length;
        if (Array.isArray(record.remove)) removed += record.remove.length;
      }
      return `Retention decision: keep ${kept} snapshot${kept === 1 ? "" : "s"}, remove ${removed}`;
    }
    if (typeof value === "object" && value !== null) {
      const record = value as Record<string, unknown>;
      const message = typeof record.message === "string" ? record.message : typeof record.message_type === "string" ? record.message_type : null;
      return message ? `restic: ${message}` : null;
    }
  } catch {}
  return null;
}

function retentionCount(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 3650) {
    throw new Error(`${name} must be an integer between 0 and 3650`);
  }
  return value;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}
