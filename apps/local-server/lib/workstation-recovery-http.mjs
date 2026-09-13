const RECOVERY_OPERATIONS = new Set(["check", "inventory", "browse", "restore-preview", "restore"]);
const SNAPSHOT_ID_RE = /^[0-9a-f]{8,64}$/i;
const WRITE_FORBIDDEN_FIELDS = ["targetId", "targetPath", "stagingPath", "destination", "overwrite", "delete"];

export function createWorkstationRecoveryHttp({ workstationService } = {}) {
  if (!workstationService) throw new TypeError("workstationService is required");

  function match(method, path) {
    const normalizedMethod = typeof method === "string" ? method.toUpperCase() : "GET";
    if (typeof path !== "string" || !path.startsWith("/v1/local/workstations/")) return null;

    let route = path.match(/^\/v1\/local\/workstations\/([^/]+)\/recovery\/check$/);
    if (route && (normalizedMethod === "GET" || normalizedMethod === "POST")) {
      return { kind: "check", method: normalizedMethod, deviceId: decodePathPart(route[1]) };
    }

    route = path.match(/^\/v1\/local\/workstations\/([^/]+)\/recovery\/inventory$/);
    if (route && (normalizedMethod === "GET" || normalizedMethod === "POST")) {
      return { kind: "inventory", method: normalizedMethod, deviceId: decodePathPart(route[1]) };
    }

    route = path.match(/^\/v1\/local\/workstations\/([^/]+)\/recovery\/runs\/([^/]+)$/);
    if (route && normalizedMethod === "GET") {
      return { kind: "run", method: normalizedMethod, deviceId: decodePathPart(route[1]), runId: decodePathPart(route[2]) };
    }

    route = path.match(/^\/v1\/local\/workstations\/([^/]+)\/recovery\/snapshots\/([^/]+)\/browse$/);
    if (route && (normalizedMethod === "GET" || normalizedMethod === "POST")) {
      return {
        kind: "browse", method: normalizedMethod,
        deviceId: decodePathPart(route[1]), snapshotId: normalizeSnapshotId(decodePathPart(route[2])),
      };
    }

    route = path.match(/^\/v1\/local\/workstations\/([^/]+)\/recovery\/snapshots\/([^/]+)\/preview$/);
    if (route && normalizedMethod === "POST") {
      return {
        kind: "preview", method: normalizedMethod,
        deviceId: decodePathPart(route[1]), snapshotId: normalizeSnapshotId(decodePathPart(route[2])),
      };
    }

    route = path.match(/^\/v1\/local\/workstations\/([^/]+)\/recovery\/snapshots\/([^/]+)\/restore$/);
    if (route && normalizedMethod === "POST") {
      return {
        kind: "restore", method: normalizedMethod,
        deviceId: decodePathPart(route[1]), snapshotId: normalizeSnapshotId(decodePathPart(route[2])),
      };
    }

    return null;
  }

  async function execute(route, { searchParams, body } = {}) {
    if (!route || typeof route !== "object") throw new TypeError("matched recovery route is required");

    if (route.kind === "check") {
      if (route.method === "GET") {
        return { status: 200, body: { check: await workstationService.getLatestCheck(route.deviceId) } };
      }
      return { status: 202, body: { run: await workstationService.queueRecovery(route.deviceId, "check", {}) } };
    }

    if (route.kind === "inventory") {
      if (route.method === "GET") {
        return { status: 200, body: { inventory: await workstationService.getRecoveryInventory(route.deviceId) } };
      }
      return { status: 202, body: { run: await workstationService.queueRecovery(route.deviceId, "inventory", {}) } };
    }

    if (route.kind === "run") {
      const run = await requireScopedRecoveryRun(workstationService, route.deviceId, route.runId);
      const restoreConfirmation = workstationRestoreConfirmation(run);
      return { status: 200, body: { run, restoreConfirmation } };
    }

    if (route.kind === "browse") {
      const path = route.method === "GET"
        ? queryValue(searchParams, "path") ?? "/"
        : bodyPath(body, "/");
      if (route.method === "GET") {
        return {
          status: 200,
          body: { browse: await workstationService.getRecoveryBrowse(route.deviceId, route.snapshotId, path) },
        };
      }
      return {
        status: 202,
        body: { run: await workstationService.queueRecovery(route.deviceId, "browse", { snapshotId: route.snapshotId, path }) },
      };
    }

    if (route.kind === "preview") {
      const path = bodyPath(body, "");
      return {
        status: 202,
        body: { run: await workstationService.queueRecovery(route.deviceId, "restore-preview", { snapshotId: route.snapshotId, path }) },
      };
    }

    if (route.kind === "restore") {
      const input = requireBody(body);
      rejectControlPlaneRestoreOptions(input);
      const previewRunId = requireString(input.previewRunId, "previewRunId", 1, 200);
      const preview = await requireScopedRecoveryRun(workstationService, route.deviceId, previewRunId, "restore-preview");
      const expected = workstationRestoreConfirmation(preview);
      if (!expected) throw statusError(409, "Restore preview must be completed successfully before write restore");
      if (input.confirmation !== expected) throw statusError(400, `Confirmation must exactly match: ${expected}`);
      return {
        status: 202,
        body: {
          run: await workstationService.queueRecovery(route.deviceId, "restore", {
            snapshotId: route.snapshotId,
            path: input.path ?? "",
            previewRunId,
          }),
        },
      };
    }

    throw statusError(404, "Workstation recovery route not found");
  }

  return { match, execute };
}

export function workstationRestoreConfirmation(run) {
  if (!run || run.operation !== "restore-preview" || run.state !== "completed" || run.result?.dryRun !== true) return null;
  const snapshotId = normalizeSnapshotId(run.request?.snapshotId);
  return `RESTORE ${snapshotId.slice(0, 8)}`;
}

async function requireScopedRecoveryRun(service, deviceId, runId, operation = null) {
  const run = await service.getRun(runId);
  if (!run || run.deviceId !== deviceId || !RECOVERY_OPERATIONS.has(run.operation) || (operation && run.operation !== operation)) {
    throw statusError(404, `Workstation recovery run not found: ${runId}`);
  }
  return run;
}

function rejectControlPlaneRestoreOptions(body) {
  const forbidden = WRITE_FORBIDDEN_FIELDS.find((field) => Object.prototype.hasOwnProperty.call(body, field));
  if (forbidden) {
    throw statusError(400, `${forbidden} cannot be supplied by the control plane; restore staging is generated locally by the workstation agent`);
  }
}

function bodyPath(body, fallback) {
  if (body === undefined || body === null) return fallback;
  const value = requireBody(body).path;
  return value === undefined || value === null ? fallback : value;
}

function requireBody(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new RangeError("JSON body must be an object");
  return value;
}

function queryValue(searchParams, name) {
  if (searchParams && typeof searchParams.get === "function") return searchParams.get(name);
  return null;
}

function normalizeSnapshotId(value) {
  if (typeof value !== "string" || !SNAPSHOT_ID_RE.test(value.trim())) throw new RangeError("snapshotId must be 8-64 hexadecimal characters");
  return value.trim().toLowerCase();
}

function requireString(value, name, min, max) {
  if (typeof value !== "string") throw new RangeError(`${name} must be a string`);
  const normalized = value.trim();
  if (normalized.length < min || normalized.length > max) throw new RangeError(`${name} must be ${min}-${max} characters`);
  return normalized;
}

function decodePathPart(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

function statusError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
