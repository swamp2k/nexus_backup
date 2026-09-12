import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createBufferedTelemetrySink,
  loadRuntimeConfig,
  loadSecret,
  runAgentLoop,
  runtimeOptionsFromEnv,
} from "../bin/runtime.mjs";

test("runtime config loader constructs the local-only registry from JSON", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nexus-backup-agent-"));
  try {
    const path = join(dir, "agent.json");
    await writeFile(path, JSON.stringify({
      sources: [{ id: "data", paths: ["/data"] }],
      resticRepositories: [{ id: "repo", repository: "/backup/repo" }],
      rcloneEndpoints: [{
        id: "cloud",
        fs: "remote:",
        mount: { mountPoint: "/state/mounts/cloud", vfsCacheMode: "off" },
      }],
    }));
    const config = await loadRuntimeConfig(path);
    assert.deepEqual(config.source("data").paths, ["/data"]);
    assert.equal(config.resticRepository("repo").repository, "/backup/repo");
    assert.equal(config.rcloneEndpoint("cloud").mount.mountPoint, "/state/mounts/cloud");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime options accept either a direct token or shared token file", async () => {
  const direct = runtimeOptionsFromEnv({
    NEXUS_BACKUP_URL: "https://backup.example",
    NEXUS_BACKUP_AGENT_TOKEN: "secret-token",
    NEXUS_BACKUP_AGENT_ID: "unraid-main",
  });
  assert.equal(direct.agentToken, "secret-token");
  assert.equal(direct.configPath, "/config/agent.json");
  assert.equal(direct.pollIntervalMs, 5000);

  const file = runtimeOptionsFromEnv({
    NEXUS_BACKUP_URL: "http://control:8787",
    NEXUS_BACKUP_AGENT_TOKEN_FILE: "/run/nexus-backup/agent-token",
    NEXUS_BACKUP_AGENT_ID: "local-agent",
  });
  assert.equal(file.agentTokenFile, "/run/nexus-backup/agent-token");
  assert.throws(
    () => runtimeOptionsFromEnv({ NEXUS_BACKUP_URL: "https://backup.example", NEXUS_BACKUP_AGENT_ID: "agent" }),
    /NEXUS_BACKUP_AGENT_TOKEN.*NEXUS_BACKUP_AGENT_TOKEN_FILE/,
  );

  const dir = await mkdtemp(join(tmpdir(), "nexus-backup-secret-"));
  try {
    const path = join(dir, "token");
    await writeFile(path, "from-file\n");
    assert.equal(await loadSecret(path), "from-file");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("telemetry sink coalesces progress and flushes logs with the active lease", async () => {
  const calls = [];
  const controlPlane = {
    async runtimeEvents(jobId, agentId, leaseToken, events) {
      calls.push({ jobId, agentId, leaseToken, events });
    },
  };
  let tick = 0;
  const sink = createBufferedTelemetrySink(controlPlane, "local-agent", {
    log() {},
    flushIntervalMs: 60_000,
    maxBatchSize: 50,
    now: () => new Date(`2026-09-12T10:00:0${tick++}.000Z`),
  });

  sink.begin({ id: "job-live", lease: { token: "lease-live" } });
  sink.emit({ type: "progress", tool: "restic", bytesDone: 10, bytesTotal: 100 });
  sink.emit({ type: "progress", tool: "restic", bytesDone: 40, bytesTotal: 100 });
  sink.emit({ type: "log", tool: "restic", stream: "stdout", message: "working" });
  await sink.end();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].jobId, "job-live");
  assert.equal(calls[0].agentId, "local-agent");
  assert.equal(calls[0].leaseToken, "lease-live");
  assert.equal(calls[0].events.length, 2);
  assert.equal(calls[0].events[0].type, "progress");
  assert.equal(calls[0].events[0].bytesDone, 40);
  assert.equal(calls[0].events[1].message, "working");
  assert.ok(calls[0].events.every((event) => typeof event.at === "string"));
});

test("telemetry delivery failures are logged but never fail the backup path", async () => {
  const logs = [];
  const sink = createBufferedTelemetrySink({
    async runtimeEvents() { throw new Error("telemetry offline"); },
  }, "local-agent", {
    log: (level, message, data) => logs.push({ level, message, data }),
    flushIntervalMs: 60_000,
  });

  sink.begin({ id: "job-live", lease: { token: "lease-live" } });
  sink.emit({ type: "progress", tool: "rclone", bytesDone: 1 });
  await assert.doesNotReject(() => sink.end());
  assert.equal(logs.some((entry) => entry.level === "error" && /telemetry delivery failed/.test(entry.message)), true);
});

test("agent loop idles, reports failures, and stops cleanly on abort", async () => {
  const controller = new AbortController();
  const logs = [];
  let calls = 0;
  const runner = {
    async runOne() {
      calls += 1;
      if (calls === 1) return null;
      if (calls === 2) throw new Error("temporary control plane error");
      controller.abort();
      return null;
    },
  };
  const sleeps = [];
  await runAgentLoop(runner, {
    signal: controller.signal,
    pollIntervalMs: 1234,
    log: (level, message, data) => logs.push({ level, message, data }),
    sleep: async (ms) => { sleeps.push(ms); },
  });
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [1234, 1234]);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].level, "error");
  assert.match(logs[0].data.error.message, /temporary control plane error/);
});
