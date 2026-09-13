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

test("a failed integrity check records failed state without claiming integrity ok", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nexus-workstation-integrity-failure-"));
  const db = await openSqliteD1({ filename: join(dir, "backup.sqlite"), migrationsDir });
  try {
    let tokenNumber = 0;
    const devices = createManagedDeviceService({
      db,
      now: () => new Date("2026-09-13T15:00:00Z"),
      id: () => "device-integrity-failure",
      token: () => `nxbdev_${String(++tokenNumber).padStart(48, "f")}`,
    });
    const service = createWorkstationService({
      db,
      deviceService: devices,
      now: () => new Date("2026-09-13T15:00:00Z"),
      id: () => "wsrun-integrity-failure",
      leaseToken: () => "nxbws_abcdefghijklmnopqrstuvwxyz012345",
      leaseMs: 60_000,
    });
    const created = await devices.create({ name: "Balder PC", kind: "workstation" });
    const report = await devices.report(created.token, {
      version: "0.8.0",
      hostname: "balder-pc",
      platform: "windows/amd64",
      capabilities: ["workstation.recovery.v1", "workstation.integrity.v1", "restic.v1"],
    });
    const token = report.deviceToken;
    await service.reportStatus(token, { repositoryConfigured: true, repositoryKind: "local", agentState: "idle" });
    await service.queueRecovery(report.device.id, "check", {});
    const leased = (await service.poll(token)).run;

    const failed = await service.finish(token, leased.id, {
      leaseToken: leased.leaseToken,
      status: "failure",
      result: { operation: "check" },
      error: "repository consistency check failed",
    });
    assert.equal(failed.state, "failed");
    assert.deepEqual(failed.result, { operation: "check" });
    assert.match(failed.error, /consistency check failed/);
    assert.notEqual(failed.result?.integrity, "ok");
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
