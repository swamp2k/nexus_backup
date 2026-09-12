import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { listJobs } from "../lib/dashboard-data.mjs";
import { recordRuntimeEvents } from "../lib/runtime-telemetry.mjs";
import { openSqliteD1 } from "../lib/sqlite-d1.mjs";

const migrationsDir = fileURLToPath(new URL("../../../migrations/", import.meta.url));

test("job list exposes latest telemetry for the current attempt without N+1 lookups", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nexus-backup-list-progress-"));
  const db = await openSqliteD1({ filename: join(dir, "backup.sqlite"), migrationsDir });
  try {
    await db.prepare(`
      INSERT INTO backup_jobs (
        id, operation_key, type, state, attempt, revision, payload_json,
        created_at, updated_at, last_mutation_id
      ) VALUES (?, ?, ?, 'running', 2, 0, '{}', ?, ?, ?)
    `).bind(
      "job-progress",
      "progress-op",
      "restic-backup",
      "2026-09-12T10:00:00Z",
      "2026-09-12T10:00:02Z",
      "mutation-progress",
    ).run();

    await db.prepare(`
      INSERT INTO backup_jobs (
        id, operation_key, type, state, attempt, revision, payload_json,
        created_at, updated_at, last_mutation_id
      ) VALUES (?, ?, ?, 'queued', 0, 0, '{}', ?, ?, ?)
    `).bind(
      "job-queued",
      "queued-op",
      "restic-backup",
      "2026-09-12T09:00:00Z",
      "2026-09-12T09:00:00Z",
      "mutation-queued",
    ).run();

    await recordRuntimeEvents(db, {
      jobId: "job-progress",
      attempt: 1,
      agentId: "local-agent",
      events: [{ type: "progress", tool: "restic", bytesDone: 90, bytesTotal: 100 }],
    });
    await recordRuntimeEvents(db, {
      jobId: "job-progress",
      attempt: 2,
      agentId: "local-agent",
      events: [{
        type: "progress",
        tool: "restic",
        bytesDone: 25,
        bytesTotal: 100,
        filesDone: 5,
        filesTotal: 20,
        speedBytesPerSecond: 10,
        etaSeconds: 75,
      }],
    });

    const jobs = await listJobs(db);
    const running = jobs.find((job) => job.id === "job-progress");
    const queued = jobs.find((job) => job.id === "job-queued");
    assert.equal(running.runtime.tool, "restic");
    assert.equal(running.runtime.bytesDone, 25);
    assert.equal(running.runtime.bytesTotal, 100);
    assert.equal(running.runtime.filesDone, 5);
    assert.equal(running.runtime.speedBytesPerSecond, 10);
    assert.equal(running.runtime.etaSeconds, 75);
    assert.equal(queued.runtime, null);

    const filtered = await listJobs(db, { state: "running" });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].runtime.bytesDone, 25);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
