import assert from "node:assert/strict";
import test from "node:test";
import {
  CommandAbortedError,
  CompositeJobExecutor,
  NodeCommandRunner,
  RcloneTransferExecutor,
  ResticBackupExecutor,
  StaticAgentRuntimeConfig,
  ToolExitError,
} from "../dist/index.js";

function backupJob(type, payload) {
  return {
    id: "job-1",
    operationKey: "op-1",
    type,
    state: "running",
    attempt: 1,
    revision: 1,
    payload,
    lease: null,
    createdAt: "2026-09-12T10:00:00.000Z",
    updatedAt: "2026-09-12T10:00:00.000Z",
    startedAt: "2026-09-12T10:00:00.000Z",
    finishedAt: null,
    lastError: null,
  };
}

class FakeRunner {
  constructor(result, lines = {}) {
    this.result = result;
    this.lines = lines;
    this.calls = [];
  }
  async run(spec, _signal, handlers = {}) {
    this.calls.push(spec);
    for (const line of this.lines.stdout ?? []) handlers.stdout?.(line);
    for (const line of this.lines.stderr ?? []) handlers.stderr?.(line);
    return this.result;
  }
}

function config() {
  return new StaticAgentRuntimeConfig({
    sources: [{ id: "photos", paths: ["/mnt/user/photos", "/mnt/user/docs"] }],
    resticRepositories: [{
      id: "repo-main",
      repository: "/backup/restic/main",
      passwordFile: "/run/secrets/restic-password",
      environment: { RESTIC_CACHE_DIR: "/state/restic-cache" },
    }],
    rcloneEndpoints: [
      { id: "seedbox", fs: "seedbox:/rtorrent/complete" },
      { id: "downloads", fs: "/mnt/user/downloads" },
    ],
    tools: {
      resticBinary: "/usr/local/bin/restic",
      rcloneBinary: "/usr/local/bin/rclone",
      rcloneConfigPath: "/config/rclone/rclone.conf",
      rcloneArgs: ["--transfers", "4"],
    },
  });
}

test("NodeCommandRunner captures stdout and stderr line-by-line", async () => {
  const stdout = [];
  const stderr = [];
  const runner = new NodeCommandRunner();
  const result = await runner.run({
    executable: process.execPath,
    args: ["-e", "console.log('hello'); console.error('problem')"],
  }, new AbortController().signal, {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(stdout, ["hello"]);
  assert.deepEqual(stderr, ["problem"]);
  assert.match(result.stdoutTail, /hello/);
  assert.match(result.stderrTail, /problem/);
});

test("NodeCommandRunner terminates an aborted child process", async () => {
  const controller = new AbortController();
  const runner = new NodeCommandRunner({ terminateGraceMs: 50 });
  const execution = runner.run({
    executable: process.execPath,
    args: ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{}, 1000)"],
  }, controller.signal);
  setTimeout(() => controller.abort(new Error("stop requested")), 60);
  await assert.rejects(execution, CommandAbortedError);
});

test("StaticAgentRuntimeConfig rejects duplicate and unknown ids", () => {
  assert.throws(() => new StaticAgentRuntimeConfig({
    sources: [{ id: "same", paths: ["/a"] }, { id: "same", paths: ["/b"] }],
  }), /Duplicate backup source id/);
  const runtime = config();
  assert.throws(() => runtime.source("missing"), /Unknown backup source/);
  assert.throws(() => runtime.resticRepository("missing"), /Unknown restic repository/);
});

test("restic executor resolves local IDs and emits structured progress", async () => {
  const events = [];
  const runner = new FakeRunner(
    { exitCode: 0, signal: null, durationMs: 10, stdoutTail: "", stderrTail: "" },
    { stdout: [
      JSON.stringify({ message_type: "status", bytes_done: 50, total_bytes: 100, files_done: 2, total_files: 4, seconds_remaining: 3, error_count: 0 }),
      JSON.stringify({ message_type: "summary", snapshot_id: "deadbeef", total_bytes_processed: 100 }),
    ] },
  );
  const executor = new ResticBackupExecutor(config(), runner, { emit: (event) => events.push(event) });
  const result = await executor.execute(backupJob("restic-backup", {
    sourceId: "photos",
    repositoryId: "repo-main",
    tags: ["nightly"],
  }), new AbortController().signal);
  assert.equal(result.status, "completed");
  assert.equal(runner.calls.length, 1);
  const command = runner.calls[0];
  assert.equal(command.executable, "/usr/local/bin/restic");
  assert.deepEqual(command.args, ["backup", "--json", "--tag", "nightly", "--", "/mnt/user/photos", "/mnt/user/docs"]);
  assert.equal(command.env.RESTIC_REPOSITORY, "/backup/restic/main");
  assert.equal(command.env.RESTIC_PASSWORD_FILE, "/run/secrets/restic-password");
  assert.equal(command.env.RESTIC_CACHE_DIR, "/state/restic-cache");
  assert.equal(command.env.RESTIC_PROGRESS_FPS, "1");
  assert.deepEqual(events[0], {
    type: "progress", tool: "restic", bytesDone: 50, bytesTotal: 100,
    filesDone: 2, filesTotal: 4, etaSeconds: 3, errors: 0,
  });
  assert.equal(events[1].type, "summary");
});

test("restic exit code 3 maps to partial while fatal codes throw", async () => {
  const partialRunner = new FakeRunner({ exitCode: 3, signal: null, durationMs: 10, stdoutTail: "", stderrTail: "unreadable" });
  const partial = await new ResticBackupExecutor(config(), partialRunner).execute(
    backupJob("restic-backup", { sourceId: "photos", repositoryId: "repo-main" }),
    new AbortController().signal,
  );
  assert.equal(partial.status, "partial");

  const failedRunner = new FakeRunner({ exitCode: 1, signal: null, durationMs: 10, stdoutTail: "", stderrTail: "fatal" });
  await assert.rejects(
    () => new ResticBackupExecutor(config(), failedRunner).execute(
      backupJob("restic-backup", { sourceId: "photos", repositoryId: "repo-main" }),
      new AbortController().signal,
    ),
    (error) => error instanceof ToolExitError && error.exitCode === 1 && error.stderrTail === "fatal",
  );
});

test("restic payload cannot inject a raw path or repository", async () => {
  const runner = new FakeRunner({ exitCode: 0, signal: null, durationMs: 1, stdoutTail: "", stderrTail: "" });
  const executor = new ResticBackupExecutor(config(), runner);
  await assert.rejects(
    () => executor.execute(backupJob("restic-backup", {
      sourceId: "/etc",
      repositoryId: "s3:attacker-controlled",
      sourcePath: "/etc/shadow",
    }), new AbortController().signal),
    /Unknown backup source/,
  );
  assert.equal(runner.calls.length, 0);
});

test("rclone executor resolves endpoints locally and parses JSON stats", async () => {
  const events = [];
  const runner = new FakeRunner(
    { exitCode: 0, signal: null, durationMs: 10, stdoutTail: "", stderrTail: "" },
    { stderr: [JSON.stringify({
      level: "notice",
      msg: "Transferred",
      stats: { bytes: 1024, totalBytes: 4096, transfers: 2, totalTransfers: 8, speed: 512, eta: 6, errors: 0 },
    })] },
  );
  const executor = new RcloneTransferExecutor(config(), runner, { emit: (event) => events.push(event) });
  const result = await executor.execute(backupJob("rclone-transfer", {
    sourceEndpointId: "seedbox",
    destinationEndpointId: "downloads",
    mode: "copy",
  }), new AbortController().signal);
  assert.equal(result.status, "completed");
  const command = runner.calls[0];
  assert.equal(command.executable, "/usr/local/bin/rclone");
  assert.deepEqual(command.args.slice(0, 3), ["copy", "seedbox:/rtorrent/complete", "/mnt/user/downloads"]);
  assert.ok(command.args.includes("--use-json-log"));
  assert.ok(command.args.includes("/config/rclone/rclone.conf"));
  assert.deepEqual(events[0], {
    type: "progress", tool: "rclone", bytesDone: 1024, bytesTotal: 4096,
    filesDone: 2, filesTotal: 8, speedBytesPerSecond: 512, etaSeconds: 6, errors: 0,
  });
});

test("rclone move requires local destructive-operation opt-in", async () => {
  const runner = new FakeRunner({ exitCode: 0, signal: null, durationMs: 1, stdoutTail: "", stderrTail: "" });
  const executor = new RcloneTransferExecutor(config(), runner);
  await assert.rejects(
    () => executor.execute(backupJob("rclone-transfer", {
      sourceEndpointId: "seedbox",
      destinationEndpointId: "downloads",
      mode: "move",
    }), new AbortController().signal),
    /rclone move is not allowed/,
  );
  assert.equal(runner.calls.length, 0);

  const moveConfig = new StaticAgentRuntimeConfig({
    rcloneEndpoints: [
      { id: "seedbox", fs: "seedbox:/rtorrent/complete", allowMove: true },
      { id: "downloads", fs: "/mnt/user/downloads" },
    ],
  });
  const allowedRunner = new FakeRunner({ exitCode: 0, signal: null, durationMs: 1, stdoutTail: "", stderrTail: "" });
  const allowed = await new RcloneTransferExecutor(moveConfig, allowedRunner).execute(backupJob("rclone-transfer", {
    sourceEndpointId: "seedbox",
    destinationEndpointId: "downloads",
    mode: "move",
  }), new AbortController().signal);
  assert.equal(allowed.status, "completed");
  assert.equal(allowedRunner.calls[0].args[0], "move");
});

test("composite executor rejects unknown job types", async () => {
  const composite = new CompositeJobExecutor(new Map());
  await assert.rejects(
    () => composite.execute(backupJob("not-registered", {}), new AbortController().signal),
    /No executor registered for job type: not-registered/,
  );
});
