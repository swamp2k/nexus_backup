import { DuplicateOperationError, JobNotFoundError, LeaseConflictError } from "./errors.js";
import { buildLease, renewLease } from "./lease.js";
import type { JobRepository } from "./repository.js";
import { transitionJob } from "./state-machine.js";
import type { BackupJob, CreateJobInput, JobEvent, JobState, LeaseRequest, LeaseRenewal } from "./types.js";

export type IdFactory = () => string;

export interface JobServiceOptions {
  eventIdFactory?: IdFactory;
}

const defaultIdFactory: IdFactory = () => crypto.randomUUID();

export class JobService {
  readonly #repo: JobRepository;
  readonly #eventIdFactory: IdFactory;

  constructor(repo: JobRepository, options: JobServiceOptions = {}) {
    this.#repo = repo;
    this.#eventIdFactory = options.eventIdFactory ?? defaultIdFactory;
  }

  async create<TPayload>(input: CreateJobInput<TPayload>, now: Date): Promise<BackupJob<TPayload>> {
    const existing = await this.#repo.getByOperationKey<TPayload>(input.operationKey);
    if (existing) return existing;

    let job: BackupJob<TPayload>;
    try {
      job = await this.#repo.create(input, now);
    } catch (error) {
      if (!(error instanceof DuplicateOperationError)) throw error;
      const raced = await this.#repo.getByOperationKey<TPayload>(input.operationKey);
      if (!raced) throw error;
      return raced;
    }

    await this.#event(job.id, "job.created", now, { state: job.state, operationKey: job.operationKey });
    return job;
  }

  async acquire(request: LeaseRequest): Promise<BackupJob> {
    const lease = buildLease(request);
    const job = await this.#repo.tryAcquireLease(request.jobId, lease, request.now);
    if (!job) {
      const existing = await this.#repo.get(request.jobId);
      if (!existing) throw new JobNotFoundError(`Job not found: ${request.jobId}`);
      throw new LeaseConflictError(`Job ${request.jobId} is not available for agent ${request.agentId}`);
    }

    await this.#event(job.id, "job.leased", request.now, {
      agentId: request.agentId,
      attempt: job.attempt,
      expiresAt: job.lease?.expiresAt,
    });
    return job;
  }

  async heartbeat(request: LeaseRenewal): Promise<BackupJob> {
    const job = await this.#requireJob(request.jobId);
    const next = renewLease(job, request);
    await this.#repo.save(next);
    await this.#event(job.id, "job.lease_renewed", request.now, {
      agentId: request.agentId,
      expiresAt: next.lease?.expiresAt,
    });
    return next;
  }

  async transition(
    jobId: string,
    agentId: string,
    token: string,
    to: JobState,
    now: Date,
    error: string | null = null,
  ): Promise<BackupJob> {
    const job = await this.#requireJob(jobId);
    this.#assertLeaseOwner(job, agentId, token);

    const next = transitionJob(job, to, now, error);
    await this.#repo.save(next);
    if (next !== job) {
      await this.#event(job.id, "job.transitioned", now, { from: job.state, to, error });
    }
    return next;
  }

  async recoverExpired(now: Date, limit = 100): Promise<BackupJob[]> {
    const jobs = await this.#repo.listExpiredLeases(now, limit);
    const recovered: BackupJob[] = [];

    for (const job of jobs) {
      const interrupted = transitionJob(job, "interrupted", now, "lease expired");
      const requeued = transitionJob(
        { ...interrupted, lease: null },
        "queued",
        now,
        "lease expired; queued for recovery",
      );
      await this.#repo.save(requeued);
      await this.#event(job.id, "job.recovered", now, {
        previousAgentId: job.lease?.agentId,
        previousState: job.state,
      });
      recovered.push(requeued);
    }

    return recovered;
  }

  async #requireJob(jobId: string): Promise<BackupJob> {
    const job = await this.#repo.get(jobId);
    if (!job) throw new JobNotFoundError(`Job not found: ${jobId}`);
    return job;
  }

  #assertLeaseOwner(job: BackupJob, agentId: string, token: string): void {
    if (!job.lease || job.lease.agentId !== agentId || job.lease.token !== token) {
      throw new LeaseConflictError(`Agent ${agentId} does not own lease for job ${job.id}`);
    }
  }

  async #event(jobId: string, type: JobEvent["type"], at: Date, data: unknown): Promise<void> {
    await this.#repo.appendEvent({
      id: this.#eventIdFactory(),
      jobId,
      type,
      at: at.toISOString(),
      data,
    });
  }
}
