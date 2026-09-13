import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createManagedDeviceService } from "../lib/managed-devices.mjs";
import { createWorkstationService } from "../lib/workstations.mjs";
import { openSqliteD1 } from "../lib/sqlite-d1.mjs";

const migrationsDir = new URL("../../../migrations/", import.meta.url).pathname;

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "nexus-workstation-recovery-"));
  const db = await openSqliteD1({ filename: join(dir, "backup.sqlite"), migrationsDir });
  let now = new Date("2026-09-13T10:00:00.000Z");
  let runNumber = 0;
  let tokenNumber = 0;
  const devices = createManagedDeviceService({
    db,
    now: () => new Date(now),
    id: () => "device-recovery-1",
    token: () => `nxbdev_${String(++tokenNumber).padStart(48, "x")}`,
  });
  const service = createWorkstationService({
    db,
    deviceService: devices,
    now: () => new Date(now),
    id: () => `wsrun-${++runNumber}`,
    leaseToken: () => `nxbws_${String(runNumber).padStart(32, "y")}`,
    leaseMs: 60_000,
  });
  const created = await devices.create({ name: "Balder PC", kind: "workstation" });
  const bootstrap = await devices.report(created.token, {
    version: "0.7.0",
    hostname: "balder-pc",
    platform: "windows/amd64",
    capabilities: ["workstation.backup.v1", "workstation.recovery.v1", "workstation.restore-staging.v1", "restic.v1"],
  });
  const token = bootstrap.deviceToken;
  await service.reportStatus(token, { repositoryConfigured: true, repositoryKind: "sftp", agentState: "idle" });
  return {
    dir, db, devices, service, token, device: bootstrap.device,
    setNow(value) { now = new Date(value); },
    async touchDevice() {
      await devices.report(token, {
        version: "0.7.0", hostname: "balder-pc", platform: "windows/amd64",
        capabilities: ["workstation.backup.v1", "workstation.recovery.v1", "workstation.restore-staging.v1", "restic.v1"],
      });
    },
    async close() { db.close(); await rm(dir, { recursive: true, force: true }); },
  };
}

async function finishInventory(f) {
  const queued = await f.service.queueRecovery(f.device.id, "inventory", {});
  const leased = (await f.service.poll(f.token)).run;
  assert.equal(leased.id, queued.id);
  assert.equal(leased.operation, "inventory");
  await f.service.finish(f.token, leased.id, {
    leaseToken: leased.leaseToken,
    status: "success",
    result: {
      operation: "inventory",
      snapshots: [
        { id: "abcdef1234567890", shortId: "abcdef12", time: "2026-09-13T09:00:00Z", hostname: "balder-pc" },
      ],
    },
  });
  return queued;
}

async function finishRootBrowse(f) {
  const queued = await f.service.queueRecovery(f.device.id, "browse", { snapshotId: "abcdef1234567890", path: "/" });
  const leased = (await f.service.poll(f.token)).run;
  assert.equal(leased.operation, "browse");
  assert.deepEqual(leased.request, { snapshotId: "abcdef1234567890", path: "/" });
  await f.service.finish(f.token, leased.id, {
    leaseToken: leased.leaseToken,
    status: "success",
    result: {
      operation: "browse", snapshotId: "abcdef1234567890", path: "/", entryLimit: 128, truncated: false,
      entries: [
        { path: "/C", name: "C", nodeType: "dir", size: 0 },
        { path: "/readme.txt", name: "readme.txt", nodeType: "file", size: 12 },
      ],
    },
  });
  return queued;
}

test("workstation inventory and browse are bound to discovered snapshot paths", async () => {
  const f = await fixture();
  try {
    await finishInventory(f);
    const inventory = await f.service.getRecoveryInventory(f.device.id);
    assert.equal(inventory.snapshots.length, 1);
    assert.equal(inventory.snapshots[0].id, "abcdef1234567890");

    await assert.rejects(
      () => f.service.queueRecovery(f.device.id, "browse", { snapshotId: "abcdef1234567890", path: "/C/Users" }),
      /previously discovered as a directory/,
    );

    await finishRootBrowse(f);
    const cached = await f.service.getRecoveryBrowse(f.device.id, "abcdef1234567890", "/");
    assert.equal(cached.entries[0].path, "/C");

    const child = await f.service.queueRecovery(f.device.id, "browse", { snapshotId: "abcdef1234567890", path: "/C" });
    assert.equal(child.request.path, "/C");
  } finally { await f.close(); }
});

test("write restore requires a recent exact dry-run preview", async () => {
  const f = await fixture();
  try {
    await finishInventory(f);
    await finishRootBrowse(f);

    await assert.rejects(
      () => f.service.queueRecovery(f.device.id, "restore", { snapshotId: "abcdef1234567890", path: "/readme.txt", previewRunId: "wsrun-missing" }),
      /completed restore preview/,
    );

    const preview = await f.service.queueRecovery(f.device.id, "restore-preview", { snapshotId: "abcdef1234567890", path: "/readme.txt" });
    const leased = (await f.service.poll(f.token)).run;
    await f.service.finish(f.token, leased.id, {
      leaseToken: leased.leaseToken,
      status: "success",
      result: {
        operation: "restore-preview", snapshotId: "abcdef1234567890", path: "/readme.txt",
        stagingId: preview.id, dryRun: true, restored: 1, updated: 0, unchanged: 0, changedLogs: ["restored /readme.txt"],
      },
    });

    const restore = await f.service.queueRecovery(f.device.id, "restore", {
      snapshotId: "abcdef1234567890", path: "/readme.txt", previewRunId: preview.id,
    });
    assert.equal(restore.operation, "restore");
    assert.equal(restore.request.previewRunId, preview.id);

    const restoreLease = (await f.service.poll(f.token)).run;
    assert.equal(restoreLease.operation, "restore");
    assert.equal(restoreLease.request.path, "/readme.txt");
  } finally { await f.close(); }
});

test("expired write restore is failed and never automatically requeued", async () => {
  const f = await fixture();
  try {
    await finishInventory(f);
    await finishRootBrowse(f);
    const preview = await f.service.queueRecovery(f.device.id, "restore-preview", { snapshotId: "abcdef1234567890", path: "/readme.txt" });
    const previewLease = (await f.service.poll(f.token)).run;
    await f.service.finish(f.token, previewLease.id, {
      leaseToken: previewLease.leaseToken,
      status: "success",
      result: { operation: "restore-preview", snapshotId: "abcdef1234567890", path: "/readme.txt", stagingId: preview.id, dryRun: true, restored: 1, updated: 0, unchanged: 0 },
    });
    const restore = await f.service.queueRecovery(f.device.id, "restore", { snapshotId: "abcdef1234567890", path: "/readme.txt", previewRunId: preview.id });
    const leased = (await f.service.poll(f.token)).run;
    assert.equal(leased.id, restore.id);

    f.setNow("2026-09-13T10:02:00Z");
    const recovered = await f.service.recoverExpired();
    assert.equal(recovered, 1);
    const after = await f.service.getRun(restore.id);
    assert.equal(after.state, "failed");
    assert.match(after.error, /manual retry required/);
    const nextPoll = await f.service.poll(f.token);
    assert.equal(nextPoll.run, null);
  } finally { await f.close(); }
});

test("recovery does not overwrite workstation backup status", async () => {
  const f = await fixture();
  try {
    await f.service.reportStatus(f.token, {
      repositoryConfigured: true, repositoryKind: "sftp", agentState: "idle",
      lastBackupAt: "2026-09-13T08:00:00Z", lastSuccessAt: "2026-09-13T08:00:00Z", lastSnapshotId: "deadbeef1234",
    });
    await finishInventory(f);
    const row = await f.db.prepare("SELECT * FROM workstation_status WHERE device_id=?").bind(f.device.id).first();
    assert.equal(row.last_backup_at, "2026-09-13T08:00:00.000Z");
    assert.equal(row.last_snapshot_id, "deadbeef1234");
  } finally { await f.close(); }
});

test("stale preview cannot authorize a later write restore", async () => {
  const f = await fixture();
  try {
    await finishInventory(f);
    await finishRootBrowse(f);
    const preview = await f.service.queueRecovery(f.device.id, "restore-preview", { snapshotId: "abcdef1234567890", path: "/readme.txt" });
    const leased = (await f.service.poll(f.token)).run;
    await f.service.finish(f.token, leased.id, {
      leaseToken: leased.leaseToken,
      status: "success",
      result: { operation: "restore-preview", snapshotId: "abcdef1234567890", path: "/readme.txt", stagingId: preview.id, dryRun: true },
    });
    f.setNow("2026-09-13T10:31:01Z");
    await f.touchDevice();
    await assert.rejects(
      () => f.service.queueRecovery(f.device.id, "restore", { snapshotId: "abcdef1234567890", path: "/readme.txt", previewRunId: preview.id }),
      /older than 30 minutes/,
    );
  } finally { await f.close(); }
});
