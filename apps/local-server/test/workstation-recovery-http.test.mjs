import assert from "node:assert/strict";
import test from "node:test";
import { createWorkstationRecoveryHttp, workstationRestoreConfirmation } from "../lib/workstation-recovery-http.mjs";

function fixture() {
  const calls = [];
  const preview = {
    id: "wsrun-preview-1",
    deviceId: "device-1",
    state: "completed",
    operation: "restore-preview",
    request: { snapshotId: "abcdef1234567890", path: "/Users/Balder/save.dat" },
    result: { dryRun: true, restored: 1, updated: 0, unchanged: 0 },
  };
  const latestCheck = {
    id: "wsrun-check-1",
    deviceId: "device-1",
    state: "completed",
    operation: "check",
    request: {},
    result: { operation: "check", integrity: "ok" },
    finishedAt: "2026-09-13T15:00:00.000Z",
  };
  const workstationService = {
    async getLatestCheck(deviceId) {
      calls.push(["check-get", deviceId]);
      return deviceId === "device-1" ? latestCheck : null;
    },
    async getRecoveryInventory(deviceId) {
      calls.push(["inventory-get", deviceId]);
      return { deviceId, snapshots: [{ id: "abcdef1234567890" }] };
    },
    async getRecoveryBrowse(deviceId, snapshotId, path) {
      calls.push(["browse-get", deviceId, snapshotId, path]);
      return { deviceId, snapshotId, path, entries: [] };
    },
    async getRun(runId) {
      calls.push(["run-get", runId]);
      return runId === preview.id ? preview : null;
    },
    async queueRecovery(deviceId, operation, input) {
      calls.push(["queue", deviceId, operation, input]);
      return { id: `queued-${operation}`, deviceId, operation, request: input, state: "queued" };
    },
  };
  return { calls, preview, latestCheck, api: createWorkstationRecoveryHttp({ workstationService }) };
}

test("integrity HTTP route exposes latest result and queues an isolated workstation check", async () => {
  const f = fixture();
  const getRoute = f.api.match("GET", "/v1/local/workstations/device-1/recovery/check");
  assert.deepEqual(getRoute, { kind: "check", method: "GET", deviceId: "device-1" });
  const current = await f.api.execute(getRoute);
  assert.equal(current.status, 200);
  assert.equal(current.body.check.result.integrity, "ok");
  assert.deepEqual(f.calls.at(-1), ["check-get", "device-1"]);

  const postRoute = f.api.match("POST", "/v1/local/workstations/device-1/recovery/check");
  const queued = await f.api.execute(postRoute, { body: {} });
  assert.equal(queued.status, 202);
  assert.equal(queued.body.run.operation, "check");
  assert.deepEqual(f.calls.at(-1), ["queue", "device-1", "check", {}]);
});

test("recovery HTTP routes expose inventory and cached browse without inventing target paths", async () => {
  const f = fixture();
  const inventoryRoute = f.api.match("GET", "/v1/local/workstations/device-1/recovery/inventory");
  assert.deepEqual(inventoryRoute, { kind: "inventory", method: "GET", deviceId: "device-1" });
  const inventory = await f.api.execute(inventoryRoute);
  assert.equal(inventory.status, 200);
  assert.equal(inventory.body.inventory.snapshots[0].id, "abcdef1234567890");

  const browseRoute = f.api.match("GET", "/v1/local/workstations/device-1/recovery/snapshots/ABCDEF1234567890/browse");
  const browse = await f.api.execute(browseRoute, { searchParams: new URLSearchParams({ path: "/Users" }) });
  assert.equal(browse.status, 200);
  assert.equal(browse.body.browse.path, "/Users");
  assert.deepEqual(f.calls.at(-1), ["browse-get", "device-1", "abcdef1234567890", "/Users"]);
});

test("completed dry-run preview exposes a short typed confirmation", async () => {
  const f = fixture();
  assert.equal(workstationRestoreConfirmation(f.preview), "RESTORE abcdef12");
  const route = f.api.match("GET", `/v1/local/workstations/device-1/recovery/runs/${f.preview.id}`);
  const result = await f.api.execute(route);
  assert.equal(result.status, 200);
  assert.equal(result.body.restoreConfirmation, "RESTORE abcdef12");
});

test("write restore requires exact confirmation and keeps preview binding in the queued request", async () => {
  const f = fixture();
  const route = f.api.match("POST", "/v1/local/workstations/device-1/recovery/snapshots/abcdef1234567890/restore");

  await assert.rejects(
    () => f.api.execute(route, { body: { path: "/Users/Balder/save.dat", previewRunId: f.preview.id, confirmation: "RESTORE nope" } }),
    /Confirmation must exactly match: RESTORE abcdef12/,
  );

  const result = await f.api.execute(route, {
    body: { path: "/Users/Balder/save.dat", previewRunId: f.preview.id, confirmation: "RESTORE abcdef12" },
  });
  assert.equal(result.status, 202);
  assert.deepEqual(f.calls.at(-1), ["queue", "device-1", "restore", {
    snapshotId: "abcdef1234567890",
    path: "/Users/Balder/save.dat",
    previewRunId: f.preview.id,
  }]);
});

test("write restore refuses destination, overwrite and delete controls from the browser", async () => {
  for (const unsafe of [
    { targetPath: "C:\\Users\\Balder" },
    { stagingPath: "C:\\restore" },
    { targetId: "desktop" },
    { overwrite: "always" },
    { delete: true },
  ]) {
    const f = fixture();
    const route = f.api.match("POST", "/v1/local/workstations/device-1/recovery/snapshots/abcdef1234567890/restore");
    await assert.rejects(
      () => f.api.execute(route, { body: {
        path: "/Users/Balder/save.dat",
        previewRunId: f.preview.id,
        confirmation: "RESTORE abcdef12",
        ...unsafe,
      } }),
      /cannot be supplied by the control plane/,
    );
    assert.equal(f.calls.some((entry) => entry[0] === "queue"), false);
  }
});

test("a preview from another workstation cannot authorize restore", async () => {
  const f = fixture();
  const route = f.api.match("POST", "/v1/local/workstations/device-2/recovery/snapshots/abcdef1234567890/restore");
  await assert.rejects(
    () => f.api.execute(route, { body: { path: "/Users/Balder/save.dat", previewRunId: f.preview.id, confirmation: "RESTORE abcdef12" } }),
    /Workstation recovery run not found/,
  );
});
