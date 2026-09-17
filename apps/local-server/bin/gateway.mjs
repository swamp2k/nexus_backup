#!/usr/bin/env node
import { createServer } from "node:http";
import { createWriteStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, utimes } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSanitizedAgentConfig } from "../lib/dashboard-data.mjs";
import { createLocalAuth } from "../lib/local-auth.mjs";
import { createManagedDeviceService } from "../lib/managed-devices.mjs";
import { createRepositoryService } from "../lib/repositories.mjs";
import { createReceiverUserService } from "../lib/receiver-users.mjs";
import { createRemoteConnectionService } from "../lib/remote-connection.mjs";
import { resolvePublicOrigin } from "../lib/public-origin.mjs";
import { openSqliteD1 } from "../lib/sqlite-d1.mjs";
import { createTransferCleanupService } from "../lib/transfer-cleanup.mjs";
import { createTransferGroupService } from "../lib/transfer-groups.mjs";
import { createTransferRuleService } from "../lib/transfer-rules.mjs";
import { persistTransferDiscovery } from "../lib/transfer-rules.mjs";
import { createLocalRepositoryTransferExecutor, loadLocalRcloneConfig } from "../lib/local-repository-transfer.mjs";
import { createWorkstationService, workstationInstallCommand } from "../lib/workstations.mjs";

const publicHost = process.env.NEXUS_BACKUP_HOST?.trim() || "0.0.0.0";
const publicPort = positiveInteger(process.env.NEXUS_BACKUP_PORT ?? "8787", "NEXUS_BACKUP_PORT");
const internalPort = positiveInteger(process.env.NEXUS_BACKUP_INTERNAL_PORT ?? String(publicPort + 1), "NEXUS_BACKUP_INTERNAL_PORT");
const internalBase = `http://127.0.0.1:${internalPort}`;
const configDir = process.env.NEXUS_BACKUP_CONFIG_DIR?.trim() || "/config";
const databasePath = process.env.NEXUS_BACKUP_DB?.trim() || join(configDir, "nexus-backup.sqlite");
const migrationsDir = process.env.NEXUS_BACKUP_MIGRATIONS?.trim() || fileURLToPath(new URL("../../../migrations/", import.meta.url));
const webDir = process.env.NEXUS_BACKUP_WEB_DIR?.trim() || fileURLToPath(new URL("../web/", import.meta.url));
const integrationConfigPath = process.env.NEXUS_BACKUP_INTEGRATION_CONFIG?.trim() || "/config/integrations.json";
const backupRoot = process.env.NEXUS_BACKUP_BACKUP_ROOT?.trim() || "/backup";
const transferSchedulerIntervalMs = positiveInteger(process.env.NEXUS_BACKUP_TRANSFER_INTERVAL_MS ?? "15000", "NEXUS_BACKUP_TRANSFER_INTERVAL_MS");
const workstationSchedulerIntervalMs = positiveInteger(process.env.NEXUS_BACKUP_WORKSTATION_INTERVAL_MS ?? "15000", "NEXUS_BACKUP_WORKSTATION_INTERVAL_MS");
const configuredPublicOrigin = process.env.NEXUS_BACKUP_PUBLIC_URL?.trim()
  ? resolvePublicOrigin({ configured: process.env.NEXUS_BACKUP_PUBLIC_URL, host: null, fallbackHost: null })
  : null;

process.env.NEXUS_BACKUP_HOST = "127.0.0.1";
process.env.NEXUS_BACKUP_PORT = String(internalPort);
await import("./server.mjs");

const db = await openSqliteD1({ filename: databasePath, migrationsDir });
const auth = await createLocalAuth({ configDir, log });
const deviceService = createManagedDeviceService({ db });
const repositoryService = createRepositoryService({ db, backupRoot });
const receiverUserService = createReceiverUserService({ db, repositories: repositoryService });
const remoteConnectionService = createRemoteConnectionService({ db });
const workstationService = createWorkstationService({ db, deviceService, repositories: repositoryService, receiverUsers: receiverUserService });
const localRepositoryTransferExecutor = createLocalRepositoryTransferExecutor({
  db,
  repositories: repositoryService,
  enqueueJob,
  loadConfig: () => loadLocalRcloneConfig(integrationConfigPath),
});
const transferService = createTransferRuleService({
  db,
  enqueueJob,
  loadAgentConfig: () => loadSanitizedAgentConfig(integrationConfigPath),
  repositories: repositoryService,
  executeRepositoryTransfer: localRepositoryTransferExecutor.execute,
  executeRepositoryDiscovery: async (payload) => {
    const result = await localRepositoryTransferExecutor.executeDiscovery(payload);
    await persistTransferDiscovery(db, { jobId: result.job.id, expectedRuleId: payload.ruleId, event: result.event });
    return result;
  },
});
const transferGroupService = createTransferGroupService({ db, enqueueJob, executeRepositoryTransfer: localRepositoryTransferExecutor.execute });
const transferCleanupService = createTransferCleanupService({ db, enqueueJob, executeRepositoryCleanup: localRepositoryTransferExecutor.executeCleanup });

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
]);

const gateway = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host || `127.0.0.1:${publicPort}`}`);
    const path = url.pathname;

    if (!await remoteConnectionService.allowsHost(singleHeader(request.headers.host))) throw statusError(403, "Remote connection hostname is not allowed");

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
    if (path === "/v1/internal/receiver-auth" && request.method === "POST") {
      const remoteAddress = request.socket?.remoteAddress ?? "";
      if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remoteAddress)) throw statusError(404, "Not found");
      const body = await readJsonBody(request);
      const user = await receiverUserService.authenticate(body.username, body.password);
      const root = await receiverUserService.resolvePath(user.username, "");
      sendJson(response, 200, {
        status: 1,
        username: user.username,
        home_dir: root.absolute,
        uid: 0,
        gid: 0,
        permissions: { "/": ["*"], "/.nexus": [] },
        expiration_date: 0,
        external_auth_cache_time: 0,
      });
      return;
    }
    if (path === "/v1/device/workstation/status" && request.method === "POST") {
      sendJson(response, 200, await workstationService.reportStatus(requireBearerToken(request), await readJsonBody(request)));
      return;
    }
    if (path === "/v1/device/workstation/files" && (request.method === "PUT" || request.method === "HEAD")) {
      const device = await deviceService.authenticate(requireBearerToken(request));
      if (device.kind !== "workstation") throw statusError(403, "Device token is not a workstation token");
      const receiver = (await receiverUserService.list()).find((item) => item.workstationId === device.id && item.enabled);
      if (!receiver) throw statusError(409, "Workstation receiver identity is not configured");
      const relativePath = url.searchParams.get("path") ?? "";
      const target = await receiverUserService.resolvePath(receiver.username, relativePath);
      if (request.method === "HEAD") {
        const info = await stat(target.absolute).catch((error) => { if (error?.code === "ENOENT") return null; throw error; });
        if (!info?.isFile()) throw statusError(404, "Workstation file not found");
        response.statusCode = 200;
        response.setHeader("content-length", info.size);
        response.setHeader("x-nexus-source-mtime", info.mtime.toISOString());
        response.end();
        return;
      }
      await mkdir(dirname(target.absolute), { recursive: true });
      const temporary = `${target.absolute}.nexus-upload-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      try {
        await pipeline(request, createWriteStream(temporary, { flags: "wx", mode: 0o600 }));
        const handle = await open(temporary, "r"); await handle.sync(); await handle.close();
        await rename(temporary, target.absolute);
        const sourceMtime = Number(request.headers["x-nexus-source-mtime"]);
        if (Number.isFinite(sourceMtime) && sourceMtime > 0) await utimes(target.absolute, new Date(sourceMtime), new Date(sourceMtime));
        sendJson(response, 201, { uploaded: true, path: relativePath });
      } catch (error) { await rm(temporary, { force: true }).catch(() => {}); throw error; }
      return;
    }
    if (path === "/v1/device/workstation/repository-profile" && request.method === "GET") {
      const device = await deviceService.authenticate(requireBearerToken(request));
      if (device.kind !== "workstation") throw statusError(403, "Device token is not a workstation token");
      const workstation = (await workstationService.list()).find((item) => item.id === device.id);
      const receiver = (await receiverUserService.list()).find((item) => item.workstationId === device.id);
      if (!workstation?.policy?.repositoryId || !receiver) throw statusError(409, "Workstation repository is not configured");
      const receiverPassword = await receiverUserService.consumeBootstrapPassword(device.id);
      const authority = singleHeader(request.headers.host) || `127.0.0.1:${publicPort}`;
      const host = new URL(`http://${authority}`).hostname;
      sendJson(response, 200, {
        mode: "flat-file",
        transport: "webdav",
        receiverHost: host,
        receiverPort: publicPort,
        receiverUsername: receiver.username,
        ...(receiverPassword ? { receiverPassword } : {}),
        repositoryId: workstation.policy.repositoryId,
        destinationFolder: workstation.policy.destinationFolder || workstation.name,
      });
      return;
    }

    if (path === "/dav" || path.startsWith("/dav/")) {
      await proxyReceiverWebDav(request, response, path, url.search);
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
      // Source scans can contain a cached directory tree. Keep the endpoint bounded,
      // but allow substantially more than ordinary control-plane mutations.
      sendJson(response, 200, { run: await workstationService.finish(requireBearerToken(request), decodePathPart(workstationResultMatch[1]), await readJsonBody(request, 16 * 1024 * 1024)) });
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
      sendJson(response, 200, { ...data, localAuth: true, transferRules: true, transferCleanup: true, transferTorrentGroups: true, deviceIntegration: true, workstationBackups: true, transferSchedulerIntervalMs, workstationSchedulerIntervalMs });
      return;
    }
    if (path === "/v1/local/remote-connection" && request.method === "GET") {
      sendJson(response, 200, await remoteConnectionService.get());
      return;
    }
    if (path === "/v1/local/remote-connection" && request.method === "PUT") {
      sendJson(response, 200, await remoteConnectionService.update(await readJsonBody(request)));
      return;
    }

    if (path === "/v1/local/repositories" && request.method === "GET") {
      sendJson(response, 200, { repositories: await repositoryService.list() });
      return;
    }
    if (path === "/v1/local/repositories" && request.method === "POST") {
      sendJson(response, 201, { repository: await repositoryService.create(await readJsonBody(request)) });
      return;
    }
    if (path === "/v1/local/repositories/browse" && request.method === "GET") {
      sendJson(response, 200, await repositoryService.browse(url.searchParams.get("path") ?? ""));
      return;
    }
    if (path === "/v1/local/repositories/folders" && request.method === "POST") {
      const body = await readJsonBody(request);
      sendJson(response, 201, await repositoryService.createFolder(body.path ?? "", body));
      return;
    }
    if (path === "/v1/local/receiver-users" && request.method === "GET") {
      sendJson(response, 200, { users: await receiverUserService.list() });
      return;
    }
    if (path === "/v1/local/receiver-users" && request.method === "POST") {
      sendJson(response, 201, await receiverUserService.create(await readJsonBody(request)));
      return;
    }
    const receiverUserMatch = path.match(/^\/v1\/local\/receiver-users\/([^/]+)$/);
    if (receiverUserMatch && request.method === "PATCH") {
      const body = await readJsonBody(request);
      sendJson(response, 200, { user: await receiverUserService.setEnabled(decodePathPart(receiverUserMatch[1]), body.enabled) });
      return;
    }
    if (receiverUserMatch && request.method === "DELETE") {
      sendJson(response, 200, await receiverUserService.remove(decodePathPart(receiverUserMatch[1])));
      return;
    }
    const receiverResetMatch = path.match(/^\/v1\/local\/receiver-users\/([^/]+)\/reset-password$/);
    if (receiverResetMatch && request.method === "POST") {
      const body = await readJsonBody(request);
      sendJson(response, 200, await receiverUserService.resetPassword(decodePathPart(receiverResetMatch[1]), body.password));
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
    if (deviceMatch && request.method === "DELETE") {
      sendJson(response, 200, await deviceService.remove(decodePathPart(deviceMatch[1])));
      return;
    }

    if (path === "/v1/local/workstations" && request.method === "GET") {
      sendJson(response, 200, { workstations: await workstationService.list() });
      return;
    }
    if (path === "/v1/local/workstations/enroll" && request.method === "POST") {
      const body = await readJsonBody(request);
      if (!body.repositoryId) throw statusError(400, "repositoryId is required when enrolling a workstation");
      const repository = await repositoryService.get(body.repositoryId);
      if (!repository) throw statusError(404, "Repository not found");
      const created = await deviceService.create({ name: body.name, kind: "workstation" });
      const receiver = await receiverUserService.create({ username: body.name, repositoryId: repository.id, relativeSubpath: body.destinationFolder || body.name, kind: "workstation", workstationId: created.device.id });
      await workstationService.putPolicy(created.device.id, { enabled: false, sourcePaths: [], repositoryId: repository.id, destinationFolder: body.destinationFolder || body.name });
      const origin = resolvePublicOrigin({
        configured: configuredPublicOrigin,
        host: singleHeader(request.headers.host),
        fallbackHost: `127.0.0.1:${publicPort}`,
      });
      sendJson(response, 201, { ...created, receiver: { username: receiver.user.username }, repository, installCommand: workstationInstallCommand(origin, created.token) });
      return;
    }
    const workstationSourceScanMatch = path.match(/^\/v1\/local\/workstations\/([^/]+)\/source-scan$/);
    if (workstationSourceScanMatch && request.method === "GET") {
      sendJson(response, 200, await workstationService.getSourceScan(decodePathPart(workstationSourceScanMatch[1])));
      return;
    }
    if (workstationSourceScanMatch && request.method === "POST") {
      sendJson(response, 202, { run: await workstationService.queueSourceScan(decodePathPart(workstationSourceScanMatch[1]), await readJsonBody(request)) });
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
    if (path === "/v1/local/transfers" && request.method === "GET") {
      const config = await loadSanitizedAgentConfig(integrationConfigPath);
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

async function proxyReceiverWebDav(request, response, path, search) {
  const internalPort = process.env.NEXUS_BACKUP_WEBDAV_INTERNAL_PORT || "8383";
  const visiblePath = path === "/dav" ? "" : path.slice(5);
  // The public URL includes the receiver username for a stable client-facing
  // address. SFTPGo authenticates the Basic credentials and assigns the home
  // directory, so remove that display-only segment before proxying.
  const backendPath = visiblePath.includes("/") ? `/${visiblePath.slice(visiblePath.indexOf("/") + 1)}` : "/";
  const target = new URL(`${backendPath}${search}`, `http://127.0.0.1:${internalPort}`);
  const headers = { ...request.headers, host: target.host, "x-forwarded-prefix": "/dav" };
  delete headers.connection;
  const upstream = await fetch(target, {
    method: request.method,
    headers,
    body: ["GET", "HEAD"].includes(request.method) ? undefined : request,
    duplex: "half",
  });
  response.statusCode = upstream.status;
  for (const [name, value] of upstream.headers) if (!["connection", "transfer-encoding", "content-length"].includes(name.toLowerCase())) response.setHeader(name, value);
  if (!upstream.body) { response.end(); return; }
  await pipeline(upstream.body, response);
}

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

async function readJsonBody(request, limit = 1_048_576) {
  const body = await readBody(request, limit);
  if (!body) throw new RangeError("JSON body is required");
  let value;
  try { value = JSON.parse(body.toString("utf8")); } catch { throw new RangeError("Malformed JSON body"); }
  if (!isRecord(value)) throw new RangeError("JSON body must be an object");
  return value;
}
async function readBody(request, limit) { const chunks = []; let size = 0; for await (const chunk of request) { size += chunk.length; if (size > limit) throw statusError(413, `Request body exceeds ${Math.ceil(limit / 1_048_576)} MiB`); chunks.push(chunk); } return chunks.length ? Buffer.concat(chunks) : undefined; }
function sendJson(response, status, value) { response.statusCode = status; response.setHeader("content-type", "application/json; charset=utf-8"); response.setHeader("cache-control", "no-store"); response.setHeader("x-content-type-options", "nosniff"); response.end(JSON.stringify(value)); }
function acceptsHtml(request) { const accept = singleHeader(request.headers.accept) || ""; return accept.includes("text/html") && (request.method === "GET" || request.method === "HEAD"); }
function isMutation(method) { return !["GET", "HEAD", "OPTIONS"].includes(method || "GET"); }
function singleHeader(value) { return Array.isArray(value) ? value[0] : typeof value === "string" ? value : null; }
function requireBearerToken(request) { const value = singleHeader(request.headers.authorization); const match = typeof value === "string" ? value.match(/^Bearer\s+(.+)$/i) : null; if (!match?.[1]) throw statusError(401, "Device bearer token is required"); return match[1]; }
function decodePathPart(value) { try { return decodeURIComponent(value); } catch { return value; } }
function positiveInteger(value, name) { const parsed = Number(value); if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`); return parsed; }
function stringId(value) { return typeof value === "string" ? value.trim() : ""; }
function isRecord(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
function statusError(statusCode, message) { const error = new Error(message); error.statusCode = statusCode; return error; }
function serializeError(error) { return error instanceof Error ? { name: error.name, message: error.message } : { name: "Error", message: String(error) }; }
function log(level, message, data = {}) { const line = JSON.stringify({ at: new Date().toISOString(), level, component: "nexus-backup-gateway", message, ...data }); if (level === "error") console.error(line); else console.log(line); }
