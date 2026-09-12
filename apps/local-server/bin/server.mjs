#!/usr/bin/env node
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApi, D1AgentStore } from "../../control-plane/dist/index.js";
import { openSqliteD1 } from "../lib/sqlite-d1.mjs";

const configDir = process.env.NEXUS_BACKUP_CONFIG_DIR?.trim() || "/config";
const runtimeDir = process.env.NEXUS_BACKUP_RUNTIME_DIR?.trim() || "/run/nexus-backup";
const databasePath = process.env.NEXUS_BACKUP_DB?.trim() || join(configDir, "nexus-backup.sqlite");
const migrationsDir = process.env.NEXUS_BACKUP_MIGRATIONS?.trim()
  || fileURLToPath(new URL("../../../migrations/", import.meta.url));
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

const server = createServer(async (request, response) => {
  try {
    if (request.url === "/" || request.url === "/index.html") {
      sendHtml(response, landingPage());
      return;
    }
    if (request.url === "/v1/local/info" && request.method === "GET") {
      sendJson(response, 200, { mode: "local", selfContained: true, remoteControl: "optional" });
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

async function toWebRequest(request) {
  const protocol = request.headers["x-forwarded-proto"] || "http";
  const hostHeader = request.headers.host || `127.0.0.1:${port}`;
  const url = `${protocol}://${hostHeader}${request.url || "/"}`;
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else headers.set(name, value);
  }
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
  response.end(JSON.stringify(value));
}

function sendHtml(response, html) {
  response.statusCode = 200;
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(html);
}

function landingPage() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nexus Backup</title><style>body{font-family:system-ui,sans-serif;background:#111827;color:#f9fafb;margin:0;display:grid;min-height:100vh;place-items:center}.card{max-width:680px;padding:32px;border:1px solid #374151;border-radius:18px;background:#1f2937}h1{margin:0 0 8px}p{color:#d1d5db;line-height:1.5}.ok{color:#86efac;font-weight:700}code{background:#111827;padding:2px 6px;border-radius:6px}</style></head>
<body><main class="card"><h1>Nexus Backup</h1><p class="ok">Local-first control plane is online.</p><p>This container owns the local API and SQLite database. The backup agent runs beside it and moves data directly between your storage endpoints. Cloudflare is not required.</p><p>The full M4 dashboard will replace this shell at the same address. Health endpoint: <code>/healthz</code>.</p></main></body></html>`;
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
