import type { BackupJob } from "@nexus-backup/core";
import type { ExecutionEventSink } from "./execution-events.js";
import { noopExecutionEventSink } from "./execution-events.js";
import type { JobExecutionResult, JobExecutor } from "./executor.js";
import type { CommandRunner } from "./process-runner.js";
import { ToolExitError } from "./process-runner.js";
import type { AgentRuntimeConfig } from "./runtime-config.js";

export interface ResticCheckPayload {
  repositoryId: string;
}

export class ResticCheckExecutor implements JobExecutor {
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
    const env: Record<string, string> = {
      ...(repository.environment ?? {}),
      RESTIC_REPOSITORY: repository.repository,
    };
    if (repository.passwordFile) env.RESTIC_PASSWORD_FILE = repository.passwordFile;

    this.#events.emit({
      type: "log",
      tool: "restic",
      stream: "stdout",
      message: `Checking repository integrity: ${payload.repositoryId}`,
    });

    const result = await this.#runner.run({
      executable: this.#config.tools.resticBinary ?? "restic",
      args: ["check"],
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
        operation: "repository-check",
        repositoryId: payload.repositoryId,
        integrity: "ok",
      },
    });
    return { status: "completed", message: "Repository integrity check passed" };
  }

  #handleOutput(line: string, stream: "stdout" | "stderr"): void {
    const message = line.length > 12_000 ? `${line.slice(0, 12_000)}…` : line;
    if (message.trim()) this.#events.emit({ type: "log", tool: "restic", stream, message });
  }
}

function parsePayload(value: unknown): ResticCheckPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("restic check payload must be an object");
  }
  const repositoryId = (value as Record<string, unknown>).repositoryId;
  if (typeof repositoryId !== "string" || !repositoryId.trim() || repositoryId.length > 128) {
    throw new Error("repositoryId must be a non-empty string");
  }
  return { repositoryId: repositoryId.trim() };
}
