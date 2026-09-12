import assert from "node:assert/strict";
import test from "node:test";
import { AgentRunner } from "../dist/index.js";

function job() {
  return {
    id: "job-1",
    operationKey: "op-1",
    type: "backup",
    state: "leased",
    attempt: 1,
    payload: {},
    lease: null,
    createdAt: "2026-09-12T08:00:00.000Z",
    updatedAt: "2026-09-12T08:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    lastError: null,
  };
}

test("runner executes the expected lifecycle", async () => {
  const transitions = [];
  const controlPlane = {
    async claim() { return { job: job(), leaseToken: "lease-token", leaseTtlMs: 60_000 }; },
    async heartbeat() {},
    async transition(_jobId, _agentId, _token, state) { transitions.push(state); },
  };
  const executor = { async execute() { return { status: "completed" }; } };

  const runner = new AgentRunner({ agentId: "agent-a", controlPlane, executor });
  const result = await runner.runOne();

  assert.equal(result.state, "completed");
  assert.deepEqual(transitions, ["preparing", "running", "finalizing", "completed"]);
});

test("runner marks execution errors as failed", async () => {
  const transitions = [];
  const controlPlane = {
    async claim() { return { job: job(), leaseToken: "lease-token", leaseTtlMs: 60_000 }; },
    async heartbeat() {},
    async transition(_jobId, _agentId, _token, state, error) { transitions.push([state, error]); },
  };
  const executor = { async execute() { throw new Error("boom"); } };

  const runner = new AgentRunner({ agentId: "agent-a", controlPlane, executor });
  await assert.rejects(() => runner.runOne(), /boom/);
  assert.deepEqual(transitions, [
    ["preparing", undefined],
    ["running", undefined],
    ["failed", "boom"],
  ]);
});

test("runner heartbeats before a short lease expires", async () => {
  let heartbeats = 0;
  const controlPlane = {
    async claim() { return { job: job(), leaseToken: "lease-token", leaseTtlMs: 450 }; },
    async heartbeat() { heartbeats += 1; },
    async transition() {},
  };
  const executor = {
    async execute() {
      await new Promise((resolve) => setTimeout(resolve, 240));
      return { status: "completed" };
    },
  };

  const runner = new AgentRunner({ agentId: "agent-a", controlPlane, executor, maxHeartbeatMs: 5_000 });
  await runner.runOne();
  assert.ok(heartbeats >= 1);
});
