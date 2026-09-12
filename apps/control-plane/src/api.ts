import {
  ConcurrentMutationError,
  DuplicateOperationError,
  InvalidJobTransitionError,
  JOB_STATES,
  JobNotFoundError,
  JobService,
  LeaseConflictError,
  LeaseExpiredError,
  type JobState,
} from "@nexus-backup/core";
import { D1AgentStore, type AgentRecord } from "./agent-store.js";
import { D1JobRepository } from "./d1-job-repository.js";
import type { D1Database } from "./d1-types.js";

export interface Env {
  DB: D1Database;
  CONTROL_PLANE_TOKEN: string;
  DEFAULT_LEASE_TTL_MS?: string;
}

export interface ApiDependencies {
  now(): Date;
  id(): string;
  leaseToken(): string;
}

const defaults: ApiDependencies = {
  now: () => new Date(),
  id: () => crypto.randomUUID(),
  leaseToken: () => crypto.randomUUID(),
};

export function createApi(overrides: Partial<ApiDependencies> = {}) {
  const deps: ApiDependencies = { ...defaults, ...overrides };

  return {
    fetch: (request: Request, env: Env) => handleRequest(request, env, deps),
    recover: (env: Env) => recoverExpiredLeases(env, deps),
  };
}

export async function handleRequest(request: Request, env: Env, deps: ApiDependencies = defaults): Promise<Response> {
  try {
    const url = new URL(request.url);
    const path = normalizePath(url.pathname);

    if (request.method === "GET" && path === "/healthz") {
      return json({ ok: true, service: "nexus-backup-control-plane" });
    }

    if (request.method === "POST" && path === "/v1/agents") {
      requireControlAuth(request, env);
      const body = await readJsonObject(request);
      const id = requireAgentId(body.id);
      const token = requireString(body.token, "token", 32, 512);
      const name = optionalString(body.name, "name", 1, 200);
      const store = new D1AgentStore(env.DB);
      const agent = await store.register(id, name ?? null, token, deps.now());
      return json({ agent }, 201);
    }

    if (request.method === "POST" && path === "/v1/jobs") {
      requireControlAuth(request, env);
      const body = await readJsonObject(request);
      const operationKey = requireString(body.operationKey, "operationKey", 1, 512);
      const type = requireString(body.type, "type", 1, 128);
      const id = body.id === undefined ? deps.id() : requireString(body.id, "id", 1, 200);
      const payload = body.payload ?? {};
      assertJsonValue(payload, "payload");
      const service = serviceFor(env, deps);
      const job = await service.create({ id, operationKey, type, payload }, deps.now());
      return json({ job }, 201);
    }

    const eventsMatch = path.match(/^\/v1\/jobs\/([^/]+)\/events$/);
    if (request.method === "GET" && eventsMatch) {
      requireControlAuth(request, env);
      const jobId = decodePathPart(eventsMatch[1]);
      const repo = new D1JobRepository(env.DB);
      const job = await repo.get(jobId);
      if (!job) throw new JobNotFoundError(`Job not found: ${jobId}`);
      const events = await repo.listEvents(jobId);
      return json({ events });
    }

    const jobMatch = path.match(/^\/v1\/jobs\/([^/]+)$/);
    if (request.method === "GET" && jobMatch) {
      requireControlAuth(request, env);
      const jobId = decodePathPart(jobMatch[1]);
      const job = await new D1JobRepository(env.DB).get(jobId);
      if (!job) throw new JobNotFoundError(`Job not found: ${jobId}`);
      return json({ job });
    }

    if (request.method === "POST" && path === "/v1/agent/claim") {
      const store = new D1AgentStore(env.DB);
      const agent = await requireAgentAuth(request, store);
      const body = await readJsonObject(request, true);
      const now = deps.now();
      const version = optionalString(body.version, "version", 1, 100);
      await store.touch(agent.id, now, version);
      const ttlMs = leaseTtl(body.leaseTtlMs, env);
      const service = serviceFor(env, deps);
      const job = await service.claim({ agentId: agent.id, token: deps.leaseToken(), now, ttlMs });
      if (!job) return new Response(null, { status: 204 });
      return json({ job, leaseToken: job.lease?.token, leaseTtlMs: ttlMs });
    }

    const agentJobMatch = path.match(/^\/v1\/agent\/jobs\/([^/]+)\/(heartbeat|transition)$/);
    if (request.method === "POST" && agentJobMatch) {
      const store = new D1AgentStore(env.DB);
      const agent = await requireAgentAuth(request, store);
      const jobId = decodePathPart(agentJobMatch[1]);
      const action = agentJobMatch[2];
      const body = await readJsonObject(request);
      const now = deps.now();
      await store.touch(agent.id, now);
      const leaseToken = requireString(body.leaseToken, "leaseToken", 1, 512);
      const service = serviceFor(env, deps);

      if (action === "heartbeat") {
        const ttlMs = leaseTtl(body.leaseTtlMs, env);
        const job = await service.heartbeat({ jobId, agentId: agent.id, token: leaseToken, now, ttlMs });
        return json({ job });
      }

      const state = requireJobState(body.state);
      const error = body.error === null ? null : optionalString(body.error, "error", 1, 4_000) ?? null;
      const job = await service.transition(jobId, agent.id, leaseToken, state, now, error);
      return json({ job });
    }

    throw new HttpError(404, "not_found", "Route not found");
  } catch (error) {
    return errorResponse(error);
  }
}

export async function recoverExpiredLeases(env: Env, deps: ApiDependencies = defaults): Promise<number> {
  const service = serviceFor(env, deps);
  let total = 0;
  for (let page = 0; page < 10; page += 1) {
    const recovered = await service.recoverExpired(deps.now(), 100);
    total += recovered.length;
    if (recovered.length < 100) break;
  }
  return total;
}

function serviceFor(env: Env, deps: ApiDependencies): JobService {
  return new JobService(new D1JobRepository(env.DB), { eventIdFactory: deps.id });
}

class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function requireControlAuth(request: Request, env: Env): void {
  if (!env.CONTROL_PLANE_TOKEN) throw new HttpError(500, "server_misconfigured", "CONTROL_PLANE_TOKEN is not configured");
  const token = bearerToken(request);
  if (!token || !constantTimeEqual(token, env.CONTROL_PLANE_TOKEN)) {
    throw new HttpError(401, "unauthorized", "Invalid control-plane token");
  }
}

async function requireAgentAuth(request: Request, store: D1AgentStore): Promise<AgentRecord> {
  const token = bearerToken(request);
  if (!token) throw new HttpError(401, "unauthorized", "Missing agent bearer token");
  const agent = await store.findByRawToken(token);
  if (!agent) throw new HttpError(401, "unauthorized", "Invalid or disabled agent token");
  return agent;
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

async function readJsonObject(request: Request, allowEmpty = false): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > 1_048_576) throw new HttpError(413, "payload_too_large", "JSON body exceeds 1 MiB");
  if (!text.trim()) {
    if (allowEmpty) return {};
    throw new HttpError(400, "invalid_json", "JSON body is required");
  }
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new HttpError(400, "invalid_json", "Malformed JSON body"); }
  if (!isRecord(value)) throw new HttpError(400, "invalid_json", "JSON body must be an object");
  return value;
}

function requireString(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== "string") throw new HttpError(400, "validation_error", `${field} must be a string`);
  const normalized = value.trim();
  if (normalized.length < min || normalized.length > max) throw new HttpError(400, "validation_error", `${field} must be ${min}-${max} characters`);
  return normalized;
}

function optionalString(value: unknown, field: string, min: number, max: number): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, field, min, max);
}

function requireAgentId(value: unknown): string {
  const id = requireString(value, "id", 1, 128);
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new HttpError(400, "validation_error", "id may only contain letters, numbers, dot, underscore and hyphen");
  return id;
}

function requireJobState(value: unknown): JobState {
  if (typeof value !== "string" || !(JOB_STATES as readonly string[]).includes(value)) {
    throw new HttpError(400, "validation_error", "state is not a valid job state");
  }
  return value as JobState;
}

function leaseTtl(value: unknown, env: Env): number {
  let raw: number;
  if (value === undefined) raw = Number(env.DEFAULT_LEASE_TTL_MS ?? 60_000);
  else if (typeof value === "number") raw = value;
  else throw new HttpError(400, "validation_error", "leaseTtlMs must be a number");
  if (!Number.isInteger(raw) || raw < 5_000 || raw > 600_000) {
    throw new HttpError(400, "validation_error", "leaseTtlMs must be an integer between 5000 and 600000");
  }
  return raw;
}

function assertJsonValue(value: unknown, field: string): void {
  try { JSON.stringify(value); } catch { throw new HttpError(400, "validation_error", `${field} must be JSON serializable`); }
}

function decodePathPart(value: string | undefined): string {
  if (!value) throw new HttpError(400, "validation_error", "Missing path identifier");
  try { return decodeURIComponent(value); } catch { throw new HttpError(400, "validation_error", "Invalid path encoding"); }
}

function normalizePath(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) return json({ code: error.code, message: error.message }, error.status);
  if (error instanceof JobNotFoundError) return json({ code: "job_not_found", message: error.message }, 404);
  if (error instanceof DuplicateOperationError) return json({ code: "duplicate_operation", message: error.message }, 409);
  if (error instanceof LeaseConflictError || error instanceof LeaseExpiredError || error instanceof ConcurrentMutationError || error instanceof InvalidJobTransitionError) {
    return json({ code: "job_conflict", message: error.message }, 409);
  }
  if (error instanceof RangeError) return json({ code: "validation_error", message: error.message }, 400);
  console.error("Unhandled control-plane error", error);
  return json({ code: "internal_error", message: "Internal server error" }, 500);
}
