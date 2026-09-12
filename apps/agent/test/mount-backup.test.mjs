import assert from "node:assert/strict";
import test from "node:test";
import {
  RcloneMountedResticExecutor,
  StaticAgentRuntimeConfig,
  ToolExitError,
} from "../dist/index.js";

function backupJob(payload) {
  return {
    id: "job-remote-1",
    operationKey: "op-remote-1",
    type: "rclone-restic-backup",
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

const ok = (overrides = {}) => ({
  exitCode: 0,
  signal: null,
  durationMs: 10,
  stdoutTail: "",
  stderrTail: "",
  ...overrides,
});

class SequenceRunner {
  constructor(steps) {
    this.steps = steps;
    this.calls = [];
  }

  async run(spec, _signal, handlers = {}) {
    const step = this.steps[this.calls.length];
    if (!step) throw new Error(`Unexpected command #${this.calls.length + 1}: ${spec.executable}`);
    this.calls.push(spec);
    for (const line of step.stdout ?? []) handlers.stdout?.(line);
    for (const line of step.stderr ?? []) handlers.stderr?.(line);
    return step.result;
  }
}

function config(withMount = true) {
  return new StaticAgentRuntimeConfig({
    resticRepositories: [{
      id: "repo-main",
      repository: "/backup/restic/gdrive",
      passwordFile: "/run/secrets/restic-password",
    }],
    rcloneEndpoints: [{
      id: "gdrive",
      fs: "gdrive:",
      ...(withMount ? {
        mount: {
          mountPoint: "/state/mounts/gdrive",
          daemonWait: "45s",
          cacheDir: "/state/rclone-vfs/gdrive",
          vfsCacheMode: "full",
          vfsCacheMaxSize: "50G",
          dirCacheTime: "5m",
          pollInterval: "1m",
        },
      } : {}),
    }],
    tools: {
      resticBinary: "/usr/local/bin/restic",
      rcloneBinary: "/usr/local/bin/rclone",
      rcloneConfigPath: "/config/rclone/rclone.conf",
      unmountBinary: "/usr/bin/fusermount3",
      unmountArgs: ["-u"],
      unmountTimeoutMs: 5000,
    },
  });
}

test("remote backup mounts read-only, runs restic, then unmounts", async () => {
  const runner = new SequenceRunner([
    { result: ok() },
    { result: ok(), stdout: [JSON.stringify({ message_type: "summary", snapshot_id: "abc123" })] },
    { result: ok() },
  ]);
  const executor = new RcloneMountedResticExecutor(config(), runner);
  const result = await executor.execute(backupJob({
    sourceEndpointId: "gdrive",
    repositoryId: "repo-main",
    tags: ["cloud", "nightly"],
    mountPoint: "/attacker-controlled",
  }), new AbortController().signal);

  assert.equal(result.status, "completed");
  assert.equal(runner.calls.length, 3);

  const mount = runner.calls[0];
  assert.equal(mount.executable, "/usr/local/bin/rclone");
  assert.deepEqual(mount.args.slice(0, 3), ["mount", "gdrive:", "/state/mounts/gdrive"]);
  assert.ok(mount.args.includes("--daemon"));
  assert.ok(mount.args.includes("--read-only"));
  assert.deepEqual(mount.args.slice(mount.args.indexOf("--daemon-wait"), mount.args.indexOf("--daemon-wait") + 2), ["--daemon-wait", "45s"]);
  assert.deepEqual(mount.args.slice(mount.args.indexOf("--vfs-cache-mode"), mount.args.indexOf("--vfs-cache-mode") + 2), ["--vfs-cache-mode", "full"]);
  assert.deepEqual(mount.args.slice(mount.args.indexOf("--vfs-cache-max-size"), mount.args.indexOf("--vfs-cache-max-size") + 2), ["--vfs-cache-max-size", "50G"]);
  assert.deepEqual(mount.args.slice(mount.args.indexOf("--config"), mount.args.indexOf("--config") + 2), ["--config", "/config/rclone/rclone.conf"]);

  const restic = runner.calls[1];
  assert.equal(restic.executable, "/usr/local/bin/restic");
  assert.deepEqual(restic.args, [
    "backup", "--json",
    "--tag", "cloud",
    "--tag", "nightly",
    "--", "/state/mounts/gdrive",
  ]);
  assert.equal(restic.env.RESTIC_REPOSITORY, "/backup/restic/gdrive");

  const unmount = runner.calls[2];
  assert.equal(unmount.executable, "/usr/bin/fusermount3");
  assert.deepEqual(unmount.args, ["-u", "/state/mounts/gdrive"]);
});

test("restic partial result still releases the rclone mount", async () => {
  const runner = new SequenceRunner([
    { result: ok() },
    { result: ok({ exitCode: 3, stderrTail: "one file unreadable" }) },
    { result: ok() },
  ]);
  const result = await new RcloneMountedResticExecutor(config(), runner).execute(
    backupJob({ sourceEndpointId: "gdrive", repositoryId: "repo-main" }),
    new AbortController().signal,
  );
  assert.equal(result.status, "partial");
  assert.equal(runner.calls.length, 3);
  assert.equal(runner.calls[2].executable, "/usr/bin/fusermount3");
});

test("fatal restic failure still releases the rclone mount", async () => {
  const runner = new SequenceRunner([
    { result: ok() },
    { result: ok({ exitCode: 1, stderrTail: "repository unavailable" }) },
    { result: ok() },
  ]);
  await assert.rejects(
    () => new RcloneMountedResticExecutor(config(), runner).execute(
      backupJob({ sourceEndpointId: "gdrive", repositoryId: "repo-main" }),
      new AbortController().signal,
    ),
    (error) => error instanceof ToolExitError && error.tool === "restic",
  );
  assert.equal(runner.calls.length, 3);
  assert.equal(runner.calls[2].executable, "/usr/bin/fusermount3");
});

test("mount cleanup failure is surfaced instead of silently leaking a mount", async () => {
  const runner = new SequenceRunner([
    { result: ok() },
    { result: ok() },
    { result: ok({ exitCode: 1, stderrTail: "target is busy" }) },
  ]);
  await assert.rejects(
    () => new RcloneMountedResticExecutor(config(), runner).execute(
      backupJob({ sourceEndpointId: "gdrive", repositoryId: "repo-main" }),
      new AbortController().signal,
    ),
    (error) => error instanceof ToolExitError && error.tool === "rclone unmount" && error.stderrTail === "target is busy",
  );
});

test("remote backup refuses endpoints without a local mount policy", async () => {
  const runner = new SequenceRunner([]);
  await assert.rejects(
    () => new RcloneMountedResticExecutor(config(false), runner).execute(
      backupJob({ sourceEndpointId: "gdrive", repositoryId: "repo-main" }),
      new AbortController().signal,
    ),
    /not configured for mounting/,
  );
  assert.equal(runner.calls.length, 0);
});
