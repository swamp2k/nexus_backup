import { DuplicateOperationError } from "./errors.js";
import { isLeaseExpired } from "./lease.js";
import type { JobRepository } from "./repository.js";
import type { BackupJob, CreateJobInput, JobEvent, JobLease } from "./types.js";

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class MemoryJobRepository implements JobRepository {
  readonly #jobs = new Map<string, BackupJob>();
  readonly #operationKeys = new Map<string, string>();
  readonly #events = new Map<string, JobEvent[]>();

  async create<TPayload>(input: CreateJobInput<TPayload>, now: Date): Promise<BackupJob<TPayload>> {
    if (this.#operationKeys.has(input.operationKey)) {
      throw new DuplicateOperationError(`Operation key already exists: ${input.operationKey}`);
    }

    const iso = now.toISOString();
    const job: BackupJob<TPayload> = {
      id: input.id,
      operationKey: input.operationKey,
      type: input.type,
      state: "queued",
      attempt: 0,
      payload: input.payload,
      lease: null,
      createdAt: iso,
      updatedAt: iso,
      startedAt: null,
      finishedAt: null,
      lastError: null,
    };

    this.#jobs.set(job.id, clone(job as BackupJob));
    this.#operationKeys.set(job.operationKey, job.id);
    return clone(job);
  }

  async get<TPayload = unknown>(jobId: string): Promise<BackupJob<TPayload> | null> {
    const job = this.#jobs.get(jobId);
    return job ? (clone(job) as BackupJob<TPayload>) : null;
  }

  async getByOperationKey<TPayload = unknown>(operationKey: string): Promise<BackupJob<TPayload> | null> {
    const id = this.#operationKeys.get(operationKey);
    return id ? this.get<TPayload>(id) : null;
  }

  async save<TPayload>(job: BackupJob<TPayload>): Promise<void> {
    this.#jobs.set(job.id, clone(job as BackupJob));
  }

  async tryAcquireLease(jobId: string, lease: JobLease, now: Date): Promise<BackupJob | null> {
    const job = this.#jobs.get(jobId);
    if (!job) return null;

    const acquirableState = job.state === "queued" || job.state === "interrupted";
    if (!acquirableState) return null;

    if (job.lease && !isLeaseExpired(job.lease, now) && job.lease.agentId !== lease.agentId) {
      return null;
    }

    const next: BackupJob = {
      ...job,
      state: "leased",
      attempt: job.attempt + 1,
      lease,
      updatedAt: now.toISOString(),
      finishedAt: null,
      lastError: null,
    };
    this.#jobs.set(jobId, clone(next));
    return clone(next);
  }

  async listExpiredLeases(now: Date, limit: number): Promise<BackupJob[]> {
    const expired: BackupJob[] = [];
    for (const job of this.#jobs.values()) {
      if (expired.length >= limit) break;
      if (job.lease && isLeaseExpired(job.lease, now) && !["completed", "partial", "failed", "cancelled"].includes(job.state)) {
        expired.push(clone(job));
      }
    }
    return expired;
  }

  async appendEvent(event: JobEvent): Promise<void> {
    const events = this.#events.get(event.jobId) ?? [];
    events.push(clone(event));
    this.#events.set(event.jobId, events);
  }

  async listEvents(jobId: string): Promise<JobEvent[]> {
    return clone(this.#events.get(jobId) ?? []);
  }
}
