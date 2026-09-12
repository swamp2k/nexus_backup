import {
  DuplicateOperationError,
  type BackupJob,
  type CreateJobInput,
  type JobEvent,
  type JobEventDraft,
  type JobLease,
  type JobRepository,
} from "@nexus-backup/core";
import type { D1Database, D1PreparedStatement, D1Result } from "./d1-types.js";

interface JobRow {
  id: string;
  operation_key: string;
  type: string;
  state: BackupJob["state"];
  attempt: number;
  revision: number;
  payload_json: string;
  lease_agent_id: string | null;
  lease_token: string | null;
  lease_acquired_at: string | null;
  lease_expires_at: string | null;
  lease_heartbeat_at: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  last_error: string | null;
  last_mutation_id: string;
}

interface EventRow {
  id: string;
  job_id: string;
  type: JobEvent["type"];
  at: string;
  data_json: string;
}

export class D1JobRepository implements JobRepository {
  readonly #db: D1Database;

  constructor(db: D1Database) { this.#db = db; }

  async create<TPayload>(input: CreateJobInput<TPayload>, now: Date, event: JobEventDraft): Promise<BackupJob<TPayload>> {
    const iso = now.toISOString();
    const mutation = this.#db.prepare(`
      INSERT INTO backup_jobs (
        id, operation_key, type, state, attempt, revision, payload_json,
        created_at, updated_at, last_mutation_id
      ) VALUES (?, ?, ?, 'queued', 0, 0, ?, ?, ?, ?)
      RETURNING *
    `).bind(input.id, input.operationKey, input.type, JSON.stringify(input.payload), iso, iso, event.id);
    const eventInsert = this.#eventInsertForJob(input.id, event);

    try {
      const row = await this.#commitMutation(mutation, eventInsert);
      if (!row) throw new Error("D1 did not return the created job");
      return rowToJob<TPayload>(row);
    } catch (error) {
      const existing = await this.getByOperationKey(input.operationKey);
      if (existing) throw new DuplicateOperationError(`Operation key already exists: ${input.operationKey}`);
      throw error;
    }
  }

  async get<TPayload = unknown>(jobId: string): Promise<BackupJob<TPayload> | null> {
    const row = await this.#db.prepare("SELECT * FROM backup_jobs WHERE id = ?").bind(jobId).first<JobRow>();
    return row ? rowToJob<TPayload>(row) : null;
  }

  async getByOperationKey<TPayload = unknown>(operationKey: string): Promise<BackupJob<TPayload> | null> {
    const row = await this.#db.prepare("SELECT * FROM backup_jobs WHERE operation_key = ?").bind(operationKey).first<JobRow>();
    return row ? rowToJob<TPayload>(row) : null;
  }

  async save<TPayload>(job: BackupJob<TPayload>, expectedRevision: number, event: JobEventDraft): Promise<BackupJob<TPayload> | null> {
    const mutation = this.#db.prepare(`
      UPDATE backup_jobs SET
        state = ?, attempt = ?, revision = revision + 1, payload_json = ?,
        lease_agent_id = ?, lease_token = ?, lease_acquired_at = ?,
        lease_expires_at = ?, lease_heartbeat_at = ?, updated_at = ?,
        started_at = ?, finished_at = ?, last_error = ?, last_mutation_id = ?
      WHERE id = ? AND revision = ?
      RETURNING *
    `).bind(
      job.state,
      job.attempt,
      JSON.stringify(job.payload),
      job.lease?.agentId ?? null,
      job.lease?.token ?? null,
      job.lease?.acquiredAt ?? null,
      job.lease?.expiresAt ?? null,
      job.lease?.heartbeatAt ?? null,
      job.updatedAt,
      job.startedAt,
      job.finishedAt,
      job.lastError,
      event.id,
      job.id,
      expectedRevision,
    );
    const row = await this.#commitMutation(mutation, this.#eventInsertForMutation(event));
    return row ? rowToJob<TPayload>(row) : null;
  }

  async tryAcquireLease(jobId: string, lease: JobLease, now: Date, event: JobEventDraft): Promise<BackupJob | null> {
    const mutation = this.#db.prepare(`
      UPDATE backup_jobs SET
        state = 'leased', attempt = attempt + 1, revision = revision + 1,
        lease_agent_id = ?, lease_token = ?, lease_acquired_at = ?,
        lease_expires_at = ?, lease_heartbeat_at = ?, updated_at = ?,
        finished_at = NULL, last_error = NULL, last_mutation_id = ?
      WHERE id = ?
        AND state IN ('queued', 'interrupted')
        AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
      RETURNING *
    `).bind(
      lease.agentId, lease.token, lease.acquiredAt, lease.expiresAt, lease.heartbeatAt,
      now.toISOString(), event.id, jobId, now.toISOString(),
    );
    const row = await this.#commitMutation(mutation, this.#eventInsertForMutation(event));
    return row ? rowToJob(row) : null;
  }

  async tryAcquireNextLease(lease: JobLease, now: Date, event: JobEventDraft): Promise<BackupJob | null> {
    const iso = now.toISOString();
    const mutation = this.#db.prepare(`
      UPDATE backup_jobs SET
        state = 'leased', attempt = attempt + 1, revision = revision + 1,
        lease_agent_id = ?, lease_token = ?, lease_acquired_at = ?,
        lease_expires_at = ?, lease_heartbeat_at = ?, updated_at = ?,
        finished_at = NULL, last_error = NULL, last_mutation_id = ?
      WHERE id = (
        SELECT id FROM backup_jobs
        WHERE state IN ('queued', 'interrupted')
          AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
        ORDER BY created_at ASC, id ASC
        LIMIT 1
      )
        AND state IN ('queued', 'interrupted')
        AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
      RETURNING *
    `).bind(
      lease.agentId, lease.token, lease.acquiredAt, lease.expiresAt, lease.heartbeatAt,
      iso, event.id, iso, iso,
    );
    const row = await this.#commitMutation(mutation, this.#eventInsertForMutation(event));
    return row ? rowToJob(row) : null;
  }

  async listExpiredLeases(now: Date, limit: number): Promise<BackupJob[]> {
    const result = await this.#db.prepare(`
      SELECT * FROM backup_jobs
      WHERE lease_expires_at IS NOT NULL
        AND lease_expires_at <= ?
        AND state NOT IN ('completed', 'partial', 'failed', 'cancelled')
      ORDER BY lease_expires_at ASC, id ASC
      LIMIT ?
    `).bind(now.toISOString(), limit).all<JobRow>();
    return (result.results ?? []).map((row) => rowToJob(row));
  }

  async appendEvent(event: JobEvent): Promise<void> {
    await this.#db.prepare(`
      INSERT INTO backup_job_events (id, job_id, type, at, data_json)
      VALUES (?, ?, ?, ?, ?)
    `).bind(event.id, event.jobId, event.type, event.at, JSON.stringify(event.data)).run();
  }

  async listEvents(jobId: string): Promise<JobEvent[]> {
    const result = await this.#db.prepare(`
      SELECT id, job_id, type, at, data_json
      FROM backup_job_events
      WHERE job_id = ?
      ORDER BY at ASC, id ASC
    `).bind(jobId).all<EventRow>();
    return (result.results ?? []).map((row) => ({
      id: row.id, jobId: row.job_id, type: row.type, at: row.at,
      data: JSON.parse(row.data_json) as unknown,
    }));
  }

  async #commitMutation(mutation: D1PreparedStatement, eventInsert: D1PreparedStatement): Promise<JobRow | null> {
    const results = await this.#db.batch([mutation, eventInsert]);
    const mutationResult = results[0] as D1Result<JobRow> | undefined;
    return mutationResult?.results?.[0] ?? null;
  }

  #eventInsertForJob(jobId: string, event: JobEventDraft): D1PreparedStatement {
    return this.#db.prepare(`
      INSERT INTO backup_job_events (id, job_id, type, at, data_json)
      SELECT ?, id, ?, ?, ? FROM backup_jobs
      WHERE id = ? AND last_mutation_id = ?
    `).bind(event.id, event.type, event.at, JSON.stringify(event.data), jobId, event.id);
  }

  #eventInsertForMutation(event: JobEventDraft): D1PreparedStatement {
    return this.#db.prepare(`
      INSERT INTO backup_job_events (id, job_id, type, at, data_json)
      SELECT ?, id, ?, ?, ? FROM backup_jobs
      WHERE last_mutation_id = ?
    `).bind(event.id, event.type, event.at, JSON.stringify(event.data), event.id);
  }
}

function rowToJob<TPayload = unknown>(row: JobRow): BackupJob<TPayload> {
  const hasLease = row.lease_agent_id !== null && row.lease_token !== null && row.lease_acquired_at !== null && row.lease_expires_at !== null && row.lease_heartbeat_at !== null;
  return {
    id: row.id, operationKey: row.operation_key, type: row.type, state: row.state,
    attempt: Number(row.attempt), revision: Number(row.revision), payload: JSON.parse(row.payload_json) as TPayload,
    lease: hasLease ? {
      agentId: row.lease_agent_id as string,
      token: row.lease_token as string,
      acquiredAt: row.lease_acquired_at as string,
      expiresAt: row.lease_expires_at as string,
      heartbeatAt: row.lease_heartbeat_at as string,
    } : null,
    createdAt: row.created_at, updatedAt: row.updated_at, startedAt: row.started_at,
    finishedAt: row.finished_at, lastError: row.last_error,
  };
}
