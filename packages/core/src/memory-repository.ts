import { DuplicateOperationError } from "./errors.js";
import { isLeaseExpired } from "./lease.js";
import type { JobRepository } from "./repository.js";
import type { BackupJob, CreateJobInput, JobEvent, JobEventDraft, JobLease } from "./types.js";

function clone<T>(value: T): T { return structuredClone(value); }

export class MemoryJobRepository implements JobRepository {
  readonly #jobs = new Map<string, BackupJob>();
  readonly #operationKeys = new Map<string, string>();
  readonly #events = new Map<string, JobEvent[]>();

  async create<TPayload>(input: CreateJobInput<TPayload>, now: Date, event: JobEventDraft): Promise<BackupJob<TPayload>> {
    if (this.#operationKeys.has(input.operationKey)) throw new DuplicateOperationError(`Operation key already exists: ${input.operationKey}`);
    const iso = now.toISOString();
    const job: BackupJob<TPayload> = {
      id: input.id, operationKey: input.operationKey, type: input.type, state: "queued",
      attempt: 0, revision: 0, payload: input.payload, lease: null,
      createdAt: iso, updatedAt: iso, startedAt: null, finishedAt: null, lastError: null,
    };
    this.#jobs.set(job.id, clone(job as BackupJob));
    this.#operationKeys.set(job.operationKey, job.id);
    this.#appendDraft(job.id, event);
    return clone(job);
  }

  async get<TPayload = unknown>(jobId: string): Promise<BackupJob<TPayload> | null> {
    const job = this.#jobs.get(jobId);
    return job ? clone(job) as BackupJob<TPayload> : null;
  }

  async getByOperationKey<TPayload = unknown>(operationKey: string): Promise<BackupJob<TPayload> | null> {
    const id = this.#operationKeys.get(operationKey);
    return id ? this.get<TPayload>(id) : null;
  }

  async save<TPayload>(job: BackupJob<TPayload>, expectedRevision: number, event: JobEventDraft): Promise<BackupJob<TPayload> | null> {
    const current = this.#jobs.get(job.id);
    if (!current || current.revision !== expectedRevision) return null;
    const next = { ...job, revision: expectedRevision + 1 };
    this.#jobs.set(job.id, clone(next as BackupJob));
    this.#appendDraft(job.id, event);
    return clone(next);
  }

  async tryAcquireLease(jobId: string, lease: JobLease, now: Date, event: JobEventDraft): Promise<BackupJob | null> {
    const job = this.#jobs.get(jobId);
    if (!job || !this.#isClaimable(job, now)) return null;
    const next = this.#lease(job, lease, now);
    this.#jobs.set(jobId, clone(next));
    this.#appendDraft(jobId, event);
    return clone(next);
  }

  async tryAcquireNextLease(lease: JobLease, now: Date, event: JobEventDraft): Promise<BackupJob | null> {
    const candidates = [...this.#jobs.values()]
      .filter((job) => this.#isClaimable(job, now))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const job = candidates[0];
    if (!job) return null;
    const next = this.#lease(job, lease, now);
    this.#jobs.set(job.id, clone(next));
    this.#appendDraft(job.id, event);
    return clone(next);
  }

  async listExpiredLeases(now: Date, limit: number): Promise<BackupJob[]> {
    return [...this.#jobs.values()]
      .filter((job) => job.lease && isLeaseExpired(job.lease, now) && !["completed", "partial", "failed", "cancelled"].includes(job.state))
      .sort((a, b) => (a.lease?.expiresAt ?? "").localeCompare(b.lease?.expiresAt ?? ""))
      .slice(0, limit).map(clone);
  }

  async appendEvent(event: JobEvent): Promise<void> {
    const events = this.#events.get(event.jobId) ?? [];
    events.push(clone(event));
    this.#events.set(event.jobId, events);
  }

  async listEvents(jobId: string): Promise<JobEvent[]> { return clone(this.#events.get(jobId) ?? []); }

  #appendDraft(jobId: string, draft: JobEventDraft): void {
    const events = this.#events.get(jobId) ?? [];
    events.push(clone({ ...draft, jobId }));
    this.#events.set(jobId, events);
  }

  #isClaimable(job: BackupJob, now: Date): boolean {
    if (job.state !== "queued" && job.state !== "interrupted") return false;
    return !job.lease || isLeaseExpired(job.lease, now);
  }

  #lease(job: BackupJob, lease: JobLease, now: Date): BackupJob {
    return {
      ...job, state: "leased", attempt: job.attempt + 1, revision: job.revision + 1, lease,
      updatedAt: now.toISOString(), finishedAt: null, lastError: null,
    };
  }
}
