import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
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
