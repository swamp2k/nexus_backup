#!/usr/bin/env node
import {
  createAgentRuntime,
  defaultLog,
  loadRuntimeConfig,
  runAgentLoop,
  runtimeOptionsFromEnv,
} from "./runtime.mjs";

async function main() {
  if (process.argv.includes("--check-config")) {
    const configPath = process.env.NEXUS_BACKUP_CONFIG?.trim() || "/config/agent.json";
    await loadRuntimeConfig(configPath);
    defaultLog("info", "agent config is valid", { configPath });
    return;
  }

  const options = runtimeOptionsFromEnv();
  const shutdown = new AbortController();
  const stop = (signalName) => {
    if (shutdown.signal.aborted) return;
    defaultLog("info", "shutdown requested", { signal: signalName });
    shutdown.abort(new Error(signalName));
  };
  process.once("SIGTERM", () => stop("SIGTERM"));
  process.once("SIGINT", () => stop("SIGINT"));

  const { runner } = await createAgentRuntime(options);
  defaultLog("info", "agent online", {
    agentId: options.agentId,
    controlPlane: options.baseUrl,
    configPath: options.configPath,
    version: options.version,
    pollIntervalMs: options.pollIntervalMs,
  });
  await runAgentLoop(runner, {
    signal: shutdown.signal,
    pollIntervalMs: options.pollIntervalMs,
  });
  defaultLog("info", "agent stopped", { agentId: options.agentId });
}

main().catch((error) => {
  defaultLog("error", "agent startup failed", {
    error: {
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error),
    },
  });
  process.exitCode = 1;
});
