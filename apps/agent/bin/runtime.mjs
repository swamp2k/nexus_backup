import { readFile } from "node:fs/promises";
import {
  AgentRunner,
  HttpControlPlaneClient,
  StaticAgentRuntimeConfig,
  createDefaultJobExecutor,
} from "../dist/index.js";

export async function loadRuntimeConfig(configPath) {
  let raw;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    throw new Error(`Unable to read agent config: ${configPath}`, { cause: error });
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Agent config is not valid JSON: ${configPath}`, { cause: error });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Agent config root must be an object");
  }
  return new StaticAgentRuntimeConfig(parsed);
}

export function runtimeOptionsFromEnv(env = process.env) {
  const leaseTtlRaw = optionalString(env.NEXUS_BACKUP_LEASE_TTL_MS);
  return {
    baseUrl: requireString(env.NEXUS_BACKUP_URL, "NEXUS_BACKUP_URL"),
    agentToken: requireString(env.NEXUS_BACKUP_AGENT_TOKEN, "NEXUS_BACKUP_AGENT_TOKEN"),
    agentId: requireString(env.NEXUS_BACKUP_AGENT_ID, "NEXUS_BACKUP_AGENT_ID"),
    configPath: optionalString(env.NEXUS_BACKUP_CONFIG) ?? "/config/agent.json",
    pollIntervalMs: positiveInteger(env.NEXUS_BACKUP_POLL_INTERVAL_MS ?? "5000", "NEXUS_BACKUP_POLL_INTERVAL_MS"),
    version: optionalString(env.NEXUS_BACKUP_AGENT_VERSION) ?? "0.5.0",
    ...(leaseTtlRaw === undefined ? {} : {
      leaseTtlMs: positiveInteger(leaseTtlRaw, "NEXUS_BACKUP_LEASE_TTL_MS"),
    }),
  };
}

export async function createAgentRuntime(options, { log = defaultLog } = {}) {
  const config = await loadRuntimeConfig(options.configPath);
  const events = {
    emit(event) {
      log("info", "execution event", { event });
    },
  };
  const executor = createDefaultJobExecutor(config, events);
  const controlPlane = new HttpControlPlaneClient({
    baseUrl: options.baseUrl,
    agentToken: options.agentToken,
    version: options.version,
    ...(options.leaseTtlMs === undefined ? {} : { leaseTtlMs: options.leaseTtlMs }),
  });
  const runner = new AgentRunner({
    agentId: options.agentId,
    controlPlane,
    executor,
  });
  return { config, controlPlane, executor, runner };
}

export async function runAgentLoop(
  runner,
  {
    signal,
    pollIntervalMs,
    log = defaultLog,
    sleep = abortableSleep,
  },
) {
  while (!signal.aborted) {
    try {
      const job = await runner.runOne(signal);
      if (job) {
        log("info", "job finished", { jobId: job.id, state: job.state });
        continue;
      }
      if (signal.aborted) break;
      await sleep(pollIntervalMs, signal);
    } catch (error) {
      if (signal.aborted) break;
      log("error", "agent iteration failed", { error: serializeError(error) });
      await sleep(pollIntervalMs, signal);
    }
  }
}

export function defaultLog(level, message, data = {}) {
  const line = JSON.stringify({
    at: new Date().toISOString(),
    level,
    component: "nexus-backup-agent",
    message,
    ...data,
  });
  if (level === "error") console.error(line);
  else console.log(line);
}

export function abortableSleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

function serializeError(error) {
  if (error instanceof AggregateError) {
    return {
      name: error.name,
      message: error.message,
      errors: error.errors.map(serializeError),
    };
  }
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { name: "Error", message: String(error) };
}

function requireString(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be set to a non-empty value`);
  return value.trim();
}

function optionalString(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value.trim();
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${name} must be a positive integer`);
  return number;
}
