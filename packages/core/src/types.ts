export const JOB_STATES = [
  "queued",
  "leased",
  "preparing",
  "running",
  "finalizing",
  "completed",
  "partial",
  "failed",
  "cancelled",
  "interrupted",
] as const;

export type JobState = (typeof JOB_STATES)[number];

export const TERMINAL_JOB_STATES = [
  "completed",
  "partial",
  "failed",
  "cancelled",
] as const satisfies readonly JobState[];

export type TerminalJobState = (typeof TERMINAL_JOB_STATES)[number];

export interface JobLease {
  agentId: string;
  token: string;
  acquiredAt: string;
  expiresAt: string;
  heartbeatAt: string;
}

export interface BackupJob<TPayload = unknown> {
  id: string;
  operationKey: string;
  type: string;
  state: JobState;
  attempt: number;
  payload: TPayload;
  lease: JobLease | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
}

export type JobEventType =
  | "job.created"
  | "job.leased"
  | "job.lease_renewed"
  | "job.transitioned"
  | "job.recovered"
  | "job.note";

export interface JobEvent<TData = unknown> {
  id: string;
  jobId: string;
  type: JobEventType;
  at: string;
  data: TData;
}

export interface AgentHeartbeat {
  agentId: string;
  at: string;
  version?: string;
  activeJobIds: readonly string[];
}

export interface CreateJobInput<TPayload = unknown> {
  id: string;
  operationKey: string;
  type: string;
  payload: TPayload;
}

export interface LeaseRequest {
  jobId: string;
  agentId: string;
  token: string;
  now: Date;
  ttlMs: number;
}

export interface LeaseRenewal {
  jobId: string;
  agentId: string;
  token: string;
  now: Date;
  ttlMs: number;
}
