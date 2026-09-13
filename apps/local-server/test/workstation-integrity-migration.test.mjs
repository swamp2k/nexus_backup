import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { openSqliteD1 } from "../lib/sqlite-d1.mjs";

const sourceMigrationsDir = fileURLToPath(new URL("../../../migrations/", import.meta.url));
const integrityMigration = "0014_workstation_integrity.sql";

test("0014 integrity migration preserves workstation runs and recovery cache with foreign keys intact", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nexus-workstation-integrity-migration-"));
  const migrationsDir = join(dir, "migrations");
  const databasePath = join(dir, "backup.sqlite");
  await mkdir(migrationsDir, { recursive: true });

  try {
    const migrationNames = (await readdir(sourceMigrationsDir))
      .filter((name) => name.endsWith(".sql") && name < integrityMigration)
      .sort();
    assert.ok(migrationNames.includes("0013_workstation_recovery.sql"));
    for (const name of migrationNames) {
      await copyFile(join(sourceMigrationsDir, name), join(migrationsDir, name));
    }

    let db = await openSqliteD1({ filename: databasePath, migrationsDir });
    await db.prepare(`
      INSERT INTO managed_devices(
        id,name,kind,token_hash,enabled,capabilities_json,remotes_json,created_at,updated_at
      ) VALUES(?,?,?,?,1,'[]','[]',?,?)
    `).bind("device-upgrade", "Existing workstation", "workstation", "hash-upgrade", "2026-09-12T12:00:00Z", "2026-09-12T12:00:00Z").run();

    await db.prepare(`
      INSERT INTO workstation_runs(
        id,device_id,operation_key,state,source_paths_json,retention_json,queued_at,finished_at,
        result_json,created_at,updated_at,operation,request_json
      ) VALUES(?,?,?,'completed','[]','{}',?,?,?,?,?,'inventory','{}')
    `).bind(
      "wsrun-existing-inventory",
      "device-upgrade",
      "existing:inventory",
      "2026-09-12T12:01:00Z",
      "2026-09-12T12:02:00Z",
      JSON.stringify({ operation: "inventory", snapshots: [{ id: "abcdef1234567890" }] }),
      "2026-09-12T12:01:00Z",
      "2026-09-12T12:02:00Z",
    ).run();

    await db.prepare(`
      INSERT INTO workstation_snapshot_inventory(device_id,source_run_id,scanned_at,snapshots_json)
      VALUES(?,?,?,?)
    `).bind(
      "device-upgrade",
      "wsrun-existing-inventory",
      "2026-09-12T12:02:00Z",
      JSON.stringify([{ id: "abcdef1234567890", time: "2026-09-12T11:55:00Z" }]),
    ).run();

    await db.prepare(`
      INSERT INTO workstation_snapshot_browse(
        device_id,snapshot_id,browse_path,source_run_id,scanned_at,entries_json,entry_limit,truncated
      ) VALUES(?,?,?,?,?,?,128,0)
    `).bind(
      "device-upgrade",
      "abcdef1234567890",
      "/",
      "wsrun-existing-inventory",
      "2026-09-12T12:02:30Z",
      JSON.stringify([{ path: "/Users", name: "Users", nodeType: "dir", size: 0 }]),
    ).run();
    db.close();

    await copyFile(join(sourceMigrationsDir, integrityMigration), join(migrationsDir, integrityMigration));
    db = await openSqliteD1({ filename: databasePath, migrationsDir });
    try {
      const run = await db.prepare("SELECT operation,result_json FROM workstation_runs WHERE id=?")
        .bind("wsrun-existing-inventory").first();
      assert.equal(run.operation, "inventory");
      assert.match(run.result_json, /abcdef1234567890/);

      const inventory = await db.prepare("SELECT source_run_id,snapshots_json FROM workstation_snapshot_inventory WHERE device_id=?")
        .bind("device-upgrade").first();
      assert.equal(inventory.source_run_id, "wsrun-existing-inventory");
      assert.match(inventory.snapshots_json, /abcdef1234567890/);

      const browse = await db.prepare(`
        SELECT source_run_id,entries_json FROM workstation_snapshot_browse
        WHERE device_id=? AND snapshot_id=? AND browse_path='/'
      `).bind("device-upgrade", "abcdef1234567890").first();
      assert.equal(browse.source_run_id, "wsrun-existing-inventory");
      assert.match(browse.entries_json, /Users/);

      const foreignKeyErrors = (await db.prepare("PRAGMA foreign_key_check").all()).results;
      assert.deepEqual(foreignKeyErrors, []);

      await db.prepare(`
        INSERT INTO workstation_runs(
          id,device_id,operation_key,state,source_paths_json,retention_json,queued_at,created_at,updated_at,operation,request_json
        ) VALUES(?,?,?,'queued','[]','{}',?,?,?,'check','{}')
      `).bind(
        "wsrun-new-check",
        "device-upgrade",
        "new:check",
        "2026-09-13T15:00:00Z",
        "2026-09-13T15:00:00Z",
        "2026-09-13T15:00:00Z",
      ).run();
      assert.equal(await db.prepare("SELECT operation FROM workstation_runs WHERE id='wsrun-new-check'").first("operation"), "check");

      await assert.rejects(
        () => db.prepare(`
          INSERT INTO workstation_runs(
            id,device_id,operation_key,state,source_paths_json,retention_json,queued_at,created_at,updated_at,operation
          ) VALUES('wsrun-invalid','device-upgrade','invalid:operation','queued','[]','{}','2026-09-13','2026-09-13','2026-09-13','destroy')
        `).run(),
        /CHECK constraint failed/,
      );
    } finally {
      db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
