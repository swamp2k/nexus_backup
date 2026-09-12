import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createApi, D1AgentStore } from "../../control-plane/dist/index.js";
import { openSqliteD1 } from "../lib/sqlite-d1.mjs";

const migrationsDir = fileURLToPath(new URL("../../../migrations/", import.meta.url));

test("local SQLite adapter runs the real control plane without D1", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nexus-backup-local-"));
  const db = await openSqliteD1({ filename: join(dir, "backup.sqlite"), migrationsDir });
  try {
    const agentToken = "agent-token-abcdefghijklmnopqrstuvwxyz-0123456789";
    await new D1AgentStore(db).register("local-agent", "Local agent", agentToken, new Date("2026-09-12T10:00:00Z"));
    const api = createApi({
      now: () => new Date("2026-09-12T10:00:00Z"),
      id: (() => { let value = 0; return () => `id-${++value}`; })(),
      leaseToken: () => "lease-token",
    });
    const env = { DB: db, CONTROL_PLANE_TOKEN: "control-token", DEFAULT_LEASE_TTL_MS: "60000" };

    const created = await api.fetch(new Request("http://local/v1/jobs", {
      method: "POST",
      headers: { authorization: "Bearer control-token", "content-type": "application/json" },
      body: JSON.stringify({ operationKey: "local-op", type: "restic-backup", payload: { sourceId: "data", repositoryId: "repo" } }),
    }), env);
    assert.equal(created.status, 201);

    const claimed = await api.fetch(new Request("http://local/v1/agent/claim", {
      method: "POST",
      headers: { authorization: `Bearer ${agentToken}`, "content-type": "application/json" },
      body: JSON.stringify({ version: "test" }),
    }), env);
    assert.equal(claimed.status, 200);
    const body = await claimed.json();
    assert.equal(body.job.operationKey, "local-op");
    assert.equal(body.job.lease.agentId, "local-agent");
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("SQLite batch rolls back job mutation when event insert fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nexus-backup-local-"));
  const db = await openSqliteD1({ filename: join(dir, "backup.sqlite"), migrationsDir });
  try {
    const first = db.prepare(`INSERT INTO backup_jobs (id, operation_key, type, state, attempt, revision, payload_json, created_at, updated_at, last_mutation_id) VALUES (?, ?, ?, 'queued', 0, 0, '{}', ?, ?, ?)`)
      .bind("job-rollback", "rollback-op", "test", "2026-09-12T10:00:00Z", "2026-09-12T10:00:00Z", "mutation-1");
    const invalidEvent = db.prepare("INSERT INTO backup_job_events (id, job_id, type, at, data_json) VALUES (?, ?, ?, ?, ?)")
      .bind("event-rollback", "missing-job", "created", "2026-09-12T10:00:00Z", "{}");
    await assert.rejects(() => db.batch([first, invalidEvent]));
    assert.equal(await db.prepare("SELECT id FROM backup_jobs WHERE id = ?").bind("job-rollback").first(), null);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
