import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { JobService, transitionJob } from "../../../packages/core/dist/index.js";
import { AgentRunner, HttpControlPlaneClient } from "../../agent/dist/index.js";
import { createApi, D1JobRepository, hashAgentToken } from "../dist/index.js";

const CONTROL_TOKEN = "control-plane-test-secret";
const AGENT_TOKEN = "agent-token-abcdefghijklmnopqrstuvwxyz-123456";
const SECOND_AGENT_TOKEN = "second-agent-token-abcdefghijklmnopqrstuvwxyz";

class SqliteD1Statement {
  constructor(db, sql, bindings = []) {
    this.db = db;
    this.sql = sql;
    this.bindings = bindings;
  }

  bind(...values) { return new SqliteD1Statement(this.db, this.sql, values); }

  async first(columnName) {
    const row = this.db.prepare(this.sql).get(...this.bindings);
    if (row === undefined) return null;
    if (columnName !== undefined) return row[columnName] ?? null;
    return row;
  }

  _executeSync() {
    const statement = this.db.prepare(this.sql);
    if (statement.columns().length > 0) {
      return { success: true, results: statement.all(...this.bindings), meta: { changes: 0 } };
    }
    const result = statement.run(...this.bindings);
    return {
      success: true,
      results: [],
      meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) },
    };
  }

  async all() { return this._executeSync(); }
  async run() { return this._executeSync(); }
}

class SqliteD1 {
  constructor() { this.sqlite = new DatabaseSync(":memory:"); }
  prepare(sql) { return new SqliteD1Statement(this.sqlite, sql); }
  async batch(statements) {
    this.sqlite.exec("BEGIN");
    try {
      const results = statements.map((statement) => statement._executeSync());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
  exec(sql) { this.sqlite.exec(sql); }
  get(sql, ...bindings) { return this.sqlite.prepare(sql).get(...bindings); }
  close() { this.sqlite.close(); }
}

async function fixture() {
  const db = new SqliteD1();
  const migration = await readFile(new URL("../../../migrations/0001_control_plane.sql", import.meta.url), "utf8");
  db.exec(migration);
  let now = new Date("2026-09-12T10:00:00.000Z");
  let id = 0;
  let lease = 0;
  const api = createApi({
    now: () => new Date(now),
    id: () => `id-${++id}`,
    leaseToken: () => `lease-${++lease}`,
  });
  const env = { DB: db, CONTROL_PLANE_TOKEN: CONTROL_TOKEN, DEFAULT_LEASE_TTL_MS: "5000" };
  return {
    db,
    api,
    env,
    setNow(value) { now = new Date(value); },
    advance(ms) { now = new Date(now.getTime() + ms); },
  };
}

async function request(api, env, path, { method = "GET", token, body } = {}) {
  const headers = new Headers();
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (body !== undefined) headers.set("content-type", "application/json");
  return api.fetch(new Request(`https://nexus-backup.test${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env);
}

async function registerAgent(f, id = "agent-a", token = AGENT_TOKEN) {
  const response = await request(f.api, f.env, "/v1/agents", {
    method: "POST",
    token: CONTROL_TOKEN,
    body: { id, name: id, token },
  });
  assert.equal(response.status, 201, await response.text());
}

async function createJob(f, operationKey = "op-1") {
  const response = await request(f.api, f.env, "/v1/jobs", {
    method: "POST",
    token: CONTROL_TOKEN,
    body: { operationKey, type: "backup", payload: { source: "gdrive" } },
  });
  if (response.status !== 201) throw new Error(`create job failed: ${response.status} ${await response.text()}`);
  return (await response.json()).job;
}

test("agent registration stores a SHA-256 hash, never the raw token", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  await registerAgent(f);
  const row = f.db.get("SELECT token_hash FROM backup_agents WHERE id = ?", "agent-a");
  assert.equal(row.token_hash, await hashAgentToken(AGENT_TOKEN));
  assert.notEqual(row.token_hash, AGENT_TOKEN);
});

test("control endpoints reject missing control authentication", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  const response = await request(f.api, f.env, "/v1/jobs", {
    method: "POST",
    body: { operationKey: "op", type: "backup", payload: {} },
  });
  assert.equal(response.status, 401);
});

test("job creation is idempotent and agent claim is exclusive", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  await registerAgent(f);
  await registerAgent(f, "agent-b", SECOND_AGENT_TOKEN);
  const first = await createJob(f, "nightly:gdrive:2026-09-12");
  const second = await createJob(f, "nightly:gdrive:2026-09-12");
  assert.equal(first.id, second.id);

  const [a, b] = await Promise.all([
    request(f.api, f.env, "/v1/agent/claim", { method: "POST", token: AGENT_TOKEN, body: { leaseTtlMs: 5000 } }),
    request(f.api, f.env, "/v1/agent/claim", { method: "POST", token: SECOND_AGENT_TOKEN, body: { leaseTtlMs: 5000 } }),
  ]);
  const statuses = [a.status, b.status].sort((x, y) => x - y);
  assert.deepEqual(statuses, [200, 204]);
  const claimedResponse = a.status === 200 ? a : b;
  const claimed = await claimedResponse.json();
  assert.equal(claimed.job.state, "leased");
  assert.equal(claimed.job.attempt, 1);
  assert.equal(claimed.job.revision, 1);
});

test("wrong agent cannot use another agent lease token", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  await registerAgent(f);
  await registerAgent(f, "agent-b", SECOND_AGENT_TOKEN);
  await createJob(f);
  const claim = await request(f.api, f.env, "/v1/agent/claim", { method: "POST", token: AGENT_TOKEN, body: {} });
  const grant = await claim.json();
  const response = await request(f.api, f.env, `/v1/agent/jobs/${grant.job.id}/heartbeat`, {
    method: "POST",
    token: SECOND_AGENT_TOKEN,
    body: { leaseToken: grant.leaseToken },
  });
  assert.equal(response.status, 409);
});

test("D1 compare-and-swap prevents stale writes", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  const repo = new D1JobRepository(f.env.DB);
  let event = 0;
  const service = new JobService(repo, { eventIdFactory: () => `event-${++event}` });
  await service.create({ id: "job-cas", operationKey: "cas", type: "backup", payload: {} }, new Date("2026-09-12T10:00:00Z"));
  const leased = await service.acquire({ jobId: "job-cas", agentId: "agent-a", token: "lease-a", now: new Date("2026-09-12T10:00:00Z"), ttlMs: 5000 });
  const first = transitionJob(leased, "running", new Date("2026-09-12T10:00:01Z"));
  const stale = transitionJob(leased, "running", new Date("2026-09-12T10:00:02Z"));
  assert.ok(await repo.save(first, leased.revision, { id: "cas-event-1", type: "job.transitioned", at: "2026-09-12T10:00:01.000Z", data: {} }));
  assert.equal(await repo.save(stale, leased.revision, { id: "cas-event-2", type: "job.transitioned", at: "2026-09-12T10:00:02.000Z", data: {} }), null);
});

test("job mutation rolls back when its event cannot be committed", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  const repo = new D1JobRepository(f.env.DB);
  let event = 0;
  const service = new JobService(repo, { eventIdFactory: () => `rollback-event-${++event}` });
  await service.create({ id: "job-rollback", operationKey: "rollback", type: "backup", payload: {} }, new Date("2026-09-12T10:00:00Z"));
  const leased = await service.acquire({ jobId: "job-rollback", agentId: "agent-a", token: "lease-a", now: new Date("2026-09-12T10:00:00Z"), ttlMs: 5000 });
  await repo.appendEvent({ id: "duplicate-event", jobId: leased.id, type: "job.note", at: "2026-09-12T10:00:00.500Z", data: {} });
  const next = transitionJob(leased, "running", new Date("2026-09-12T10:00:01Z"));
  await assert.rejects(() => repo.save(next, leased.revision, { id: "duplicate-event", type: "job.transitioned", at: "2026-09-12T10:00:01Z", data: {} }));
  const persisted = await repo.get(leased.id);
  assert.equal(persisted.state, "leased");
  assert.equal(persisted.revision, leased.revision);
});

test("scheduled recovery requeues expired jobs without racing a newer revision", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  await registerAgent(f);
  const job = await createJob(f);
  const claim = await request(f.api, f.env, "/v1/agent/claim", { method: "POST", token: AGENT_TOKEN, body: { leaseTtlMs: 5000 } });
  const grant = await claim.json();
  let response = await request(f.api, f.env, `/v1/agent/jobs/${job.id}/transition`, {
    method: "POST", token: AGENT_TOKEN, body: { leaseToken: grant.leaseToken, state: "running" },
  });
  assert.equal(response.status, 200, await response.text());

  f.advance(5001);
  assert.equal(await f.api.recover(f.env), 1);
  response = await request(f.api, f.env, `/v1/jobs/${job.id}`, { token: CONTROL_TOKEN });
  const recovered = (await response.json()).job;
  assert.equal(recovered.state, "queued");
  assert.equal(recovered.lease, null);

  const nextClaim = await request(f.api, f.env, "/v1/agent/claim", { method: "POST", token: AGENT_TOKEN, body: {} });
  assert.equal(nextClaim.status, 200);
  assert.equal((await nextClaim.json()).job.attempt, 2);
});

test("real HTTP client and AgentRunner complete a job end-to-end", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  await registerAgent(f);
  const created = await createJob(f, "runner-e2e");

  const fetchImpl = (input, init) => f.api.fetch(new Request(input, init), f.env);
  const client = new HttpControlPlaneClient({
    baseUrl: "https://nexus-backup.test",
    agentToken: AGENT_TOKEN,
    leaseTtlMs: 5000,
    version: "0.2.0-test",
    fetchImpl,
  });
  const executor = { async execute(job) { assert.equal(job.id, created.id); return { status: "completed" }; } };
  const runner = new AgentRunner({ agentId: "agent-a", controlPlane: client, executor });
  const result = await runner.runOne();
  assert.equal(result.state, "completed");

  const response = await request(f.api, f.env, `/v1/jobs/${created.id}`, { token: CONTROL_TOKEN });
  const persisted = (await response.json()).job;
  assert.equal(persisted.state, "completed");
  assert.equal(persisted.lease, null);

  const eventsResponse = await request(f.api, f.env, `/v1/jobs/${created.id}/events`, { token: CONTROL_TOKEN });
  const events = (await eventsResponse.json()).events;
  assert.deepEqual(events.map((event) => event.type), [
    "job.created",
    "job.leased",
    "job.transitioned",
    "job.transitioned",
    "job.transitioned",
    "job.transitioned",
  ]);
  const agent = f.db.get("SELECT last_seen_at, version FROM backup_agents WHERE id = ?", "agent-a");
  assert.ok(agent.last_seen_at);
  assert.equal(agent.version, "0.2.0-test");
});
