import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createManagedDeviceService } from "../lib/managed-devices.mjs";
import { getWorkstationRunJob, listJobs, listWorkstationRunJobs, workstationRunEvents } from "../lib/dashboard-data.mjs";
import { openSqliteD1 } from "../lib/sqlite-d1.mjs";

const migrationsDir = fileURLToPath(new URL("../../../migrations/", import.meta.url));

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "nexus-jobs-"));
  const db = await openSqliteD1({ filename: join(dir, "nexus.sqlite"), migrationsDir });
  const devices = createManagedDeviceService({ db, id: () => "device-swamp" });
  return { db, async close() { db.close(); await rm(dir, { recursive: true, force: true }); }, devices };
}

async function insertRun(db, overrides = {}) {
  const base = {
    id: "wsrun-1", deviceId: "device-swamp", operationKey: "op-1", state: "completed", operation: "backup",
    queuedAt: "2026-01-01T00:00:00.000Z", startedAt: "2026-01-01T00:00:05.000Z", finishedAt: "2026-01-01T00:00:10.000Z",
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:10.000Z",
    sourcePaths: ["C:\\Users\\swamp\\Documents"], excludePatterns: [],
    result: { filesNew: 2, filesChanged: 1, filesUnmodified: 5, dataAdded: 4096, durationSeconds: 5 },
    errorMessage: null,
    ...overrides,
  };
  await db.prepare(`
    INSERT INTO workstation_runs(
      id,device_id,operation_key,state,operation,source_paths_json,exclude_patterns_json,retention_json,
      queued_at,started_at,finished_at,result_json,error_message,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(
    base.id, base.deviceId, base.operationKey, base.state, base.operation,
    JSON.stringify(base.sourcePaths), JSON.stringify(base.excludePatterns), JSON.stringify({ keepDaily: 7, keepWeekly: 4, keepMonthly: 12 }),
    base.queuedAt, base.startedAt, base.finishedAt, base.result ? JSON.stringify(base.result) : null, base.errorMessage,
    base.createdAt, base.updatedAt,
  ).run();
  return base;
}

test("listJobs merges completed workstation backups alongside rclone jobs", async () => {
  const f = await fixture();
  try {
    await f.devices.create({ name: "swamp", kind: "workstation" });
    await insertRun(f.db);

    const jobs = await listJobs(f.db, {});
    assert.equal(jobs.length, 1);
    const [job] = jobs;
    assert.equal(job.id, "wsrun-1");
    assert.equal(job.type, "workstation-backup");
    assert.equal(job.state, "completed");
    assert.equal(job.payload.device, "swamp");
    assert.deepEqual(job.payload.sourcePaths, ["C:\\Users\\swamp\\Documents"]);
    assert.equal(job.payload.result.filesNew, 2);
    assert.equal(job.lastError, null);
  } finally { await f.close(); }
});

test("listJobs excludes workstation runs from non-backup operations", async () => {
  const f = await fixture();
  try {
    await f.devices.create({ name: "swamp", kind: "workstation" });
    await insertRun(f.db, { id: "wsrun-scan", operationKey: "op-scan", operation: "source-scan" });

    assert.equal((await listJobs(f.db, {})).length, 0);
    assert.equal((await listWorkstationRunJobs(f.db, {})).length, 0);
  } finally { await f.close(); }
});

test("listJobs filters merged results by state and respects the limit", async () => {
  const f = await fixture();
  try {
    await f.devices.create({ name: "swamp", kind: "workstation" });
    await insertRun(f.db, { id: "wsrun-ok", operationKey: "op-ok", state: "completed" });
    await insertRun(f.db, { id: "wsrun-bad", operationKey: "op-bad", state: "failed", result: null, errorMessage: "disk full" });

    const failedOnly = await listJobs(f.db, { state: "failed" });
    assert.equal(failedOnly.length, 1);
    assert.equal(failedOnly[0].id, "wsrun-bad");
    assert.equal(failedOnly[0].lastError, "disk full");

    assert.equal((await listJobs(f.db, { limit: 1 })).length, 1);
  } finally { await f.close(); }
});

test("getWorkstationRunJob and workstationRunEvents back the job-detail drawer for wsrun- ids", async () => {
  const f = await fixture();
  try {
    await f.devices.create({ name: "swamp", kind: "workstation" });
    await insertRun(f.db, { id: "wsrun-detail", operationKey: "op-detail" });

    const job = await getWorkstationRunJob(f.db, "wsrun-detail");
    assert.equal(job.id, "wsrun-detail");
    assert.equal(job.payload.device, "swamp");

    const row = await f.db.prepare("SELECT * FROM workstation_runs WHERE id=?").bind("wsrun-detail").first();
    const events = workstationRunEvents(row);
    assert.deepEqual(events.map((event) => event.type), ["job.created", "job.transitioned", "job.transitioned"]);

    assert.equal(await getWorkstationRunJob(f.db, "wsrun-missing"), null);
  } finally { await f.close(); }
});
