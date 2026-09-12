import type { BackupJob } from "@nexus-backup/core";
import type { ExecutionEventSink } from "./execution-events.js";
import { noopExecutionEventSink } from "./execution-events.js";
import type { JobExecutionResult, JobExecutor } from "./executor.js";
import type { CommandRunner } from "./process-runner.js";
import { RcloneMountManager } from "./rclone-mount-manager.js";
import { parseResticTags, runResticBackup } from "./restic-executor.js";
import type { AgentRuntimeConfig } from "./runtime-config.js";

export interface RcloneMountedResticPayload {
  sourceEndpointId: string;
  repositoryId: string;
  tags?: readonly string[];
}

export class RcloneMountedResticExecutor implements JobExecutor {
  readonly #config: AgentRuntimeConfig;
  readonly #runner: CommandRunner;
  readonly #events: ExecutionEventSink;
  readonly #mounts: RcloneMountManager;

  constructor(
    config: AgentRuntimeConfig,
    runner: CommandRunner,
    events: ExecutionEventSink = noopExecutionEventSink,
    mounts: RcloneMountManager = new RcloneMountManager(config, runner, events),
  ) {
    this.#config = config;
    this.#runner = runner;
    this.#events = events;
    this.#mounts = mounts;
  }

  async execute(job: BackupJob, signal: AbortSignal): Promise<JobExecutionResult> {
    const payload = parsePayload(job.payload);
    const mounted = await this.#mounts.mount(payload.sourceEndpointId, signal);

    let result: JobExecutionResult | undefined;
    let executionError: unknown;
    try {
      result = await runResticBackup(
        this.#config,
        this.#runner,
        this.#events,
        {
          paths: [mounted.mountPoint],
          repositoryId: payload.repositoryId,
          ...(payload.tags === undefined ? {} : { tags: payload.tags }),
        },
        signal,
      );
    } catch (error) {
      executionError = error;
    }

    let cleanupError: unknown;
    try {
      await mounted.release();
    } catch (error) {
      cleanupError = error;
    }

    if (executionError !== undefined && cleanupError !== undefined) {
      throw new AggregateError(
        [executionError, cleanupError],
        `Remote backup ${job.id} failed and its rclone mount could not be released`,
      );
    }
    if (executionError !== undefined) throw executionError;
    if (cleanupError !== undefined) throw cleanupError;
    if (result === undefined) throw new Error(`Remote backup ${job.id} finished without a result`);
    return result;
  }
}

function parsePayload(value: unknown): RcloneMountedResticPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("rclone mounted restic payload must be an object");
  }
  const record = value as Record<string, unknown>;
  const sourceEndpointId = requireString(record.sourceEndpointId, "sourceEndpointId");
  const repositoryId = requireString(record.repositoryId, "repositoryId");
  const tags = parseResticTags(record.tags);
  return tags === undefined ? { sourceEndpointId, repositoryId } : { sourceEndpointId, repositoryId, tags };
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}
