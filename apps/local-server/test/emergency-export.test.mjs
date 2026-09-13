import assert from "node:assert/strict";
import { lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createEmergencyBundle, verifyEmergencyBundle } from "../lib/emergency-export.mjs";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "nexus-emergency-export-"));
  const configDir = join(root, "control-config");
  const agentConfigDir = join(root, "agent-config");
  await mkdir(join(agentConfigDir, "secrets"), { recursive: true });
  await mkdir(join(agentConfigDir, "rclone"), { recursive: true });
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "control-token"), "control-secret\n", { mode: 0o600 });
  await writeFile(join(configDir, "agent-token"), "agent-secret\n", { mode: 0o600 });
  await writeFile(join(configDir, "auth.json"), JSON.stringify({ version: 1, algorithm: "scrypt", salt: "salt", hash: "hash" }), { mode: 0o600 });
  await writeFile(join(agentConfigDir, "agent.json"), JSON.stringify({ resticRepositories: [{ id: "repo-1", repository: "/backup/restic" }] }));
  await writeFile(join(agentConfigDir, "secrets", "restic-password"), "restic-secret\n", { mode: 0o600 });
  await writeFile(join(agentConfigDir, "rclone", "rclone.conf"), "[gdrive]\ntype = drive\ntoken = secret\n", { mode: 0o600 });

  const databasePath = join(configDir, "nexus-backup.sqlite");
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA journal_mode = WAL");
  database.exec(`
    CREATE TABLE nexus_backup_migrations(name TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
    CREATE TABLE recovery_probe(id INTEGER PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO nexus_backup_migrations(name,applied_at) VALUES('0014_workstation_integrity.sql','2026-09-13T15:00:00Z');
    INSERT INTO recovery_probe(value) VALUES('committed-through-wal');
  `);
  return {
    root, configDir, agentConfigDir, database,
    async close() { database.close(); await rm(root, { recursive: true, force: true }); },
  };
}

test("emergency export snapshots live SQLite state and local secrets into a verifiable bundle", async () => {
  const f = await fixture();
  try {
    const outputDir = join(f.root, "off-host", "bundle");
    const manifest = await createEmergencyBundle({
      configDir: f.configDir,
      agentConfigDir: f.agentConfigDir,
      outputDir,
      version: "0.8.0",
      revision: "deadbeef",
      now: () => new Date("2026-09-13T16:00:00Z"),
    });

    assert.equal(manifest.formatVersion, 1);
    assert.equal(manifest.containsSecrets, true);
    assert.equal(manifest.nexusBackup.version, "0.8.0");
    assert.equal(manifest.nexusBackup.revision, "deadbeef");
    assert.deepEqual(manifest.database.integrityCheck, ["ok"]);
    assert.equal(manifest.database.migrations.at(-1).name, "0014_workstation_integrity.sql");
    assert.ok(manifest.files.some((entry) => entry.path === "control/nexus-backup.sqlite"));
    assert.ok(manifest.files.some((entry) => entry.path === "control/control-token"));
    assert.ok(manifest.files.some((entry) => entry.path === "control/agent-token"));
    assert.ok(manifest.files.some((entry) => entry.path === "agent-config/secrets/restic-password"));
    assert.ok(manifest.files.some((entry) => entry.path === "agent-config/rclone/rclone.conf"));
    assert.equal(manifest.files.some((entry) => entry.path.endsWith("-wal") || entry.path.endsWith("-shm")), false);

    const snapshot = new DatabaseSync(join(outputDir, "control", "nexus-backup.sqlite"), { readOnly: true });
    try {
      assert.equal(snapshot.prepare("SELECT value FROM recovery_probe").get().value, "committed-through-wal");
    } finally { snapshot.close(); }

    const verified = await verifyEmergencyBundle(outputDir);
    assert.equal(verified.ok, true);
    assert.equal(verified.database.integrityOk, true);
    assert.equal(await readFile(join(outputDir, "agent-config", "secrets", "restic-password"), "utf8"), "restic-secret\n");

    // Exporting must not disturb the live database connection/state.
    assert.equal(f.database.prepare("SELECT value FROM recovery_probe").get().value, "committed-through-wal");
  } finally { await f.close(); }
});

test("emergency verification rejects a tampered secret file", async () => {
  const f = await fixture();
  try {
    const outputDir = join(f.root, "off-host", "bundle");
    await createEmergencyBundle({ configDir: f.configDir, agentConfigDir: f.agentConfigDir, outputDir });
    await writeFile(join(outputDir, "agent-config", "secrets", "restic-password"), "tampered\n");
    await assert.rejects(() => verifyEmergencyBundle(outputDir), /SHA-256 verification failed/);
  } finally { await f.close(); }
});

test("emergency verification confines manifest database paths to hashed bundle files", async () => {
  const f = await fixture();
  try {
    const outputDir = join(f.root, "off-host", "bundle");
    await createEmergencyBundle({ configDir: f.configDir, agentConfigDir: f.agentConfigDir, outputDir });

    const outsidePath = join(f.root, "outside.sqlite");
    const outside = new DatabaseSync(outsidePath);
    outside.exec("CREATE TABLE outside_probe(id INTEGER PRIMARY KEY)");
    outside.close();

    const manifestPath = join(outputDir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.database.path = "../../outside.sqlite";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    await assert.rejects(
      () => verifyEmergencyBundle(outputDir),
      /database\.path must be a safe relative path/,
    );
  } finally { await f.close(); }
});

test("emergency export rejects database names that can escape control config", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      () => createEmergencyBundle({
        configDir: f.configDir,
        agentConfigDir: f.agentConfigDir,
        outputDir: join(f.root, "off-host", "bundle"),
        databaseName: "../outside.sqlite",
      }),
      /databaseName must be a simple filename/,
    );
  } finally { await f.close(); }
});

test("emergency export refuses overlapping destinations and existing bundles", async () => {
  const f = await fixture();
  try {
    for (const overlapping of [join(f.configDir, "bundle"), join(f.configDir, "..bundle")]) {
      await assert.rejects(
        () => createEmergencyBundle({ configDir: f.configDir, agentConfigDir: f.agentConfigDir, outputDir: overlapping }),
        /must not overlap control config/,
      );
    }

    const linkedParent = join(f.root, "linked-control");
    await symlink(f.configDir, linkedParent);
    await assert.rejects(
      () => createEmergencyBundle({ configDir: f.configDir, agentConfigDir: f.agentConfigDir, outputDir: join(linkedParent, "bundle") }),
      /must not overlap control config/,
    );

    const nestedOutput = join(linkedParent, "new-parent", "bundle");
    await assert.rejects(
      () => createEmergencyBundle({ configDir: f.configDir, agentConfigDir: f.agentConfigDir, outputDir: nestedOutput }),
      /must not overlap control config/,
    );
    await assert.rejects(() => lstat(join(f.configDir, "new-parent")), /ENOENT/);

    const existing = join(f.root, "existing");
    await mkdir(existing);
    await assert.rejects(
      () => createEmergencyBundle({ configDir: f.configDir, agentConfigDir: f.agentConfigDir, outputDir: existing }),
      /EEXIST/,
    );
  } finally { await f.close(); }
});

test("emergency export refuses symlinks so a bundle cannot silently depend on another host path", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, "external-secret"), "outside\n");
    await symlink(join(f.root, "external-secret"), join(f.agentConfigDir, "secrets", "linked-secret"));
    const outputDir = join(f.root, "off-host", "bundle");
    await assert.rejects(
      () => createEmergencyBundle({ configDir: f.configDir, agentConfigDir: f.agentConfigDir, outputDir }),
      /must be self-contained; symlink found/,
    );
    await assert.rejects(() => readFile(join(outputDir, "manifest.json"), "utf8"), /ENOENT/);
  } finally { await f.close(); }
});
