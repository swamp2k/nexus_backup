import { LeaseConflictError, LeaseExpiredError } from "./errors.js";
import type { BackupJob, JobLease, LeaseRenewal, LeaseRequest } from "./types.js";

export function isLeaseExpired(lease: JobLease, now: Date): boolean {
  return new Date(lease.expiresAt).getTime() <= now.getTime();
}

export function buildLease(request: Omit<LeaseRequest, "jobId">): JobLease {
  if (request.ttlMs <= 0) throw new RangeError("Lease ttlMs must be greater than zero");
  const acquiredAt = request.now.toISOString();
  return {
    agentId: request.agentId,
    token: request.token,
    acquiredAt,
    heartbeatAt: acquiredAt,
    expiresAt: new Date(request.now.getTime() + request.ttlMs).toISOString(),
  };
}

export function renewLease<TPayload>(job: BackupJob<TPayload>, request: LeaseRenewal): BackupJob<TPayload> {
  const lease = job.lease;
  if (!lease || lease.agentId !== request.agentId || lease.token !== request.token) {
    throw new LeaseConflictError(`Agent ${request.agentId} does not own lease for job ${job.id}`);
  }
  if (isLeaseExpired(lease, request.now)) {
    throw new LeaseExpiredError(`Lease for job ${job.id} has expired`);
  }
  if (request.ttlMs <= 0) throw new RangeError("Lease ttlMs must be greater than zero");
  return {
    ...job,
    lease: {
      ...lease,
      heartbeatAt: request.now.toISOString(),
      expiresAt: new Date(request.now.getTime() + request.ttlMs).toISOString(),
    },
    updatedAt: request.now.toISOString(),
  };
}
