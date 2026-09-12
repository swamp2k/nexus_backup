import assert from "node:assert/strict";
import test from "node:test";
import {
  ConcurrentMutationError,
  InvalidJobTransitionError,
  JobService,
  LeaseConflictError,
  MemoryJobRepository,
  transitionJob,
} from "../dist/index.js";

const base = new Date("2026-09-12T08:00:00.000Z");
const plus = (ms) => new Date(base.getTime() + ms);

function createService() {
  let event = 0;
  const repo = new MemoryJobRepository();
  const service = new JobService(repo, { eventIdFactory: () => `evt-${++event}` });
  return { repo, service };
}

test("create is idempotent by operationKey", async () => {
  const { repo, service } = createService();
  const first = await service.create({ id: "job-1", operationKey: "nightly:gdrive:2026-09-12", type: "backup", payload: {} }, base);
  const second = await service.create({ id: "job-2", operationKey: "nightly:gdrive:2026-09-12", type: "backup", payload: {} }, plus(1));
  assert.equal(first.id, "job-1");
  assert.equal(second.id, "job-1");
  assert.equal(first.revision, 0);
  assert.equal((await repo.listEvents("job-1")).length, 1);
});

test("concurrent create calls converge on one operation", async () => {
  const { repo, service } = createService();
  const [first, second] = await Promise.all([
    service.create({ id: "job-1", operationKey: "same-op", type: "backup", payload: { source: "a" } }, base),
    service.create({ id: "job-2", operationKey: "same-op", type: "backup", payload: { source: "a" } }, base),
  ]);
  assert.equal(first.id, second.id);
  assert.equal((await repo.listEvents(first.id)).filter((event) => event.type === "job.created").length, 1);
});

test("only one agent can hold a live lease", async () => {
  const { service } = createService();
  await service.create({ id: "job-1", operationKey: "op-1", type: "backup", payload: {} }, base);
  const leased = await service.acquire({ jobId: "job-1", agentId: "agent-a", token: "token-a", now: base, ttlMs: 30_000 });
  assert.equal(leased.state, "leased");
  assert.equal(leased.attempt, 1);
  assert.equal(leased.revision, 1);
  await assert.rejects(
    () => service.acquire({ jobId: "job-1", agentId: "agent-b", token: "token-b", now: plus(5_000), ttlMs: 30_000 }),
    LeaseConflictError,
  );
});

test("claim atomically gives a queued job to one agent", async () => {
  const { service } = createService();
  await service.create({ id: "job-1", operationKey: "op-1", type: "backup", payload: {} }, base);
  const [a, b] = await Promise.all([
    service.claim({ agentId: "agent-a", token: "token-a", now: base, ttlMs: 30_000 }),
    service.claim({ agentId: "agent-b", token: "token-b", now: base, ttlMs: 30_000 }),
  ]);
  assert.equal([a, b].filter(Boolean).length, 1);
});

test("heartbeat extends lease and advances revision", async () => {
  const { service } = createService();
  await service.create({ id: "job-1", operationKey: "op-1", type: "backup", payload: {} }, base);
  const leased = await service.acquire({ jobId: "job-1", agentId: "agent-a", token: "token-a", now: base, ttlMs: 30_000 });
  const renewed = await service.heartbeat({ jobId: "job-1", agentId: "agent-a", token: "token-a", now: plus(10_000), ttlMs: 30_000 });
  assert.equal(renewed.lease.expiresAt, plus(40_000).toISOString());
  assert.equal(renewed.revision, leased.revision + 1);
});

test("compare-and-swap rejects stale mutations", async () => {
  const { repo, service } = createService();
  await service.create({ id: "job-1", operationKey: "op-1", type: "backup", payload: {} }, base);
  const leased = await service.acquire({ jobId: "job-1", agentId: "agent-a", token: "token-a", now: base, ttlMs: 30_000 });
  const first = transitionJob(leased, "running", plus(1_000));
  const second = transitionJob(leased, "running", plus(2_000));
  assert.ok(await repo.save(first, leased.revision, { id: "evt-cas-1", type: "job.transitioned", at: plus(1_000).toISOString(), data: {} }));
  assert.equal(await repo.save(second, leased.revision, { id: "evt-cas-2", type: "job.transitioned", at: plus(2_000).toISOString(), data: {} }), null);
});

test("service surfaces concurrent mutation conflicts", async () => {
  const { repo, service } = createService();
  await service.create({ id: "job-1", operationKey: "op-1", type: "backup", payload: {} }, base);
  const leased = await service.acquire({ jobId: "job-1", agentId: "agent-a", token: "token-a", now: base, ttlMs: 30_000 });
  const originalSave = repo.save.bind(repo);
  repo.save = async () => null;
  await assert.rejects(
    () => service.heartbeat({ jobId: "job-1", agentId: "agent-a", token: leased.lease.token, now: plus(1_000), ttlMs: 30_000 }),
    ConcurrentMutationError,
  );
  repo.save = originalSave;
});

test("expired leases recover to queued and may be reacquired", async () => {
  const { repo, service } = createService();
  await service.create({ id: "job-1", operationKey: "op-1", type: "backup", payload: {} }, base);
  await service.acquire({ jobId: "job-1", agentId: "agent-a", token: "token-a", now: base, ttlMs: 10_000 });
  await service.transition("job-1", "agent-a", "token-a", "running", plus(1_000));
  const recovered = await service.recoverExpired(plus(10_001));
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].state, "queued");
  assert.equal(recovered[0].lease, null);
  const leasedAgain = await service.acquire({ jobId: "job-1", agentId: "agent-b", token: "token-b", now: plus(11_000), ttlMs: 10_000 });
  assert.equal(leasedAgain.attempt, 2);
  assert.equal(leasedAgain.lease.agentId, "agent-b");
  assert.ok((await repo.listEvents("job-1")).some((event) => event.type === "job.recovered"));
});

test("interrupted and terminal transitions release the lease", async () => {
  const { service } = createService();
  await service.create({ id: "job-1", operationKey: "op-1", type: "backup", payload: {} }, base);
  await service.acquire({ jobId: "job-1", agentId: "agent-a", token: "token-a", now: base, ttlMs: 30_000 });
  const interrupted = await service.transition("job-1", "agent-a", "token-a", "interrupted", plus(1_000));
  assert.equal(interrupted.lease, null);
  const reacquired = await service.claim({ agentId: "agent-b", token: "token-b", now: plus(1_001), ttlMs: 30_000 });
  assert.equal(reacquired.lease.agentId, "agent-b");
  await service.transition("job-1", "agent-b", "token-b", "running", plus(2_000));
  const completed = await service.transition("job-1", "agent-b", "token-b", "completed", plus(3_000));
  assert.equal(completed.lease, null);
});

test("terminal jobs reject invalid transitions", async () => {
  const { service } = createService();
  await service.create({ id: "job-1", operationKey: "op-1", type: "backup", payload: {} }, base);
  await service.acquire({ jobId: "job-1", agentId: "agent-a", token: "token-a", now: base, ttlMs: 30_000 });
  await service.transition("job-1", "agent-a", "token-a", "running", plus(1_000));
  const completed = await service.transition("job-1", "agent-a", "token-a", "completed", plus(2_000));
  assert.equal(completed.lease, null);
  await assert.rejects(
    () => service.transition("job-1", "agent-a", "token-a", "running", plus(3_000)),
    LeaseConflictError,
  );
});
