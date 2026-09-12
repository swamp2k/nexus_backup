import type { BackupJob, CreateJobInput, JobEvent, JobEventDraft, JobLease } from "./types.js";

export interface JobRepository {
  /** Create the job and its creation event atomically. */
  create<TPayload>(input: CreateJobInput<TPayload>, now: Date, event: JobEventDraft): Promise<BackupJob<TPayload>>;
  get<TPayload = unknown>(jobId: string): Promise<BackupJob<TPayload> | null>;
  getByOperationKey<TPayload = unknown>(operationKey: string): Promise<BackupJob<TPayload> | null>;

  /** Compare-and-swap a job mutation and its event atomically. */
  save<TPayload>(job: BackupJob<TPayload>, expectedRevision: number, event: JobEventDraft): Promise<BackupJob<TPayload> | null>;

  /** Atomically acquire a specific job, increment revision, and persist the lease event. */
  tryAcquireLease(jobId: string, lease: JobLease, now: Date, event: JobEventDraft): Promise<BackupJob | null>;

  /** Atomically select/acquire at most one job and persist the lease event. */
  tryAcquireNextLease(lease: JobLease, now: Date, event: JobEventDraft): Promise<BackupJob | null>;

  listExpiredLeases(now: Date, limit: number): Promise<BackupJob[]>;
  appendEvent(event: JobEvent): Promise<void>;
  listEvents(jobId: string): Promise<JobEvent[]>;
}
