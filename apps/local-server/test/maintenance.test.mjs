import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createPlanMaintenanceService, enrichPlanJob } from "../lib/plan-maintenance.mjs";
import { openSqliteD1 } from "../lib/sqlite-d1.mjs";

const migrationsDir = fileURLToPath(new URL("../../../migrations/", import.meta.url));

test("scheduled plan backups receive an internal retention tag", () => {
  const enriched = enrichPlanJob({
    operationKey: "plan:plan-1:2026-09-12T01:00:00.000Z",
    type: "restic-backup",
    payload: { sourceId: "appdata", repositoryId: "repo-main", tags: ["nightly"] },
  });
  assert.deepEqual(enriched.payload.tags, ["nightly", "nexus-plan:plan-1"]);
  const manual = enrichPlanJob({
    operationKey: "manual-job",
    type: "restic-backup",
    payload: { sourceId: "appdata", repositoryId: "repo-main" },
  });
  assert.equal(manual.payload.tags, undefined);
});

test("completed Restic plan backup queues maintenance exactly once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nexus-maintenance-"));
  const db = await openSqliteD1({ filename: join(dir, "backup.sqlite"), migrationsDir });
  const calls = [];
  let sequence = 0;
  const now = new Date("2026-09-12T04:00:00.000Z");
  async function enqueueJob(input) {
    calls.push(input);
    const id = `maintenance-${++sequence}`;
    await db.prepare(`
      INSERT INTO backup_jobs (
        id, operation_key, type, state, attempt, revision, payload_json,
        created_at, updated_at, last_mutation_id
      ) VALUES (?, ?, ?, 'queued', 0, 0, ?, ?, ?, ?)
    `).bind(id, input.operationKey, input.type, JSON.stringify(input.payload), now.toISOString(), now.toISOString(), `mutation-${id}`).run();
    return { id, state: "queued" };
  }
  try {
    await db.prepare(`
      INSERT INTO backup_jobs (
        id, operation_key, type, state, attempt, revision, payload_json,
        created_at, updated_at, started_at, finished_at, last_mutation_id
      ) VALUES (?, ?, 'restic-backup', 'completed', 1, 2, '{}', ?, ?, ?, ?, ?)
    `).bind("backup-1", "plan:plan-1:scheduled", now.toISOString(), now.toISOString(), now.toISOString(), now.toISOString(), "mutation-backup").run();
    await db.prepare(`
      INSERT INTO backup_plans (
        id, name, enabled, job_type, payload_json, schedule_json, timezone,
        retention_json, next_run_at, last_scheduled_at, last_job_id, created_at, updated_at
      ) VALUES (?, ?, 1, 'restic-backup', ?, ?, 'Europe/Copenhagen', ?, ?, ?, ?, ?, ?)
    `).bind(
      "plan-1", "Nightly appdata",
      JSON.stringify({ sourceId: "appdata", repositoryId: "repo-main" }),
      JSON.stringify({ kind: "daily", time: "03:00" }),
      JSON.stringify({ keepDaily: 7, keepWeekly: 4, keepMonthly: 12 }),
      "2026-09-13T01:00:00.000Z", "2026-09-12T01:00:00.000Z", "backup-1",
      now.toISOString(), now.toISOString(),
    ).run();

    const service = createPlanMaintenanceService({ db, enqueueJob, now: () => new Date(now) });
    assert.deepEqual(await service.runDue(), { enqueued: 1, failures: [] });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].operationKey, "plan:plan-1:maintenance:backup-1");
    assert.equal(calls[0].type, "restic-maintenance");
    assert.deepEqual(calls[0].payload, {
      repositoryId: "repo-main",
      planTag: "nexus-plan:plan-1",
      retention: { keepDaily: 7, keepWeekly: 4, keepMonthly: 12 },
      sourceJobId: "backup-1",
    });
    assert.deepEqual(await service.runDue(), { enqueued: 0, failures: [] });

    await db.prepare("UPDATE backup_jobs SET state = 'failed', last_error = 'lock failed' WHERE id = ?").bind("maintenance-1").run();
    assert.deepEqual(await service.runDue(), { enqueued: 0, failures: [] });
    const listed = await service.list();
    assert.equal(listed[0].maintenance.state, "failed");

    const manual = await service.runNow("plan-1");
    assert.equal(manual.job.id, "maintenance-2");
    assert.match(calls.at(-1).operationKey, /^plan:plan-1:maintenance:manual:/);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
