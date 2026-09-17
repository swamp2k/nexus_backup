import assert from "node:assert/strict";
import { cp, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createLocalRepositoryTransferExecutor, normalizeTransferPayload } from "../lib/local-repository-transfer.mjs";
import { createRepositoryService } from "../lib/repositories.mjs";
import { openSqliteD1 } from "../lib/sqlite-d1.mjs";
import { D1JobRepository } from "../../control-plane/dist/index.js";
import { JobService } from "@nexus-backup/core";

const migrationsDir = fileURLToPath(new URL("../../../migrations/", import.meta.url));

const transferPayload = (items) => ({
  ruleId: "rule-family",
  sourceEndpointId: "seedbox",
  sourcePath: "complete",
  destinationRepositoryId: "repo-family",
  destinationPath: "Seedbox",
  mode: "copy",
  transferAttempt: 1,
  items,
});

test("local transfer identity preserves object keys and changes with file generations", () => {
  const first = normalizeTransferPayload(transferPayload([{ relPath: "same/file.txt", size: 1, objectKey: "generation-a" }]));
  const second = normalizeTransferPayload(transferPayload([{ relPath: "same/file.txt", size: 1, objectKey: "generation-b" }]));
  assert.equal(first.payload.items[0].objectKey, "generation-a");
  assert.match(first.operationKey, /generation-a/);
  assert.notEqual(first.operationKey, second.operationKey);

  const grouped = normalizeTransferPayload(transferPayload([
    { relPath: "b.txt", size: 2, objectKey: "object-b" },
    { relPath: "a.txt", size: 1, objectKey: "object-a" },
  ]));
  const reordered = normalizeTransferPayload(transferPayload([
    { relPath: "a-renamed.txt", size: 1, objectKey: "object-a" },
    { relPath: "b-renamed.txt", size: 2, objectKey: "object-b" },
  ]));
  const changed = normalizeTransferPayload(transferPayload([
    { relPath: "a-renamed.txt", size: 1, objectKey: "object-a-new-generation" },
    { relPath: "b-renamed.txt", size: 2, objectKey: "object-b" },
  ]));
  assert.equal(grouped.operationKey, reordered.operationKey);
  assert.notEqual(grouped.operationKey, changed.operationKey);
  assert.deepEqual(grouped.payload.items.map((item) => item.objectKey), ["object-b", "object-a"]);
});

test("repository-targeted legacy rclone transfer executes inside Nexus and resolves below /backup", async () => {
  const root = await mkdtemp(join(tmpdir(), "nexus-local-transfer-"));
  const sourceRoot = join(root, "source");
  const backupRoot = join(root, "backup");
  const db = await openSqliteD1({ filename: join(root, "backup.sqlite"), migrationsDir });
  try {
    await mkdir(join(sourceRoot, "complete", "show"), { recursive: true });
    await import("node:fs/promises").then(({ writeFile }) => writeFile(join(sourceRoot, "complete", "show", "episode.mkv"), "episode"));
    const repositories = createRepositoryService({ db, backupRoot, id: () => "repo-family" });
    const repository = await repositories.create({ name: "Family" });
    let sequence = 0;
    async function enqueueJob(input) {
      const id = `job-${++sequence}`;
      const at = new Date().toISOString();
      await db.prepare(`INSERT INTO backup_jobs(id,operation_key,type,state,attempt,revision,payload_json,created_at,updated_at,last_mutation_id) VALUES(?,?,?,'queued',0,0,?,?,?,?)`)
        .bind(id, input.operationKey, input.type, JSON.stringify(input.payload), at, at, `mutation-${id}`).run();
      await db.prepare("INSERT INTO backup_job_events(id,job_id,type,at,data_json) VALUES(?,?,?,?,?)")
        .bind(`event-${id}`, id, "job.created", at, JSON.stringify({ state: "queued" })).run();
      return { id, state: "queued" };
    }
    const executor = createLocalRepositoryTransferExecutor({
      db,
      repositories,
      enqueueJob,
      loadConfig: async () => ({ rcloneEndpoints: [{ id: "seedbox", fs: sourceRoot }], tools: {} }),
      command: async (executable, args) => {
        assert.equal(executable, "rclone");
        const operation = args[0];
        if (operation === "copyto") {
          await mkdir(dirname(args[2]), { recursive: true });
          await cp(args[1], args[2]);
        } else if (operation === "moveto") {
          await mkdir(dirname(args[2]), { recursive: true });
          await import("node:fs/promises").then(({ rename }) => rename(args[1], args[2]));
        } else if (operation === "deletefile") {
          await rm(args[1], { force: true });
        } else if (operation === "purge") {
          await rm(args[1], { recursive: true, force: true });
        } else if (operation === "lsjson") {
          const info = await stat(args[1]);
          return { code: 0, stdout: JSON.stringify({ Size: info.size }), stderr: "" };
        } else {
          throw new Error(`unexpected rclone operation: ${operation}`);
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    });

    const result = await executor.execute({
      ruleId: "rule-family",
      sourceEndpointId: "seedbox",
      sourcePath: "complete",
      destinationRepositoryId: repository.id,
      destinationPath: "Seedbox",
      mode: "copy",
      transferAttempt: 1,
      rcloneArgs: [],
      items: [{ relPath: "show/episode.mkv", size: 7, modTime: "2026-09-17T10:00:00.000Z", objectKey: "a".repeat(64) }],
    });
    assert.equal(result.completed, true);
    assert.equal(result.job.state, "completed");
    assert.equal(await readFile(join(backupRoot, "Family", "Seedbox", "show", "episode.mkv"), "utf8"), "episode");
    assert.deepEqual(await readdir(join(backupRoot, "Family", "Seedbox")), ["show"]);
    assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM backup_agents").first("count"), 0);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("long local transfer heartbeat prevents lease recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "nexus-local-transfer-lease-"));
  const sourceRoot = join(root, "source");
  const backupRoot = join(root, "backup");
  const db = await openSqliteD1({ filename: join(root, "backup.sqlite"), migrationsDir });
  try {
    await mkdir(join(sourceRoot, "complete"), { recursive: true });
    await import("node:fs/promises").then(({ writeFile }) => writeFile(join(sourceRoot, "complete", "episode.mkv"), "episode"));
    const repositories = createRepositoryService({ db, backupRoot, id: () => "repo-family" });
    const repository = await repositories.create({ name: "Family" });
    let sequence = 0;
    async function enqueueJob(input) {
      const id = `lease-job-${++sequence}`;
      const at = new Date().toISOString();
      await db.prepare(`INSERT INTO backup_jobs(id,operation_key,type,state,attempt,revision,payload_json,created_at,updated_at,last_mutation_id) VALUES(?,?,?,'queued',0,0,?,?,?,?)`)
        .bind(id, input.operationKey, input.type, JSON.stringify(input.payload), at, at, `mutation-${id}`).run();
      await db.prepare("INSERT INTO backup_job_events(id,job_id,type,at,data_json) VALUES(?,?,?,?,?)")
        .bind(`event-${id}`, id, "job.created", at, JSON.stringify({ state: "queued" })).run();
      return { id, state: "queued" };
    }
    const base = new Date("2026-09-17T10:00:00.000Z");
    let clock = base;
    let markStarted;
    const started = new Promise((resolve) => { markStarted = resolve; });
    let releaseCopy;
    const copyHeld = new Promise((resolve) => { releaseCopy = resolve; });
    const executor = createLocalRepositoryTransferExecutor({
      db,
      repositories,
      enqueueJob,
      now: () => clock,
      leaseTtlMs: 50,
      leaseHeartbeatMs: 5,
      loadConfig: async () => ({ rcloneEndpoints: [{ id: "seedbox", fs: sourceRoot }], tools: {} }),
      command: async (_executable, args) => {
        if (args[0] === "copyto") {
          markStarted();
          await copyHeld;
          await mkdir(dirname(args[2]), { recursive: true });
          await cp(args[1], args[2]);
        } else if (args[0] === "moveto") {
          await mkdir(dirname(args[2]), { recursive: true });
          await import("node:fs/promises").then(({ rename }) => rename(args[1], args[2]));
        } else if (args[0] === "purge") {
          await rm(args[1], { recursive: true, force: true });
        } else if (args[0] === "lsjson") {
          const info = await stat(args[1]);
          return { code: 0, stdout: JSON.stringify({ Size: info.size }), stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const payload = transferPayload([{ relPath: "episode.mkv", size: 7, objectKey: "episode-generation-1" }]);
    const execution = executor.execute(payload);
    await started;
    clock = new Date(base.getTime() + 40);
    await new Promise((resolve) => setTimeout(resolve, 20));
    clock = new Date(base.getTime() + 60);
    const recovery = new JobService(new D1JobRepository(db));
    assert.deepEqual(await recovery.recoverExpired(clock), []);
    releaseCopy();
    const result = await execution;
    assert.equal(result.completed, true);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
