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
  const dir = await mkdtemp(join(tmpdir(), "nexus-workstation-torture-"));
  const db = await openSqliteD1({ filename: join(dir, "backup.sqlite"), migrationsDir });
  let now = new Date("2026-09-13T10:00:00.000Z");
  let runNumber = 0;
  let tokenNumber = 0;
  let leaseNumber = 0;

  const devices = createManagedDeviceService({
    db,
    now: () => new Date(now),
    id: () => "device-torture-1",
    token: () => `nxbdev_${String(++tokenNumber).padStart(48, "x")}`,
  });

  const makeService = () => createWorkstationService({
    db,
    deviceService: devices,
    now: () => new Date(now),
    id: () => `wsrun-torture-${++runNumber}`,
    leaseToken: () => `nxbws_${String(++leaseNumber).padStart(32, "y")}`,
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
  const service = makeService();
  await service.reportStatus(token, {
    repositoryConfigured: true,
    repositoryKind: "sftp",
    agentState: "idle",
  });

  return {
    dir,
    db,
    devices,
    service,
    makeService,
    token,
    device: bootstrap.device,
    setNow(value) { now = new Date(value); },
    async touchDevice() {
      await devices.report(token, {
        version: "0.7.0",
        hostname: "balder-pc",
        platform: "windows/amd64",
        capabilities: ["workstation.backup.v1", "workstation.recovery.v1", "workstation.restore-staging.v1", "restic.v1"],
      });
    },
    async close() {
      db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

const policy = {
  enabled: true,
  sourcePaths: ["C:\\Users\\Balder\\Documents"],
  excludePatterns: ["**/Cache/**"],
  schedule: { kind: "daily", time: "02:00" },
  timezone: "Europe/Copenhagen",
  retention: { keepDaily: 7, keepWeekly: 4, keepMonthly: 6 },
};

test("expired running backup does not leave workstation status pointing at a dead lease", async () => {
  const f = await fixture();
  try {
    await f.service.putPolicy(f.device.id, policy);
    const queued = await f.service.runNow(f.device.id);
    const leased = (await f.service.poll(f.token)).run;
    await f.service.progress(f.token, queued.id, {
      leaseToken: leased.leaseToken,
      progress: { phase: "backing-up", percent: 25 },
    });

    let status = await f.db.prepare("SELECT agent_state,current_run_id FROM workstation_status WHERE device_id=?").bind(f.device.id).first();
    assert.equal(status.agent_state, "running");
    assert.equal(status.current_run_id, queued.id);

    f.setNow("2026-09-13T10:02:00.000Z");
    assert.equal(await f.service.recoverExpired(), 1);

    const run = await f.service.getRun(queued.id);
    assert.equal(run.state, "queued");

    status = await f.db.prepare("SELECT agent_state,current_run_id FROM workstation_status WHERE device_id=?").bind(f.device.id).first();
    assert.equal(status.current_run_id, null, "expired lease must not remain the workstation current run");
    assert.notEqual(status.agent_state, "running", "expired lease must not leave workstation marked running");
  } finally {
    await f.close();
  }
});

test("controller recreation preserves an unexpired lease and recovers it only after timeout", async () => {
  const f = await fixture();
  try {
    await f.service.putPolicy(f.device.id, policy);
    const queued = await f.service.runNow(f.device.id);
    const firstLease = (await f.service.poll(f.token)).run;
    assert.equal(firstLease.id, queued.id);
    assert.equal(firstLease.state, "leased");

    const restarted = f.makeService();
    const beforeExpiry = await restarted.getRun(queued.id);
    assert.equal(beforeExpiry.state, "leased");
    assert.equal(await restarted.recoverExpired(), 0);

    f.setNow("2026-09-13T10:02:00.000Z");
    assert.equal(await restarted.recoverExpired(), 1);
    const afterExpiry = await restarted.getRun(queued.id);
    assert.equal(afterExpiry.state, "queued");

    const secondLease = (await restarted.poll(f.token)).run;
    assert.equal(secondLease.id, queued.id);
    assert.notEqual(secondLease.leaseToken, firstLease.leaseToken);
    await assert.rejects(
      () => restarted.progress(f.token, queued.id, {
        leaseToken: firstLease.leaseToken,
        progress: { phase: "stale-worker" },
      }),
      /stale or invalid/,
    );
  } finally {
    await f.close();
  }
});

test("offline workstation rejects recovery while ordinary backup work can remain queued", async () => {
  const f = await fixture();
  try {
    await f.service.putPolicy(f.device.id, policy);
    f.setNow("2026-09-13T10:04:01.000Z");

    await assert.rejects(
      () => f.service.queueRecovery(f.device.id, "inventory", {}),
      /must be online/,
    );

    const queued = await f.service.runNow(f.device.id);
    assert.equal(queued.state, "queued");
    assert.equal((await f.service.getRun(queued.id)).state, "queued");
  } finally {
    await f.close();
  }
});

test("a due scheduled backup is deferred, not lost, while recovery owns the workstation", async () => {
  const f = await fixture();
  try {
    await f.service.putPolicy(f.device.id, policy);
    const recovery = await f.service.queueRecovery(f.device.id, "inventory", {});
    assert.equal(recovery.state, "queued");

    const dueAt = "2026-09-13T09:59:00.000Z";
    await f.db.prepare("UPDATE workstation_policies SET next_run_at=? WHERE device_id=?").bind(dueAt, f.device.id).run();

    const blocked = await f.service.runDue();
    assert.equal(blocked.queued, 0);
    assert.deepEqual(blocked.failures, []);
    const blockedPolicy = await f.service.getPolicy(f.device.id);
    assert.equal(blockedPolicy.nextRunAt, dueAt, "busy workstation must keep the due schedule pending");

    const lease = (await f.service.poll(f.token)).run;
    assert.equal(lease.operation, "inventory");
    await f.service.finish(f.token, lease.id, {
      leaseToken: lease.leaseToken,
      status: "success",
      result: { operation: "inventory", snapshots: [] },
    });

    const afterRecovery = await f.service.runDue();
    assert.equal(afterRecovery.queued, 1);
    const next = await f.service.poll(f.token);
    assert.equal(next.run.operation, "backup");
  } finally {
    await f.close();
  }
});
