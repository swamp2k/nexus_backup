import assert from "node:assert/strict";
import { cp, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createLocalRepositoryTransferExecutor } from "../lib/local-repository-transfer.mjs";
import { createRepositoryService } from "../lib/repositories.mjs";
import { openSqliteD1 } from "../lib/sqlite-d1.mjs";

const migrationsDir = fileURLToPath(new URL("../../../migrations/", import.meta.url));

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
