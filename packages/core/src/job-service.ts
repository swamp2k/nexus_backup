import { ConcurrentMutationError, DuplicateOperationError, JobNotFoundError, LeaseConflictError } from "./errors.js";
import { buildLease, renewLease } from "./lease.js";
import type { JobRepository } from "./repository.js";
import { transitionJob } from "./state-machine.js";
import type { BackupJob, ClaimRequest, CreateJobInput, JobEventDraft, JobState, LeaseRequest, LeaseRenewal } from "./types.js";

export type IdFactory = () => string;
export interface JobServiceOptions { eventIdFactory?: IdFactory; }
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
    try {
      return await this.#repo.create(input, now, this.#event("job.created", now, { state: "queued", operationKey: input.operationKey }));
    } catch (error) {
      if (!(error instanceof DuplicateOperationError)) throw error;
      const raced = await this.#repo.getByOperationKey<TPayload>(input.operationKey);
      if (!raced) throw error;
      return raced;
    }
  }

  async acquire(request: LeaseRequest): Promise<BackupJob> {
    const lease = buildLease(request);
    const event = this.#event("job.leased", request.now, { agentId: request.agentId, expiresAt: lease.expiresAt });
    const job = await this.#repo.tryAcquireLease(request.jobId, lease, request.now, event);
    if (!job) {
      const existing = await this.#repo.get(request.jobId);
      if (!existing) throw new JobNotFoundError(`Job not found: ${request.jobId}`);
      throw new LeaseConflictError(`Job ${request.jobId} is not available for agent ${request.agentId}`);
    }
    return job;
  }

  async claim(request: ClaimRequest): Promise<BackupJob | null> {
    const lease = buildLease(request);
    return this.#repo.tryAcquireNextLease(
      lease,
      request.now,
      this.#event("job.leased", request.now, { agentId: request.agentId, expiresAt: lease.expiresAt }),
    );
  }

  async heartbeat(request: LeaseRenewal): Promise<BackupJob> {
    const job = await this.#requireJob(request.jobId);
    const next = renewLease(job, request);
    const saved = await this.#repo.save(
      next,
      job.revision,
      this.#event("job.lease_renewed", request.now, { agentId: request.agentId, expiresAt: next.lease?.expiresAt }),
    );
    if (!saved) throw new ConcurrentMutationError(`Job ${job.id} changed while renewing its lease`);
    return saved;
  }

  async transition(jobId: string, agentId: string, token: string, to: JobState, now: Date, error: string | null = null): Promise<BackupJob> {
    const job = await this.#requireJob(jobId);
    this.#assertLeaseOwner(job, agentId, token);
    const next = transitionJob(job, to, now, error);
    if (next === job) return job;
    const saved = await this.#repo.save(
      next,
      job.revision,
      this.#event("job.transitioned", now, { from: job.state, to, error }),
    );
    if (!saved) throw new ConcurrentMutationError(`Job ${job.id} changed during transition to ${to}`);
    return saved;
  }

  async recoverExpired(now: Date, limit = 100): Promise<BackupJob[]> {
    const jobs = await this.#repo.listExpiredLeases(now, limit);
    const recovered: BackupJob[] = [];
    for (const job of jobs) {
      const interrupted = transitionJob(job, "interrupted", now, "lease expired");
      const requeued = transitionJob({ ...interrupted, lease: null }, "queued", now, "lease expired; queued for recovery");
      const saved = await this.#repo.save(
        requeued,
        job.revision,
        this.#event("job.recovered", now, { previousAgentId: job.lease?.agentId, previousState: job.state }),
      );
      if (saved) recovered.push(saved);
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

  #event(type: JobEventDraft["type"], at: Date, data: unknown): JobEventDraft {
    return { id: this.#eventIdFactory(), type, at: at.toISOString(), data };
  }
}
