import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createManagedDeviceService } from "../lib/managed-devices.mjs";
import { createWorkstationService } from "../lib/workstations.mjs";
import { openSqliteD1 } from "../lib/sqlite-d1.mjs";

const migrationsDir = fileURLToPath(new URL("../../../migrations/", import.meta.url));

async function fixture({ integrityCapability = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "nexus-workstation-integrity-"));
  const db = await openSqliteD1({ filename: join(dir, "backup.sqlite"), migrationsDir });
  let now = new Date("2026-09-13T15:00:00.000Z");
  let runNumber = 0;
  let tokenNumber = 0;
  const devices = createManagedDeviceService({
    db,
    now: () => new Date(now),
    id: () => "device-integrity-1",
    token: () => `nxbdev_${String(++tokenNumber).padStart(48, "x")}`,
  });
  const service = createWorkstationService({
    db,
    deviceService: devices,
    now: () => new Date(now),
    id: () => `wsrun-integrity-${++runNumber}`,
    leaseToken: () => `nxbws_${String(runNumber).padStart(32, "z")}`,
    leaseMs: 60_000,
  });
  const created = await devices.create({ name: "Balder PC", kind: "workstation" });
  const capabilities = [
    "workstation.backup.v1",
    "workstation.recovery.v1",
    "workstation.restore-staging.v1",
    "restic.v1",
    ...(integrityCapability ? ["workstation.integrity.v1"] : []),
  ];
  const bootstrap = await devices.report(created.token, {
    version: "0.8.0",
    hostname: "balder-pc",
    platform: "windows/amd64",
    capabilities,
  });
  const token = bootstrap.deviceToken;
  await service.reportStatus(token, { repositoryConfigured: true, repositoryKind: "local", agentState: "idle" });
  return {
    dir, db, devices, service, token, device: bootstrap.device, capabilities,
    setNow(value) { now = new Date(value); },
    async touch() {
      await devices.report(token, { version: "0.8.0", hostname: "balder-pc", platform: "windows/amd64", capabilities });
    },
    async close() { db.close(); await rm(dir, { recursive: true, force: true }); },
  };
}

test("workstation integrity requires an explicitly capable agent", async () => {
  const f = await fixture({ integrityCapability: false });
  try {
    await assert.rejects(
      () => f.service.queueRecovery(f.device.id, "check", {}),
      /does not support repository integrity checks/,
    );
  } finally { await f.close(); }
});

test("workstation integrity is leased, validated and exposed as latest check", async () => {
  const f = await fixture();
  try {
    const queued = await f.service.queueRecovery(f.device.id, "check", {});
    assert.equal(queued.operation, "check");
    assert.deepEqual(queued.request, {});

    const leased = (await f.service.poll(f.token)).run;
    assert.equal(leased.id, queued.id);
    assert.equal(leased.operation, "check");

    await assert.rejects(
      () => f.service.finish(f.token, leased.id, {
        leaseToken: leased.leaseToken,
        status: "success",
        result: { operation: "check", integrity: "unknown" },
      }),
      /integrity check result must report ok/,
    );

    const completed = await f.service.finish(f.token, leased.id, {
      leaseToken: leased.leaseToken,
      status: "success",
      result: { operation: "check", integrity: "ok" },
    });
    assert.equal(completed.state, "completed");
    assert.deepEqual(completed.result, { operation: "check", integrity: "ok" });

    const latest = await f.service.getLatestCheck(f.device.id);
    assert.equal(latest.id, completed.id);
    assert.equal(latest.result.integrity, "ok");
  } finally { await f.close(); }
});

test("expired integrity lease requeues read-only work and rejects the stale worker", async () => {
  const f = await fixture();
  try {
    const queued = await f.service.queueRecovery(f.device.id, "check", {});
    const oldLease = (await f.service.poll(f.token)).run;
    assert.equal(oldLease.id, queued.id);

    f.setNow("2026-09-13T15:02:00.000Z");
    await f.touch();
    assert.equal(await f.service.recoverExpired(f.device.id), 1);
    assert.equal((await f.service.getRun(queued.id)).state, "queued");

    const newLease = (await f.service.poll(f.token)).run;
    assert.equal(newLease.id, queued.id);
    assert.notEqual(newLease.leaseToken, oldLease.leaseToken);

    await assert.rejects(
      () => f.service.finish(f.token, oldLease.id, {
        leaseToken: oldLease.leaseToken,
        status: "success",
        result: { operation: "check", integrity: "ok" },
      }),
      /lease is stale or invalid/,
    );

    const completed = await f.service.finish(f.token, newLease.id, {
      leaseToken: newLease.leaseToken,
      status: "success",
      result: { operation: "check", integrity: "ok" },
    });
    assert.equal(completed.state, "completed");
  } finally { await f.close(); }
});

test("integrity checks never overwrite successful backup history", async () => {
  const f = await fixture();
  try {
    await f.service.reportStatus(f.token, {
      repositoryConfigured: true,
      repositoryKind: "local",
      agentState: "idle",
      lastBackupAt: "2026-09-13T13:00:00Z",
      lastSuccessAt: "2026-09-13T13:00:00Z",
      lastSnapshotId: "abcdef1234567890",
    });

    await f.service.queueRecovery(f.device.id, "check", {});
    const leased = (await f.service.poll(f.token)).run;
    await f.service.finish(f.token, leased.id, {
      leaseToken: leased.leaseToken,
      status: "success",
      result: { operation: "check", integrity: "ok" },
    });

    const row = await f.db.prepare("SELECT * FROM workstation_status WHERE device_id=?").bind(f.device.id).first();
    assert.equal(row.last_backup_at, "2026-09-13T13:00:00.000Z");
    assert.equal(row.last_success_at, "2026-09-13T13:00:00.000Z");
    assert.equal(row.last_snapshot_id, "abcdef1234567890");
  } finally { await f.close(); }
});
