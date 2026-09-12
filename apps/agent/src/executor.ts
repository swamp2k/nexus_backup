import type { BackupJob } from "@nexus-backup/core";

export interface JobExecutionResult {
  status: "completed" | "partial";
  message?: string;
}

export interface JobExecutor {
  execute(job: BackupJob, signal: AbortSignal): Promise<JobExecutionResult>;
}
