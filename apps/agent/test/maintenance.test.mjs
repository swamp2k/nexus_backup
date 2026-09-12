import assert from "node:assert/strict";
import test from "node:test";
import {
  ResticMaintenanceExecutor,
  ResticRepositoryGate,
  ResticRepositoryLockedExecutor,
  StaticAgentRuntimeConfig,
  ToolExitError,
} from "../dist/index.js";

function job(id, type, payload) {
  return {
    id,
    operationKey: `op-${id}`,
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
  constructor(result, lines = {}) { this.result = result; this.lines = lines; this.calls = []; }
  async run(spec, _signal, handlers = {}) {
    this.calls.push(spec);
    for (const line of this.lines.stdout ?? []) handlers.stdout?.(line);
    for (const line of this.lines.stderr ?? []) handlers.stderr?.(line);
    return this.result;
  }
}

function config() {
  return new StaticAgentRuntimeConfig({
    resticRepositories: [{
      id: "repo-main",
      repository: "/backup/restic/main",
      passwordFile: "/config/secrets/restic-password",
      environment: { RESTIC_CACHE_DIR: "/state/restic-cache" },
    }],
    tools: { resticBinary: "/usr/bin/restic" },
  });
}

test("restic maintenance applies a plan-scoped retention policy and prune", async () => {
  const events = [];
  const runner = new FakeRunner(
    { exitCode: 0, signal: null, durationMs: 5, stdoutTail: "", stderrTail: "" },
    { stdout: [JSON.stringify([{ keep: [{ id: "a" }], remove: [{ id: "b" }, { id: "c" }] }])] },
  );
  const executor = new ResticMaintenanceExecutor(config(), runner, { emit: (event) => events.push(event) });
  const result = await executor.execute(job("maint-1", "restic-maintenance", {
    repositoryId: "repo-main",
    planTag: "nexus-plan:plan-1",
    retention: { keepDaily: 7, keepWeekly: 4, keepMonthly: 12 },
    sourceJobId: "backup-1",
  }), new AbortController().signal);

  assert.equal(result.status, "completed");
  assert.equal(runner.calls.length, 1);
  const command = runner.calls[0];
  assert.equal(command.executable, "/usr/bin/restic");
  assert.deepEqual(command.args, [
    "forget", "--json", "--tag", "nexus-plan:plan-1", "--group-by", "",
    "--keep-daily", "7", "--keep-weekly", "4", "--keep-monthly", "12", "--prune",
  ]);
  assert.equal(command.env.RESTIC_REPOSITORY, "/backup/restic/main");
  assert.equal(command.env.RESTIC_PASSWORD_FILE, "/config/secrets/restic-password");
  assert.ok(events.some((event) => event.type === "log" && /remove 2/.test(event.message)));
  assert.equal(events.at(-1).type, "summary");
  assert.equal(events.at(-1).data.operation, "retention-maintenance");
});

test("maintenance rejects unscoped or empty retention and treats restic exit 3 as failure", async () => {
  const runner = new FakeRunner({ exitCode: 0, signal: null, durationMs: 1, stdoutTail: "", stderrTail: "" });
  const executor = new ResticMaintenanceExecutor(config(), runner);
  await assert.rejects(() => executor.execute(job("bad-tag", "restic-maintenance", {
    repositoryId: "repo-main", planTag: "nightly", retention: { keepDaily: 7, keepWeekly: 4, keepMonthly: 12 },
  }), new AbortController().signal), /internal nexus-plan tag/);
  await assert.rejects(() => executor.execute(job("empty", "restic-maintenance", {
    repositoryId: "repo-main", planTag: "nexus-plan:plan-1", retention: { keepDaily: 0, keepWeekly: 0, keepMonthly: 0 },
  }), new AbortController().signal), /keep at least one/);
  assert.equal(runner.calls.length, 0);

  const failedRunner = new FakeRunner({ exitCode: 3, signal: null, durationMs: 1, stdoutTail: "", stderrTail: "could not remove snapshot" });
  await assert.rejects(() => new ResticMaintenanceExecutor(config(), failedRunner).execute(job("failed", "restic-maintenance", {
    repositoryId: "repo-main", planTag: "nexus-plan:plan-1", retention: { keepDaily: 1, keepWeekly: 0, keepMonthly: 0 },
  }), new AbortController().signal), (error) => error instanceof ToolExitError && error.exitCode === 3);
});

test("repository gate serializes restic jobs for the same repository", async () => {
  const gate = new ResticRepositoryGate();
  const order = [];
  let releaseFirst;
  const firstHold = new Promise((resolve) => { releaseFirst = resolve; });
  const inner = {
    async execute(current) {
      order.push(`start:${current.id}`);
      if (current.id === "one") await firstHold;
      order.push(`end:${current.id}`);
      return { status: "completed" };
    },
  };
  const executor = new ResticRepositoryLockedExecutor(inner, gate);
  const one = executor.execute(job("one", "restic-backup", { repositoryId: "repo-main" }), new AbortController().signal);
  await new Promise((resolve) => setImmediate(resolve));
  const two = executor.execute(job("two", "restic-maintenance", { repositoryId: "repo-main" }), new AbortController().signal);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["start:one"]);
  releaseFirst();
  await Promise.all([one, two]);
  assert.deepEqual(order, ["start:one", "end:one", "start:two", "end:two"]);
});
