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

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "nexus-workstation-history-"));
  const db = await openSqliteD1({ filename: join(dir, "backup.sqlite"), migrationsDir });
  let now = new Date("2026-09-13T12:00:00.000Z");
  let runNumber = 0;
  let tokenNumber = 0;
  let leaseNumber = 0;
  const devices = createManagedDeviceService({
    db,
    now: () => new Date(now),
    id: () => "device-workstation-history",
    token: () => `nxbdev_${String(++tokenNumber).padStart(48, "x")}`,
  });
  const service = createWorkstationService({
    db,
    deviceService: devices,
    now: () => new Date(now),
    id: () => `wsrun-history-${++runNumber}`,
    leaseToken: () => `nxbws_${String(++leaseNumber).padStart(48, "x")}`,
    leaseMs: 60_000,
  });
  const created = await devices.create({ name: "History PC", kind: "workstation" });
  const bootstrap = await devices.report(created.token, {
    version: "test",
    hostname: "history-pc",
    platform: "windows/amd64",
    capabilities: ["workstation.backup.v1"],
  });
  await service.putPolicy(bootstrap.device.id, {
    enabled: true,
    sourcePaths: ["C:\\Data"],
    excludePatterns: [],
    schedule: { kind: "daily", time: "02:00" },
    timezone: "Europe/Copenhagen",
    retention: { keepDaily: 7, keepWeekly: 4, keepMonthly: 6 },
  });
  return {
    dir,
    db,
    service,
    token: bootstrap.deviceToken,
    device: bootstrap.device,
    setNow(value) { now = new Date(value); },
    async close() { db.close(); await rm(dir, { recursive: true, force: true }); },
  };
}

async function runBackup(f, { status, snapshotId, error = undefined }) {
  const queued = await f.service.runNow(f.device.id);
  const polled = await f.service.poll(f.token);
  assert.equal(polled.run.id, queued.id);
  await f.service.progress(f.token, queued.id, {
    leaseToken: polled.run.leaseToken,
    progress: { phase: "backing-up", percent: 50 },
  });
  return f.service.finish(f.token, queued.id, {
    leaseToken: polled.run.leaseToken,
    status,
    result: { snapshotId },
    ...(error === undefined ? {} : { error }),
  });
}

test("partial backup cannot replace last successful snapshot history", async () => {
  const f = await fixture();
  try {
    await runBackup(f, { status: "success", snapshotId: "aaaaaaaa11111111" });
    const afterSuccess = (await f.service.list())[0];
    assert.equal(afterSuccess.status.lastSnapshotId, "aaaaaaaa11111111");
    const successAt = afterSuccess.status.lastSuccessAt;
    assert.ok(successAt);
    assert.equal(afterSuccess.status.repositoryConfigured, true, "a successful backup proves repository configuration");

    f.setNow("2026-09-13T12:05:00.000Z");
    const partial = await runBackup(f, {
      status: "partial",
      snapshotId: "bbbbbbbb22222222",
      error: "some source files were unreadable",
    });
    assert.equal(partial.state, "partial");

    const afterPartial = (await f.service.list())[0];
    assert.equal(afterPartial.status.lastSuccessAt, successAt, "partial backup must not advance last-success time");
    assert.equal(afterPartial.status.lastSnapshotId, "aaaaaaaa11111111", "partial backup must not replace the last successful snapshot");
    assert.match(afterPartial.status.lastError, /unreadable/i);
  } finally {
    await f.close();
  }
});
