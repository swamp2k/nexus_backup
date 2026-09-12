import type { BackupJob } from "@nexus-backup/core";
import type { JobExecutionResult, JobExecutor } from "./executor.js";

export class CompositeJobExecutor implements JobExecutor {
  readonly #executors: ReadonlyMap<string, JobExecutor>;

  constructor(executors: Readonly<Record<string, JobExecutor>>) {
    this.#executors = new Map(Object.entries(executors));
  }

  async execute(job: BackupJob, signal: AbortSignal): Promise<JobExecutionResult> {
    const executor = this.#executors.get(job.type);
    if (!executor) throw new Error(`No executor registered for job type: ${job.type}`);
    return executor.execute(job, signal);
  }
}
