import assert from "node:assert/strict";
import test from "node:test";
import { AgentRunner, HttpControlPlaneClient } from "../dist/index.js";

function job() {
  return {
    id: "job-1",
    operationKey: "op-1",
    type: "backup",
    state: "leased",
    attempt: 1,
    revision: 1,
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

test("HTTP client maps claim, heartbeat and transition endpoints", async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init, body: JSON.parse(init.body) });
    if (String(url).endsWith("/claim")) {
      return Response.json({ job: job(), leaseToken: "lease-1", leaseTtlMs: 5000 });
    }
    return Response.json({ ok: true });
  };
  const client = new HttpControlPlaneClient({ baseUrl: "https://backup.example/", agentToken: "agent-secret", leaseTtlMs: 5000, version: "0.2.0", fetchImpl });
  const grant = await client.claim("agent-a");
  assert.equal(grant.leaseToken, "lease-1");
  await client.heartbeat("job-1", "agent-a", "lease-1");
  await client.transition("job-1", "agent-a", "lease-1", "running");
  assert.equal(requests.length, 3);
  assert.equal(requests[0].init.headers.authorization, "Bearer agent-secret");
  assert.equal(requests[0].body.version, "0.2.0");
});

test("runner stops heartbeats before finalizing over a slow control plane", async () => {
  let heartbeats = 0;
  let finalizingStarted = false;
  let heartbeatDuringFinalizing = false;
  const controlPlane = {
    async claim() { return { job: job(), leaseToken: "lease-token", leaseTtlMs: 300 }; },
    async heartbeat() {
      heartbeats += 1;
      if (finalizingStarted) heartbeatDuringFinalizing = true;
    },
    async transition(_jobId, _agentId, _token, state) {
      if (state === "finalizing") {
        finalizingStarted = true;
        await new Promise((resolve) => setTimeout(resolve, 220));
      }
    },
  };
  const executor = {
    async execute() {
      await new Promise((resolve) => setTimeout(resolve, 130));
      return { status: "completed" };
    },
  };
  const runner = new AgentRunner({ agentId: "agent-a", controlPlane, executor, maxHeartbeatMs: 5_000 });
  await runner.runOne();
  assert.ok(heartbeats >= 1);
  assert.equal(heartbeatDuringFinalizing, false);
});

test("heartbeat failure aborts execution and is reported as failed", async () => {
  const transitions = [];
  let executionAborted = false;
  const controlPlane = {
    async claim() { return { job: job(), leaseToken: "lease-token", leaseTtlMs: 300 }; },
    async heartbeat() { throw new Error("heartbeat lost"); },
    async transition(_jobId, _agentId, _token, state, error) { transitions.push([state, error]); },
  };
  const executor = {
    async execute(_job, signal) {
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      executionAborted = true;
      throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
    },
  };
  const runner = new AgentRunner({ agentId: "agent-a", controlPlane, executor, maxHeartbeatMs: 5_000 });
  await assert.rejects(() => runner.runOne(), /heartbeat lost/);
  assert.equal(executionAborted, true);
  assert.deepEqual(transitions.at(-1), ["failed", "heartbeat lost"]);
});
