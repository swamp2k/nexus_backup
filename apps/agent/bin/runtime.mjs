import { readFile } from "node:fs/promises";
import {
  AgentRunner,
  HttpControlPlaneClient,
  StaticAgentRuntimeConfig,
  createDefaultJobExecutor,
  redactTelemetryText,
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
  const agentToken = optionalString(env.NEXUS_BACKUP_AGENT_TOKEN);
  const agentTokenFile = optionalString(env.NEXUS_BACKUP_AGENT_TOKEN_FILE);
  if (agentToken === undefined && agentTokenFile === undefined) {
    throw new Error("NEXUS_BACKUP_AGENT_TOKEN or NEXUS_BACKUP_AGENT_TOKEN_FILE must be set");
  }
  return {
    baseUrl: requireString(env.NEXUS_BACKUP_URL, "NEXUS_BACKUP_URL"),
    ...(agentToken === undefined ? {} : { agentToken }),
    ...(agentTokenFile === undefined ? {} : { agentTokenFile }),
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
  const agentToken = options.agentToken ?? await loadSecret(options.agentTokenFile);
  const controlPlane = new HttpControlPlaneClient({
    baseUrl: options.baseUrl,
    agentToken,
    version: options.version,
    ...(options.leaseTtlMs === undefined ? {} : { leaseTtlMs: options.leaseTtlMs }),
  });
  const telemetry = createBufferedTelemetrySink(controlPlane, options.agentId, { log });
  const baseExecutor = createDefaultJobExecutor(config, telemetry);
  const executor = {
    async execute(job, signal) {
      telemetry.begin(job);
      try {
        return await baseExecutor.execute(job, signal);
      } finally {
        await telemetry.end();
      }
    },
  };
  const redactMessage = (message) => redactTelemetryText(message, config.telemetryRedactionValues ?? []);
  const runner = new AgentRunner({
    agentId: options.agentId,
    controlPlane,
    executor,
    redactMessage,
  });
  return { config, controlPlane, executor, runner, telemetry };
}

export function createBufferedTelemetrySink(
  controlPlane,
  agentId,
  {
    log = defaultLog,
    flushIntervalMs = 1000,
    maxBatchSize = 50,
    maxBufferSize = 500,
    now = () => new Date(),
  } = {},
) {
  let context = null;
  let buffer = [];
  let timer = null;
  let flushing = null;

  function clearTimer() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  function schedule() {
    if (timer !== null || !context || buffer.length === 0) return;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, flushIntervalMs);
    timer.unref?.();
  }

  async function flush() {
    if (flushing) return flushing;
    if (!context || buffer.length === 0) return;
    clearTimer();
    const activeContext = context;

    flushing = (async () => {
      while (context === activeContext && buffer.length > 0) {
        const batch = buffer.splice(0, maxBatchSize);
        try {
          await controlPlane.runtimeEvents(
            activeContext.jobId,
            agentId,
            activeContext.leaseToken,
            batch,
          );
        } catch (error) {
          log("error", "runtime telemetry delivery failed", {
            jobId: activeContext.jobId,
            dropped: batch.length,
            error: serializeError(error),
          });
          break;
        }
      }
    })().finally(() => {
      flushing = null;
      if (context === activeContext && buffer.length > 0) schedule();
    });

    return flushing;
  }

  return {
    begin(job) {
      clearTimer();
      buffer = [];
      const leaseToken = job?.lease?.token;
      context = typeof job?.id === "string" && typeof leaseToken === "string" && leaseToken
        ? { jobId: job.id, leaseToken }
        : null;
      if (!context) log("error", "runtime telemetry disabled for job without lease context", { jobId: job?.id });
    },

    emit(event) {
      log("info", "execution event", { event: compactEventForLog(event) });
      if (!context) return;
      const item = { ...event, at: now().toISOString() };
      if (event.type === "progress") {
        const index = buffer.findIndex((candidate) => candidate.type === "progress" && candidate.tool === event.tool);
        if (index >= 0) buffer.splice(index, 1);
      }
      buffer.push(item);
      while (buffer.length > maxBufferSize) {
        const logIndex = buffer.findIndex((candidate) => candidate.type === "log");
        buffer.splice(logIndex >= 0 ? logIndex : 0, 1);
      }
      if (buffer.length >= maxBatchSize) void flush();
      else schedule();
    },

    async flush() {
      await flush();
    },

    async end() {
      clearTimer();
      await flush();
      context = null;
      buffer = [];
    },
  };
}

export async function loadSecret(path) {
  if (typeof path !== "string" || !path.trim()) throw new Error("Secret file path must be a non-empty string");
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`Unable to read agent token file: ${path}`, { cause: error });
  }
  const token = raw.trim();
  if (!token) throw new Error(`Agent token file is empty: ${path}`);
  return token;
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

function compactEventForLog(event) {
  if (event?.type === "inventory") {
    return {
      type: "inventory",
      tool: event.tool,
      repositoryId: event.repositoryId,
      snapshots: Array.isArray(event.snapshots) ? event.snapshots.length : 0,
      snapshotLimit: event.snapshotLimit,
      truncated: event.truncated,
    };
  }
  if (event?.type === "snapshot-browse") {
    return {
      type: "snapshot-browse",
      tool: event.tool,
      repositoryId: event.repositoryId,
      snapshotId: typeof event.snapshotId === "string" ? event.snapshotId.slice(0, 12) : null,
      entries: Array.isArray(event.entries) ? event.entries.length : 0,
      entryLimit: event.entryLimit,
      truncated: event.truncated,
    };
  }
  if (event?.type === "transfer-discovery") {
    return {
      type: "transfer-discovery",
      tool: event.tool,
      ruleId: event.ruleId,
      entries: Array.isArray(event.entries) ? event.entries.length : 0,
    };
  }
  if (event?.type === "transfer-groups") {
    return {
      type: "transfer-groups",
      tool: event.tool,
      ruleId: event.ruleId,
      groups: Array.isArray(event.groups) ? event.groups.length : 0,
    };
  }
  return event;
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

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function optionalString(value) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function requireString(value, name) {
  const normalized = optionalString(value);
  if (!normalized) throw new Error(`${name} must be set`);
  return normalized;
}
