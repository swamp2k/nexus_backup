#!/usr/bin/env node
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSanitizedAgentConfig } from "../lib/dashboard-data.mjs";
import { confirmationPhrase, createLocalAuth } from "../lib/local-auth.mjs";
import { createManagedDeviceService } from "../lib/managed-devices.mjs";
import { assertRecentRestorePreview, normalizeRestoreScope, queueRestoreExecution } from "../lib/restore-execution.mjs";
import { openSqliteD1 } from "../lib/sqlite-d1.mjs";
import { createTransferCleanupService } from "../lib/transfer-cleanup.mjs";
import { createTransferGroupService } from "../lib/transfer-groups.mjs";
import { createTransferRuleService } from "../lib/transfer-rules.mjs";
import { createWorkstationRecoveryHttp } from "../lib/workstation-recovery-http.mjs";
import { createWorkstationService, workstationInstallCommand } from "../lib/workstations.mjs";

const publicHost = process.env.NEXUS_BACKUP_HOST?.trim() || "0.0.0.0";
const publicPort = positiveInteger(process.env.NEXUS_BACKUP_PORT ?? "8787", "NEXUS_BACKUP_PORT");
const internalPort = positiveInteger(process.env.NEXUS_BACKUP_INTERNAL_PORT ?? String(publicPort + 1), "NEXUS_BACKUP_INTERNAL_PORT");
const internalBase = `http://127.0.0.1:${internalPort}`;
const configDir = process.env.NEXUS_BACKUP_CONFIG_DIR?.trim() || "/config";
const databasePath = process.env.NEXUS_BACKUP_DB?.trim() || join(configDir, "nexus-backup.sqlite");
const migrationsDir = process.env.NEXUS_BACKUP_MIGRATIONS?.trim() || fileURLToPath(new URL("../../../migrations/", import.meta.url));
const webDir = process.env.NEXUS_BACKUP_WEB_DIR?.trim() || fileURLToPath(new URL("../web/", import.meta.url));
const agentConfigPath = process.env.NEXUS_BACKUP_AGENT_CONFIG?.trim() || "/agent-config/agent.json";
const transferSchedulerIntervalMs = positiveInteger(process.env.NEXUS_BACKUP_TRANSFER_INTERVAL_MS ?? "15000", "NEXUS_BACKUP_TRANSFER_INTERVAL_MS");
const workstationSchedulerIntervalMs = positiveInteger(process.env.NEXUS_BACKUP_WORKSTATION_INTERVAL_MS ?? "15000", "NEXUS_BACKUP_WORKSTATION_INTERVAL_MS");

process.env.NEXUS_BACKUP_HOST = "127.0.0.1";
process.env.NEXUS_BACKUP_PORT = String(internalPort);
await import("./server.mjs");

const db = await openSqliteD1({ filename: databasePath, migrationsDir });
const auth = await createLocalAuth({ configDir, log });
const deviceService = createManagedDeviceService({ db });
const workstationService = createWorkstationService({ db, deviceService });
const workstationRecoveryHttp = createWorkstationRecoveryHttp({ workstationService });
const transferService = createTransferRuleService({
  db,
  enqueueJob,
  loadAgentConfig: () => loadSanitizedAgentConfig(agentConfigPath),
});
const transferGroupService = createTransferGroupService({ db, enqueueJob });
const transferCleanupService = createTransferCleanupService({ db, enqueueJob });

let transferSchedulerRunning = false;
async function runTransferScheduler() {
  if (transferSchedulerRunning) return;
  transferSchedulerRunning = true;
  try {
    const groups = await transferGroupService.runDue();
    if (groups.queued > 0) log("info", "completed torrent groups queued", { groups: groups.queued });
    for (const failure of groups.failures) log("error", "torrent group enqueue failed", failure);

    const result = await transferService.runDue();
    if (result.scans > 0 || result.transfers > 0) log("info", "transfer scheduler queued work", { scans: result.scans, transfers: result.transfers });
    for (const failure of result.failures) log("error", "transfer scheduler action failed", failure);

    const cleanup = await transferCleanupService.runDue();
    if (cleanup.queued > 0 || cleanup.reconciled > 0) log("info", "transfer cleanup scheduler updated work", { queued: cleanup.queued, reconciled: cleanup.reconciled });
    for (const failure of cleanup.failures) log("error", "transfer cleanup scheduler action failed", failure);
  } catch (error) {
    log("error", "transfer scheduler failed", { error: serializeError(error) });
  } finally {
    transferSchedulerRunning = false;
  }
}
const transferTimer = setInterval(() => void runTransferScheduler(), transferSchedulerIntervalMs);
transferTimer.unref();
void runTransferScheduler();

let workstationSchedulerRunning = false;
async function runWorkstationScheduler() {
  if (workstationSchedulerRunning) return;
  workstationSchedulerRunning = true;
  try {
    const recovered = await workstationService.recoverExpired();
    if (recovered > 0) log("warn", "expired workstation runs requeued", { count: recovered });
    const result = await workstationService.runDue();
    if (result.queued > 0) log("info", "workstation backup runs queued", { count: result.queued });
    for (const failure of result.failures) log("error", "workstation scheduler action failed", failure);
  } catch (error) {
    log("error", "workstation scheduler failed", { error: serializeError(error) });
  } finally {
    workstationSchedulerRunning = false;
  }
}
const workstationTimer = setInterval(() => void runWorkstationScheduler(), workstationSchedulerIntervalMs);
workstationTimer.unref();
void runWorkstationScheduler();

const PUBLIC_FILES = new Map([
  ["/auth.html", ["auth.html", "text/html; charset=utf-8"]],
  ["/auth.js", ["auth.js", "text/javascript; charset=utf-8"]],
  ["/auth.css", ["auth.css", "text/css; charset=utf-8"]],
  ["/favicon.svg", ["favicon.svg", "image/svg+xml"]],
  ["/install.ps1", ["install.ps1", "text/plain; charset=utf-8"]],
  ["/workstation/nexus-backup-workstation-windows-amd64.exe", ["workstation/nexus-backup-workstation-windows-amd64.exe", "application/octet-stream"]],
  ["/workstation/nexus-backup-workstation-windows-amd64.exe.sha256", ["workstation/nexus-backup-workstation-windows-amd64.exe.sha256", "text/plain; charset=utf-8"]],
  ["/workstation/restic.exe", ["workstation/restic.exe", "application/octet-stream"]],
  ["/workstation/restic.exe.sha256", ["workstation/restic.exe.sha256", "text/plain; charset=utf-8"]],
]);

const gateway = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host || `127.0.0.1:${publicPort}`}`);
    const path = url.pathname;

    if (request.method === "GET" && PUBLIC_FILES.has(path)) {
      await servePublic(path, response);
      return;
    }

    if (path === "/v1/local/auth/status" && request.method === "GET") {
      sendJson(response, 200, auth.status(request));
      return;
    }
    if (path === "/v1/local/auth/setup" && request.method === "POST") {
      const body = await readJsonBody(request);
      sendJson(response, 201, await auth.setup({ setupToken: body.setupToken, password: body.password, request, response }));
      return;
    }
    if (path === "/v1/local/auth/login" && request.method === "POST") {
      const body = await readJsonBody(request);
      sendJson(response, 200, await auth.login({ password: body.password, request, response }));
      return;
    }
    if (path === "/v1/local/auth/logout" && request.method === "POST") {
      const session = auth.requireSession(request);
      auth.requireCsrf(request, session);
      auth.logout(request, response);
      sendJson(response, 200, { authenticated: false });
      return;
    }

    if (path === "/v1/device/report" && request.method === "POST") {
      const body = await readJsonBody(request);
      sendJson(response, 200, await deviceService.report(requireBearerToken(request), body));
      return;
    }
    if (path === "/v1/device/workstation/status" && request.method === "POST") {
      sendJson(response, 200, await workstationService.reportStatus(requireBearerToken(request), await readJsonBody(request)));
      return;
    }
    if (path === "/v1/device/workstation/poll" && request.method === "POST") {
      await readJsonBody(request);
      sendJson(response, 200, await workstationService.poll(requireBearerToken(request)));
      return;
    }
    const workstationProgressMatch = path.match(/^\/v1\/device\/workstation\/runs\/([^/]+)\/progress$/);
    if (workstationProgressMatch && request.method === "PATCH") {
      sendJson(response, 200, { run: await workstationService.progress(requireBearerToken(request), decodePathPart(workstationProgressMatch[1]), await readJsonBody(request)) });
      return;
    }
    const workstationResultMatch = path.match(/^\/v1\/device\/workstation\/runs\/([^/]+)\/result$/);
    if (workstationResultMatch && request.method === "POST") {
      sendJson(response, 200, { run: await workstationService.finish(requireBearerToken(request), decodePathPart(workstationResultMatch[1]), await readJsonBody(request)) });
      return;
    }

    if (path === "/healthz" || path.startsWith("/v1/agent/")) {
      await proxy(request, response, url);
      return;
    }

    const session = auth.requireSession(request);
    if (isMutation(request.method) && path.startsWith("/v1/local/")) auth.requireCsrf(request, session);

    if (path === "/v1/local/info" && request.method === "GET") {
      const upstream = await fetch(`${internalBase}/v1/local/info`, { headers: { accept: "application/json" } });
      const data = await upstream.json().catch(() => ({}));
      if (!upstream.ok) throw statusError(upstream.status, data.message || `Local info failed with ${upstream.status}`);
      sendJson(response, 200, { ...data, localAuth: true, restoreExecution: true, transferRules: true, transferCleanup: true, transferTorrentGroups: true, deviceIntegration: true, workstationBackups: true, workstationRecovery: true, transferSchedulerIntervalMs, workstationSchedulerIntervalMs });
      return;
    }

    if (path === "/v1/local/devices" && request.method === "GET") {
      sendJson(response, 200, { devices: await deviceService.list() });
      return;
    }
    if (path === "/v1/local/devices" && request.method === "POST") {
      sendJson(response, 201, await deviceService.create(await readJsonBody(request)));
      return;
    }
    const deviceRotateMatch = path.match(/^\/v1\/local\/devices\/([^/]+)\/rotate-token$/);
    if (request.method === "POST" && deviceRotateMatch) {
      sendJson(response, 200, await deviceService.rotateToken(decodePathPart(deviceRotateMatch[1])));
      return;
    }
    const deviceMatch = path.match(/^\/v1\/local\/devices\/([^/]+)$/);
    if (deviceMatch && request.method === "PATCH") {
      sendJson(response, 200, { device: await deviceService.update(decodePathPart(deviceMatch[1]), await readJsonBody(request)) });
      return;
    }

    if (path === "/v1/local/workstations" && request.method === "GET") {
      sendJson(response, 200, { workstations: await workstationService.list() });
      return;
    }
    if (path === "/v1/local/workstations/enroll" && request.method === "POST") {
      const body = await readJsonBody(request);
      const created = await deviceService.create({ name: body.name, kind: "workstation" });
      const origin = requestOrigin(request, url);
      sendJson(response, 201, { ...created, installCommand: workstationInstallCommand(origin, created.token) });
      return;
    }
    const workstationPolicyMatch = path.match(/^\/v1\/local\/workstations\/([^/]+)\/policy$/);
    if (workstationPolicyMatch && request.method === "PUT") {
      sendJson(response, 200, { policy: await workstationService.putPolicy(decodePathPart(workstationPolicyMatch[1]), await readJsonBody(request)) });
      return;
    }
    const workstationRunMatch = path.match(/^\/v1\/local\/workstations\/([^/]+)\/run$/);
    if (workstationRunMatch && request.method === "POST") {
      sendJson(response, 202, { run: await workstationService.runNow(decodePathPart(workstationRunMatch[1])) });
      return;
    }
    const workstationRecoveryRoute = workstationRecoveryHttp.match(request.method, path);
    if (workstationRecoveryRoute) {
      const body = workstationRecoveryRoute.method === "POST" && workstationRecoveryRoute.kind !== "inventory"
        ? await readJsonBody(request)
        : undefined;
      const result = await workstationRecoveryHttp.execute(workstationRecoveryRoute, { searchParams: url.searchParams, body });
      sendJson(response, result.status, result.body);
      return;
    }

    if (path === "/v1/local/transfers" && request.method === "GET") {
      const config = await loadSanitizedAgentConfig(agentConfigPath);
      sendJson(response, 200, { rules: await transferService.list(), endpoints: config.endpoints ?? [], available: config.available });
      return;
    }
    if (path === "/v1/local/transfers" && request.method === "POST") {
      sendJson(response, 201, { rule: await transferService.create(await readJsonBody(request)) });
      return;
    }
    const transferScanMatch = path.match(/^\/v1\/local\/transfers\/([^/]+)\/scan$/);
    if (request.method === "POST" && transferScanMatch) {
      sendJson(response, 202, await transferService.scanNow(decodePathPart(transferScanMatch[1])));
      return;
    }
    const transferObjectsMatch = path.match(/^\/v1\/local\/transfers\/([^/]+)\/objects$/);
    if (request.method === "GET" && transferObjectsMatch) {
      const ruleId = decodePathPart(transferObjectsMatch[1]);
      sendJson(response, 200, { objects: await transferService.objects(ruleId, { limit: url.searchParams.get("limit") ?? 100 }) });
      return;
    }
    const transferMatch = path.match(/^\/v1\/local\/transfers\/([^/]+)$/);
    if (transferMatch) {
      const ruleId = decodePathPart(transferMatch[1]);
      if (request.method === "GET") {
        const rule = await transferService.get(ruleId);
        if (!rule) throw statusError(404, `Transfer rule not found: ${ruleId}`);
        sendJson(response, 200, { rule });
        return;
      }
      if (request.method === "PUT") {
        sendJson(response, 200, { rule: await transferService.update(ruleId, await readJsonBody(request)) });
        return;
      }
      if (request.method === "PATCH") {
        const body = await readJsonBody(request);
        sendJson(response, 200, { rule: await transferService.setEnabled(ruleId, body.enabled) });
        return;
      }
    }

    if (path === "/v1/local/restore-authorizations" && request.method === "POST") {
      const body = await readJsonBody(request);
      const scope = normalizeRestoreScope(body);
      const localConfig = await loadRestoreConfig(agentConfigPath);
      requireWriteTarget(scope.targetId, localConfig.restoreTargets);
      await assertRecentRestorePreview(db, scope);
      const expected = confirmationPhrase(scope);
      if (body.confirmation !== expected) throw statusError(400, `Confirmation must exactly match: ${expected}`);
      const grant = auth.issueRestoreGrant(session, scope);
      sendJson(response, 201, { authorizationToken: grant.token, expiresAt: grant.expiresAt, scope });
      return;
    }

    const restoreMatch = path.match(/^\/v1\/local\/repositories\/([^/]+)\/snapshots\/([^/]+)\/restore$/);
    if (request.method === "POST" && restoreMatch) {
      const body = await readJsonBody(request);
      const scope = normalizeRestoreScope({
        repositoryId: decodePathPart(restoreMatch[1]),
        snapshotId: decodePathPart(restoreMatch[2]),
        targetId: body.targetId,
        path: body.path,
      });
      const restoreAuthorization = singleHeader(request.headers["x-nexus-restore-authorization"]);
      auth.consumeRestoreGrant(session, restoreAuthorization, scope);
      const localConfig = await loadRestoreConfig(agentConfigPath);
      sendJson(response, 202, await queueRestoreExecution(db, {
        ...scope,
        repositories: localConfig.repositories,
        restoreTargets: localConfig.restoreTargets,
        enqueueJob,
      }));
      return;
    }

    if ((path === "/" || path === "/index.html") && request.method === "GET") {
      await proxy(request, response, url);
      return;
    }
    if (path.startsWith("/v1/local/") || (request.method === "GET" && !path.startsWith("/v1/"))) {
      await proxy(request, response, url);
      return;
    }

    sendJson(response, 404, { code: "not_found", message: "Not found" });
  } catch (error) {
    const status = Number.isInteger(error?.statusCode) ? error.statusCode : error instanceof RangeError ? 400 : 500;
    if (status >= 500) log("error", "gateway request failed", { error: serializeError(error) });
    if (status === 401 && acceptsHtml(request)) {
      response.statusCode = 302;
      response.setHeader("location", "/auth.html");
      response.setHeader("cache-control", "no-store");
      response.end();
      return;
    }
    sendJson(response, status, {
      code: status === 401 ? "unauthorized" : status === 403 ? "forbidden" : status === 429 ? "rate_limited" : status === 409 ? "conflict" : status < 500 ? "validation_error" : "internal_error",
      message: status < 500 ? error.message : "Internal server error",
    });
  }
});

await new Promise((resolve, reject) => {
  gateway.once("error", reject);
  gateway.listen(publicPort, publicHost, resolve);
});
log("info", "authenticated local gateway online", { host: publicHost, port: publicPort, internalPort });

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  clearInterval(transferTimer);
  clearInterval(workstationTimer);
  log("info", "gateway shutdown requested", { signal });
  await new Promise((resolve) => gateway.close(resolve));
  db.close();
}
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

async function enqueueJob(input) {
  const response = await fetch(`${internalBase}/v1/local/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(input),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw statusError(response.status, data.message || `Job enqueue failed with ${response.status}`);
  return data.job ?? data;
}

async function loadRestoreConfig(path) {
  let parsed;
  try { parsed = JSON.parse(await readFile(path, "utf8")); }
  catch { throw statusError(409, "Agent config is unavailable"); }
  const repositories = Array.isArray(parsed?.resticRepositories)
    ? parsed.resticRepositories.filter(isRecord).map((item) => ({ id: stringId(item.id) })).filter((item) => item.id)
    : [];
  const restoreTargets = Array.isArray(parsed?.restoreTargets)
    ? parsed.restoreTargets.filter(isRecord).map((item) => ({
        id: stringId(item.id),
        label: typeof item.label === "string" && item.label.trim() ? item.label.trim() : stringId(item.id),
        overwrite: ["always", "if-changed", "if-newer", "never"].includes(item.overwrite) ? item.overwrite : "never",
        writeEnabled: item.allowWrite === true,
      })).filter((item) => item.id)
    : [];
  return { repositories, restoreTargets };
}
function requireWriteTarget(id, targets) { const target = targets.find((candidate) => candidate.id === id); if (!target) throw statusError(404, `Restore target not found: ${id}`); if (!target.writeEnabled) throw statusError(403, `Restore target is preview-only: ${id}`); return target; }

async function servePublic(path, response) {
  const [file, contentType] = PUBLIC_FILES.get(path);
  const content = await readFile(join(webDir, file));
  response.statusCode = 200;
  response.setHeader("content-type", contentType);
  response.setHeader("cache-control", path === "/auth.html" || path === "/install.ps1" || path.startsWith("/workstation/") ? "no-store" : "public, max-age=300");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("content-security-policy", "default-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  response.end(content);
}

async function proxy(request, response, url) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || ["host", "connection", "content-length", "cookie", "x-nexus-csrf", "x-nexus-restore-authorization"].includes(name.toLowerCase())) continue;
    if (Array.isArray(value)) for (const item of value) headers.append(name, item); else headers.set(name, value);
  }
  const method = request.method || "GET";
  const body = method === "GET" || method === "HEAD" ? undefined : await readBody(request, 1_048_576);
  const target = new URL(`${url.pathname}${url.search}`, internalBase);
  const upstream = await fetch(target, { method, headers, ...(body === undefined ? {} : { body }) });
  response.statusCode = upstream.status;
  for (const [name, value] of upstream.headers.entries()) {
    if (["connection", "transfer-encoding", "set-cookie"].includes(name.toLowerCase())) continue;
    response.setHeader(name, value);
  }
  response.setHeader("cache-control", upstream.headers.get("cache-control") || "no-store");
  response.end(Buffer.from(await upstream.arrayBuffer()));
}

async function readJsonBody(request) {
  const body = await readBody(request, 1_048_576);
  if (!body) throw new RangeError("JSON body is required");
  let value;
  try { value = JSON.parse(body.toString("utf8")); } catch { throw new RangeError("Malformed JSON body"); }
  if (!isRecord(value)) throw new RangeError("JSON body must be an object");
  return value;
}
async function readBody(request, limit) { const chunks = []; let size = 0; for await (const chunk of request) { size += chunk.length; if (size > limit) throw statusError(413, "Request body exceeds 1 MiB"); chunks.push(chunk); } return chunks.length ? Buffer.concat(chunks) : undefined; }
function sendJson(response, status, value) { response.statusCode = status; response.setHeader("content-type", "application/json; charset=utf-8"); response.setHeader("cache-control", "no-store"); response.setHeader("x-content-type-options", "nosniff"); response.end(JSON.stringify(value)); }
function acceptsHtml(request) { const accept = singleHeader(request.headers.accept) || ""; return accept.includes("text/html") && (request.method === "GET" || request.method === "HEAD"); }
function isMutation(method) { return !["GET", "HEAD", "OPTIONS"].includes(method || "GET"); }
function singleHeader(value) { return Array.isArray(value) ? value[0] : typeof value === "string" ? value : null; }
function requireBearerToken(request) { const value = singleHeader(request.headers.authorization); const match = typeof value === "string" ? value.match(/^Bearer\s+(.+)$/i) : null; if (!match?.[1]) throw statusError(401, "Device bearer token is required"); return match[1]; }
function requestOrigin(request, url) { const proto = singleHeader(request.headers["x-forwarded-proto"])?.split(",")[0]?.trim() || url.protocol.replace(":", ""); const host = singleHeader(request.headers["x-forwarded-host"])?.split(",")[0]?.trim() || singleHeader(request.headers.host) || url.host; return `${proto}://${host}`; }
function decodePathPart(value) { try { return decodeURIComponent(value); } catch { return value; } }
function positiveInteger(value, name) { const parsed = Number(value); if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`); return parsed; }
function stringId(value) { return typeof value === "string" ? value.trim() : ""; }
function isRecord(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
function statusError(statusCode, message) { const error = new Error(message); error.statusCode = statusCode; return error; }
function serializeError(error) { return error instanceof Error ? { name: error.name, message: error.message } : { name: "Error", message: String(error) }; }
function log(level, message, data = {}) { const line = JSON.stringify({ at: new Date().toISOString(), level, component: "nexus-backup-gateway", message, ...data }); if (level === "error") console.error(line); else console.log(line); }
