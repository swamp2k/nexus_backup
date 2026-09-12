import type { BackupJob, CreateJobInput, JobEvent, JobLease } from "./types.js";

export interface JobRepository {
  create<TPayload>(input: CreateJobInput<TPayload>, now: Date): Promise<BackupJob<TPayload>>;
  get<TPayload = unknown>(jobId: string): Promise<BackupJob<TPayload> | null>;
  getByOperationKey<TPayload = unknown>(operationKey: string): Promise<BackupJob<TPayload> | null>;
  save<TPayload>(job: BackupJob<TPayload>): Promise<void>;

  /**
   * Must be atomic in persistent implementations. It may only set the lease when
   * the job is in an acquirable state and no non-expired lease is owned by another agent.
   */
  tryAcquireLease(jobId: string, lease: JobLease, now: Date): Promise<BackupJob | null>;

  listExpiredLeases(now: Date, limit: number): Promise<BackupJob[]>;
  appendEvent(event: JobEvent): Promise<void>;
  listEvents(jobId: string): Promise<JobEvent[]>;
}
