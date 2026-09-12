import { InvalidJobTransitionError } from "./errors.js";
import type { BackupJob, JobState } from "./types.js";

const transitions: Readonly<Record<JobState, readonly JobState[]>> = {
  queued: ["leased", "cancelled"],
  leased: ["preparing", "running", "interrupted", "cancelled"],
  preparing: ["running", "failed", "partial", "interrupted", "cancelled"],
  running: ["finalizing", "completed", "partial", "failed", "interrupted", "cancelled"],
  finalizing: ["completed", "partial", "failed", "interrupted"],
  completed: [],
  partial: [],
  failed: [],
  cancelled: [],
  interrupted: ["queued", "leased", "failed", "cancelled"],
};

export function canTransition(from: JobState, to: JobState): boolean {
  return transitions[from].includes(to);
}

export function assertTransition(from: JobState, to: JobState): void {
  if (from === to) return;
  if (!canTransition(from, to)) throw new InvalidJobTransitionError(`Invalid job transition: ${from} -> ${to}`);
}

export function transitionJob<TPayload>(job: BackupJob<TPayload>, to: JobState, now: Date, error: string | null = null): BackupJob<TPayload> {
  assertTransition(job.state, to);
  if (job.state === to) return job;
  const terminal = to === "completed" || to === "partial" || to === "failed" || to === "cancelled";
  const releaseLease = terminal || to === "interrupted";
  const startedAt = job.startedAt ?? (to === "preparing" || to === "running" || to === "finalizing" ? now.toISOString() : null);
  return {
    ...job,
    state: to,
    updatedAt: now.toISOString(),
    startedAt,
    finishedAt: terminal ? now.toISOString() : null,
    lastError: error,
    lease: releaseLease ? null : job.lease,
  };
}
