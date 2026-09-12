#!/usr/bin/env node
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApi, D1AgentStore, D1JobRepository } from "../../control-plane/dist/index.js";
import { createBackupPlanService } from "../lib/backup-plans.mjs";
import { createPlanMaintenanceService, enrichPlanJob } from "../lib/plan-maintenance.mjs";
import { listAgents, listJobs, loadSanitizedAgentConfig } from "../lib/dashboard-data.mjs";
import { listRepositoryInventories, queueRepositoryInventory } from "../lib/repository-inventory.mjs";
import { getRuntimeTelemetry, recordRuntimeEvents } from "../lib/runtime-telemetry.mjs";
import { getSnapshotBrowse, queueRestorePreview, queueSnapshotBrowse } from "../lib/snapshot-restore.mjs";
import { openSqliteD1 } from "../lib/sqlite-d1.mjs";

const configDir = process.env.NEXUS_BACKUP_CONFIG_DIR?.trim() || "/config";
const runtimeDir = process.env.NEXUS_BACKUP_RUNTIME_DIR?.trim() || "/run/nexus-backup";
const databasePath = process.env.NEXUS_BACKUP_DB?.trim() || join(configDir, "nexus-backup.sqlite");
const migrationsDir = process.env.NEXUS_BACKUP_MIGRATIONS?.trim()
  || fileURLToPath(new URL("../../../migrations/", import.meta.url));
const webDir = process.env.NEXUS_BACKUP_WEB_DIR?.trim()
  || fileURLToPath(new URL("../web/", import.meta.url));
const agentConfigPath = process.env.NEXUS_BACKUP_AGENT_CONFIG?.trim() || "/agent-config/agent.json";
const host = process.env.NEXUS_BACKUP_HOST?.trim() || "0.0.0.0";
const port = positiveInteger(process.env.NEXUS_BACKUP_PORT ?? "8787", "NEXUS_BACKUP_PORT");
const agentId = process.env.NEXUS_BACKUP_AGENT_ID?.trim() || "local-agent";
const recoveryIntervalMs = positiveInteger(
  process.env.NEXUS_BACKUP_RECOVERY_INTERVAL_MS ?? "30000",
  "NEXUS_BACKUP_RECOVERY_INTERVAL_MS",
);
const schedulerIntervalMs = positiveInteger(
  process.env.NEXUS_BACKUP_SCHEDULER_INTERVAL_MS ?? "15000",
  "NEXUS_BACKUP_SCHEDULER_INTERVAL_MS",
);

await mkdir(configDir, { recursive: true });
await mkdir(runtimeDir, { recursive: true });

const db = await openSqliteD1({ filename: databasePath, migrationsDir });
const controlToken = await ensureSecret(join(configDir, "control-token"));
const agentToken = await ensureSecret(join(configDir, "agent-token"));
await mirrorSecret(agentToken, join(runtimeDir, "agent-token"));
await new D1AgentStore(db).register(agentId, "Local Nexus Backup agent", agentToken, new Date());

const api = createApi();
const env = {
  DB: db,
  CONTROL_PLANE_TOKEN: controlToken,
  ...(process.env.DEFAULT_LEASE_TTL_MS ? { DEFAULT_LEASE_TTL_MS: process.env.DEFAULT_LEASE_TTL_MS } : {}),
};

async function enqueueJob(input) {
  const { operationKey, type, payload } = enrichPlanJob(input);
  const webResponse = await api.fetch(new Request("http://nexus-backup.local/v1/jobs", {
    method: "POST",
    headers: {
      authorization: `Bearer ${controlToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ operationKey, type, payload }),
  }), env);
  if (!webResponse.ok) {
    let message = `job enqueue failed with ${webResponse.status}`;
    try {
      const data = await webResponse.json();
      message = data.message ?? data.code ?? message;
    } catch {}
    throw new Error(message);
  }
  return (await webResponse.json()).job;
}

const planService = createBackupPlanService({
  db,
  enqueueJob,
  loadAgentConfig: () => loadSanitizedAgentConfig(agentConfigPath),
});
const maintenanceService = createPlanMaintenanceService({ db, enqueueJob });

const recoveryTimer = setInterval(() => {
  api.recover(env).catch((error) => log("error", "lease recovery failed", { error: serializeError(error) }));
}, recoveryIntervalMs);
recoveryTimer.unref();

let schedulerRunning = false;
async function runPlanScheduler() {
  if (schedulerRunning) return;
  schedulerRunning = true;
  try {
    const result = await planService.runDue();
    if (result.enqueued > 0) log("info", "scheduled backup plans enqueued", { count: result.enqueued });
    for (const failure of result.failures) {
      log("error", "scheduled backup plan enqueue failed", failure);
    }

    const maintenance = await maintenanceService.runDue();
    if (maintenance.enqueued > 0) log("info", "retention maintenance jobs enqueued", { count: maintenance.enqueued });
    for (const failure of maintenance.failures) {
      log("error", "retention maintenance enqueue failed", failure);
    }
  } catch (error) {
    log("error", "backup plan scheduler failed", { error: serializeError(error) });
  } finally {
    schedulerRunning = false;
  }
}
const schedulerTimer = setInterval(() => void runPlanScheduler(), schedulerIntervalMs);
schedulerTimer.unref();
void runPlanScheduler();

const STATIC_FILES = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/telemetry.js", ["telemetry.js", "text/javascript; charset=utf-8"]],
  ["/plans.js", ["plans.js", "text/javascript; charset=utf-8"]],
  ["/maintenance.js", ["maintenance.js", "text/javascript; charset=utf-8"]],
  ["/repository-inventory.js", ["repository-inventory.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/telemetry.css", ["telemetry.css", "text/css; charset=utf-8"]],
  ["/plans.css", ["plans.css", "text/css; charset=utf-8"]],
  ["/maintenance.css", ["maintenance.css", "text/css; charset=utf-8"]],
  ["/repository-inventory.css", ["repository-inventory.css", "text/css; charset=utf-8"]],
  ["/favicon.svg", ["favicon.svg", "image/svg+xml"]],
]);

const server = createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url || "/", `http://${request.headers.host || `127.0.0.1:${port}`}`);
    const path = requestUrl.pathname;

    if (request.method === "GET" && STATIC_FILES.has(path)) {
      await serveStatic(path, response);
      return;
    }

    if (path === "/v1/local/info" && request.method === "GET") {
      sendJson(response, 200, {
        mode: "local",
        selfContained: true,
        remoteControl: "optional",
        agentId,
        pollIntervalMs: 5000,
        telemetryPollIntervalMs: 1000,
        schedulerIntervalMs,
        retentionEnforcement: true,
        repositoryInventory: true,
        snapshotBrowser: true,
        restorePreview: true,
        restoreExecution: false,
      });
      return;
    }

    if (path === "/v1/local/config" && request.method === "GET") {
      sendJson(response, 200, await loadSanitizedAgentConfig(agentConfigPath));
      return;
    }

    if (path === "/v1/local/agents" && request.method === "GET") {
      sendJson(response, 200, { agents: await listAgents(db) });
      return;
    }

    if (path === "/v1/local/repositories" && request.method === "GET") {
      const config = await loadSanitizedAgentConfig(agentConfigPath);
      sendJson(response, 200, {
        available: config.available,
        restoreTargets: config.restoreTargets ?? [],
        repositories: await listRepositoryInventories(db, config.repositories ?? []),
      });
      return;
    }

    const repositoryRefreshMatch = path.match(/^\/v1\/local\/repositories\/([^/]+)\/refresh$/);
    if (request.method === "POST" && repositoryRefreshMatch) {
      const repositoryId = decodePathPart(repositoryRefreshMatch[1]);
      const config = await loadSanitizedAgentConfig(agentConfigPath);
      if (!config.available) throw statusError(409, "Agent config is unavailable");
      sendJson(response, 202, await queueRepositoryInventory(db, {
        repositoryId,
        repositories: config.repositories ?? [],
        enqueueJob,
      }));
      return;
    }

    const snapshotBrowseMatch = path.match(/^\/v1\/local\/repositories\/([^/]+)\/snapshots\/([^/]+)\/browse$/);
    if (snapshotBrowseMatch) {
      const repositoryId = decodePathPart(snapshotBrowseMatch[1]);
      const snapshotId = decodePathPart(snapshotBrowseMatch[2]);
      if (request.method === "GET") {
        sendJson(response, 200, await getSnapshotBrowse(db, {
          repositoryId,
          snapshotId,
          path: requestUrl.searchParams.get("path") ?? "/",
        }));
        return;
      }
      if (request.method === "POST") {
        const config = await loadSanitizedAgentConfig(agentConfigPath);
        if (!config.available) throw statusError(409, "Agent config is unavailable");
        const body = await readJsonBody(request);
        sendJson(response, 202, await queueSnapshotBrowse(db, {
          repositoryId,
          snapshotId,
          path: typeof body.path === "string" ? body.path : "/",
          repositories: config.repositories ?? [],
          enqueueJob,
        }));
        return;
      }
    }

    const restorePreviewMatch = path.match(/^\/v1\/local\/repositories\/([^/]+)\/snapshots\/([^/]+)\/preview$/);
    if (request.method === "POST" && restorePreviewMatch) {
      const repositoryId = decodePathPart(restorePreviewMatch[1]);
      const snapshotId = decodePathPart(restorePreviewMatch[2]);
      const config = await loadSanitizedAgentConfig(agentConfigPath);
      if (!config.available) throw statusError(409, "Agent config is unavailable");
      const body = await readJsonBody(request);
      sendJson(response, 202, await queueRestorePreview(db, {
        repositoryId,
        snapshotId,
        targetId: body.targetId,
        path: body.path,
        repositories: config.repositories ?? [],
        restoreTargets: config.restoreTargets ?? [],
        enqueueJob,
      }));
      return;
    }

    if (path === "/v1/local/plans" && request.method === "GET") {
      sendJson(response, 200, { plans: await planService.list() });
      return;
    }

    if (path === "/v1/local/plans" && request.method === "POST") {
      sendJson(response, 201, { plan: await planService.create(await readJsonBody(request)) });
      return;
    }

    if (path === "/v1/local/maintenance" && request.method === "GET") {
      sendJson(response, 200, { maintenance: await maintenanceService.list() });
      return;
    }

    const planMaintenanceMatch = path.match(/^\/v1\/local\/plans\/([^/]+)\/maintenance$/);
    if (request.method === "POST" && planMaintenanceMatch) {
      const planId = decodePathPart(planMaintenanceMatch[1]);
      sendJson(response, 202, await maintenanceService.runNow(planId));
      return;
    }

    const planRunMatch = path.match(/^\/v1\/local\/plans\/([^/]+)\/run$/);
    if (request.method === "POST" && planRunMatch) {
      const planId = decodePathPart(planRunMatch[1]);
      sendJson(response, 202, await planService.runNow(planId));
      return;
    }

    const planMatch = path.match(/^\/v1\/local\/plans\/([^/]+)$/);
    if (planMatch) {
      const planId = decodePathPart(planMatch[1]);
      if (request.method === "GET") {
        const plan = await planService.get(planId);
        if (!plan) throw statusError(404, `Backup plan not found: ${planId}`);
        sendJson(response, 200, { plan });
        return;
      }
      if (request.method === "PUT") {
        sendJson(response, 200, { plan: await planService.update(planId, await readJsonBody(request)) });
        return;
      }
      if (request.method === "PATCH") {
        const body = await readJsonBody(request);
        sendJson(response, 200, { plan: await planService.setEnabled(planId, body.enabled) });
        return;
      }
    }

    if (path === "/v1/local/jobs" && request.method === "GET") {
      sendJson(response, 200, {
        jobs: await listJobs(db, {
          limit: requestUrl.searchParams.get("limit") ?? 100,
          state: requestUrl.searchParams.get("state") ?? undefined,
        }),
      });
      return;
    }

    if (path === "/v1/local/jobs" && request.method === "POST") {
      const webRequest = await toWebRequest(request, {
        path: "/v1/jobs",
        authorization: `Bearer ${controlToken}`,
      });
      const webResponse = await api.fetch(webRequest, env);
      await fromWebResponse(webResponse, response);
      return;
    }

    const runtimeWriteMatch = path.match(/^\/v1\/agent\/jobs\/([^/]+)\/runtime$/);
    if (request.method === "POST" && runtimeWriteMatch) {
      const jobId = decodePathPart(runtimeWriteMatch[1]);
      const rawAgentToken = bearerToken(request);
      if (!rawAgentToken) {
        sendJson(response, 401, { code: "unauthorized", message: "Missing agent bearer token" });
        return;
      }

      const agentStore = new D1AgentStore(db);
      const agent = await agentStore.findByRawToken(rawAgentToken);
      if (!agent) {
        sendJson(response, 401, { code: "unauthorized", message: "Invalid or disabled agent token" });
        return;
      }

      const body = await readJsonBody(request);
      const leaseToken = requireBodyString(body.leaseToken, "leaseToken", 1, 512);
      const repository = new D1JobRepository(db);
      const job = await repository.get(jobId);
      if (!job) {
        sendJson(response, 404, { code: "job_not_found", message: `Job not found: ${jobId}` });
        return;
      }
      if (!job.lease
        || job.lease.agentId !== agent.id
        || !constantTimeEqual(job.lease.token, leaseToken)
        || Date.parse(job.lease.expiresAt) <= Date.now()) {
        sendJson(response, 409, { code: "job_conflict", message: "Agent does not hold the active job lease" });
        return;
      }

      const jobPayload = isRecord(job.payload) ? job.payload : {};
      const inventoryJob = job.type === "restic-inventory";
      const browseJob = job.type === "restic-browse";
      const expectedRepositoryId = (inventoryJob || browseJob) && typeof jobPayload.repositoryId === "string"
        ? jobPayload.repositoryId
        : undefined;
      const expectedSnapshotId = browseJob && typeof jobPayload.snapshotId === "string"
        ? jobPayload.snapshotId
        : undefined;
      const expectedPath = browseJob && typeof jobPayload.path === "string"
        ? jobPayload.path
        : undefined;
      const accepted = await recordRuntimeEvents(db, {
        jobId,
        attempt: job.attempt,
        agentId: agent.id,
        events: body.events,
        expectedRepositoryId,
        expectedSnapshotId,
        expectedPath,
      });
      await agentStore.touch(agent.id, new Date());
      sendJson(response, 202, { accepted });
      return;
    }

    const runtimeReadMatch = path.match(/^\/v1\/local\/jobs\/([^/]+)\/runtime$/);
    if (request.method === "GET" && runtimeReadMatch) {
      const jobId = decodePathPart(runtimeReadMatch[1]);
      const job = await new D1JobRepository(db).get(jobId);
      if (!job) {
        sendJson(response, 404, { code: "job_not_found", message: `Job not found: ${jobId}` });
        return;
      }
      sendJson(response, 200, await getRuntimeTelemetry(db, jobId, job.attempt, {
        logLimit: requestUrl.searchParams.get("logs") ?? 200,
      }));
      return;
    }

    const eventsMatch = path.match(/^\/v1\/local\/jobs\/([^/]+)\/events$/);
    if (request.method === "GET" && eventsMatch) {
      const jobId = decodePathPart(eventsMatch[1]);
      const repository = new D1JobRepository(db);
      const job = await repository.get(jobId);
      if (!job) {
        sendJson(response, 404, { code: "job_not_found", message: `Job not found: ${jobId}` });
        return;
      }
      sendJson(response, 200, { events: await repository.listEvents(jobId) });
      return;
    }

    const jobMatch = path.match(/^\/v1\/local\/jobs\/([^/]+)$/);
    if (request.method === "GET" && jobMatch) {
      const jobId = decodePathPart(jobMatch[1]);
      const job = await new D1JobRepository(db).get(jobId);
      if (!job) {
        sendJson(response, 404, { code: "job_not_found", message: `Job not found: ${jobId}` });
        return;
      }
      const { token: _token, ...safeLease } = job.lease ?? {};
      sendJson(response, 200, { job: { ...job, lease: job.lease ? safeLease : null } });
      return;
    }

    const webRequest = await toWebRequest(request);
    const webResponse = await api.fetch(webRequest, env);
    await fromWebResponse(webResponse, response);
  } catch (error) {
    log("error", "request failed", { error: serializeError(error) });
    const status = Number.isInteger(error?.statusCode)
      ? error.statusCode
      : error instanceof RangeError ? 400 : 500;
    sendJson(response, status, {
      code: status === 413 ? "payload_too_large" : status === 404 ? "not_found" : status === 409 ? "conflict" : status < 500 ? "validation_error" : "internal_error",
      message: status === 413 ? "Request body exceeds 1 MiB" : status < 500 ? error.message : "Internal server error",
    });
  }
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, host, resolve);
});
log("info", "local control plane online", { host, port, databasePath, agentId, schedulerIntervalMs });

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log("info", "shutdown requested", { signal });
  clearInterval(recoveryTimer);
  clearInterval(schedulerTimer);
  await new Promise((resolve) => server.close(resolve));
  db.close();
  log("info", "local control plane stopped");
}
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

async function serveStatic(path, response) {
  const [file, contentType] = STATIC_FILES.get(path);
  const content = await readFile(join(webDir, file));
  response.statusCode = 200;
  response.setHeader("content-type", contentType);
  response.setHeader("cache-control", path === "/" || path === "/index.html" ? "no-store" : "public, max-age=300");
  response.setHeader("x-content-type-options", "nosniff");
  response.end(content);
}

async function toWebRequest(request, { path, authorization } = {}) {
  const protocol = request.headers["x-forwarded-proto"] || "http";
  const hostHeader = request.headers.host || `127.0.0.1:${port}`;
  const url = new URL(`${protocol}://${hostHeader}${request.url || "/"}`);
  if (path) {
    url.pathname = path;
    url.search = "";
  }
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else headers.set(name, value);
  }
  if (authorization) headers.set("authorization", authorization);
  const method = request.method || "GET";
  const body = method === "GET" || method === "HEAD" ? undefined : await readBody(request, 1_048_576);
  return new Request(url, { method, headers, ...(body === undefined ? {} : { body }) });
}

async function readJsonBody(request) {
  const body = await readBody(request, 1_048_576);
  if (body === undefined) throw new RangeError("JSON body is required");
  let value;
  try {
    value = JSON.parse(body.toString("utf8"));
  } catch {
    throw new RangeError("Malformed JSON body");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RangeError("JSON body must be an object");
  }
  return value;
}

async function readBody(request, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error("Request body too large");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return chunks.length === 0 ? undefined : Buffer.concat(chunks);
}

async function fromWebResponse(webResponse, response) {
  response.statusCode = webResponse.status;
  for (const [name, value] of webResponse.headers.entries()) response.setHeader(name, value);
  response.setHeader("cache-control", "no-store");
  if (!webResponse.body) {
    response.end();
    return;
  }
  response.end(Buffer.from(await webResponse.arrayBuffer()));
}

async function ensureSecret(path) {
  try {
    const existing = (await readFile(path, "utf8")).trim();
    if (existing) return existing;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await mkdir(dirname(path), { recursive: true });
  const token = randomBytes(32).toString("base64url");
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${token}\n`, { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
  return token;
}

async function mirrorSecret(secret, path) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${secret}\n`, { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

function sendJson(response, status, value) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.end(JSON.stringify(value));
}

function bearerToken(request) {
  const header = Array.isArray(request.headers.authorization)
    ? request.headers.authorization[0]
    : request.headers.authorization;
  if (typeof header !== "string") return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function requireBodyString(value, name, min, max) {
  if (typeof value !== "string") throw new RangeError(`${name} must be a string`);
  const normalized = value.trim();
  if (normalized.length < min || normalized.length > max) {
    throw new RangeError(`${name} must be ${min}-${max} characters`);
  }
  return normalized;
}

function constantTimeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    diff |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return diff === 0;
}

function decodePathPart(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function statusError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function serializeError(error) {
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { name: "Error", message: String(error) };
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function log(level, message, data = {}) {
  const line = JSON.stringify({ at: new Date().toISOString(), level, component: "nexus-backup-local", message, ...data });
  if (level === "error") console.error(line);
  else console.log(line);
}
