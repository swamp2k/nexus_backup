import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBackupPlanService, nextScheduleAt } from "../lib/backup-plans.mjs";
import { openSqliteD1 } from "../lib/sqlite-d1.mjs";

const migrationsDir = new URL("../../../migrations/", import.meta.url).pathname;
const agentConfig = {
  available: true,
  sources: [{ id: "appdata", paths: ["/data/appdata"] }],
  repositories: [{ id: "repo-main" }],
  endpoints: [
    { id: "gdrive", mount: { enabled: true } },
    { id: "archive", mount: { enabled: false } },
  ],
};

test("daily plans enqueue once when due and advance to the next local occurrence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nexus-plan-"));
  const db = await openSqliteD1({ filename: join(dir, "backup.sqlite"), migrationsDir });
  let now = new Date("2026-09-12T00:30:00.000Z");
  const operations = [];
  let jobSequence = 0;
  async function enqueueJob({ operationKey, type, payload }) {
    operations.push({ operationKey, type, payload });
    const existing = await db.prepare("SELECT id, state FROM backup_jobs WHERE operation_key = ?").bind(operationKey).first();
    if (existing) return { id: String(existing.id), state: String(existing.state) };
    const id = `job-${++jobSequence}`;
    await db.prepare(`
      INSERT INTO backup_jobs (
        id, operation_key, type, state, attempt, revision, payload_json,
        created_at, updated_at, last_mutation_id
      ) VALUES (?, ?, ?, 'queued', 0, 0, ?, ?, ?, ?)
    `).bind(id, operationKey, type, JSON.stringify(payload), now.toISOString(), now.toISOString(), `mutation-${id}`).run();
    return { id, state: "queued" };
  }
  const service = createBackupPlanService({
    db,
    enqueueJob,
    loadAgentConfig: async () => agentConfig,
    now: () => new Date(now),
    id: () => "plan-1",
  });

  try {
    const plan = await service.create({
      name: "Nightly appdata",
      jobType: "restic-backup",
      payload: { sourceId: "appdata", repositoryId: "repo-main", tags: ["nightly"] },
      schedule: { kind: "daily", time: "03:00" },
      timezone: "Europe/Copenhagen",
      retention: { keepDaily: 7, keepWeekly: 4, keepMonthly: 12 },
    });
    assert.equal(plan.nextRunAt, "2026-09-12T01:00:00.000Z");
    assert.deepEqual(await service.runDue(), { enqueued: 0, failures: [] });

    now = new Date("2026-09-12T01:00:01.000Z");
    assert.deepEqual(await service.runDue(), { enqueued: 1, failures: [] });
    assert.equal(operations.length, 1);
    assert.equal(operations[0].operationKey, "plan:plan-1:2026-09-12T01:00:00.000Z");

    const [updated] = await service.list();
    assert.equal(updated.lastJob.id, "job-1");
    assert.equal(updated.lastJob.state, "queued");
    assert.equal(updated.nextRunAt, "2026-09-13T01:00:00.000Z");
    assert.deepEqual(await service.runDue(), { enqueued: 0, failures: [] });

    const disabled = await service.setEnabled("plan-1", false);
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.nextRunAt, null);
    const enabled = await service.setEnabled("plan-1", true);
    assert.equal(enabled.enabled, true);
    assert.equal(enabled.nextRunAt, "2026-09-13T01:00:00.000Z");

    const manual = await service.runNow("plan-1");
    assert.equal(manual.job.id, "job-2");
    assert.match(operations.at(-1).operationKey, /^plan:plan-1:manual:/);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("weekly schedules and DST gaps resolve in the configured timezone", () => {
  const monday = nextScheduleAt(
    { kind: "weekly", time: "03:00", days: [1] },
    "Europe/Copenhagen",
    new Date("2026-09-12T12:00:00Z"),
  );
  assert.equal(monday.toISOString(), "2026-09-14T01:00:00.000Z");

  const springGap = nextScheduleAt(
    { kind: "daily", time: "02:30" },
    "Europe/Copenhagen",
    new Date("2026-03-28T23:00:00Z"),
  );
  assert.equal(springGap.toISOString(), "2026-03-29T01:00:00.000Z");
});

test("plan validation keeps scheduled transfers non-destructive and references local config IDs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nexus-plan-validation-"));
  const db = await openSqliteD1({ filename: join(dir, "backup.sqlite"), migrationsDir });
  const service = createBackupPlanService({
    db,
    enqueueJob: async () => ({ id: "unused" }),
    loadAgentConfig: async () => agentConfig,
    now: () => new Date("2026-09-12T10:00:00Z"),
    id: () => "plan-validation",
  });
  try {
    await assert.rejects(() => service.create({
      name: "Bad move",
      jobType: "rclone-transfer",
      payload: { sourceEndpointId: "gdrive", destinationEndpointId: "archive", mode: "move" },
      schedule: { kind: "daily", time: "03:00" },
      timezone: "UTC",
    }), /only support copy mode/);

    await assert.rejects(() => service.create({
      name: "Unknown source",
      jobType: "restic-backup",
      payload: { sourceId: "missing", repositoryId: "repo-main" },
      schedule: { kind: "daily", time: "03:00" },
      timezone: "UTC",
    }), /unknown sourceId/);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
