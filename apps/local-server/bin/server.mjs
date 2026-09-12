#!/usr/bin/env node
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApi, D1AgentStore, D1JobRepository } from "../../control-plane/dist/index.js";
import { listAgents, listJobs, loadSanitizedAgentConfig } from "../lib/dashboard-data.mjs";
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

const recoveryTimer = setInterval(() => {
  api.recover(env).catch((error) => log("error", "lease recovery failed", { error: serializeError(error) }));
}, recoveryIntervalMs);
recoveryTimer.unref();

const STATIC_FILES = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
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
    sendJson(response, error?.statusCode === 413 ? 413 : 500, {
      code: error?.statusCode === 413 ? "payload_too_large" : "internal_error",
      message: error?.statusCode === 413 ? "Request body exceeds 1 MiB" : "Internal server error",
    });
  }
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, host, resolve);
});
log("info", "local control plane online", { host, port, databasePath, agentId });

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log("info", "shutdown requested", { signal });
  clearInterval(recoveryTimer);
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

function serializeError(error) {
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { name: "Error", message: String(error) };
}

function log(level, message, data = {}) {
  const line = JSON.stringify({ at: new Date().toISOString(), level, component: "nexus-backup-local", message, ...data });
  if (level === "error") console.error(line);
  else console.log(line);
}
