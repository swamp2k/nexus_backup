import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const KEYS = {
  exposure: "exposure",
  host: "host",
  listenPort: "listen-port",
  endpointPort: "endpoint-port",
  appendOnly: "append-only",
};

export function createRepositorySettingsService({
  configDir = process.env.NEXUS_BACKUP_REPOSITORY_CONFIG_DIR?.trim() || "/config/repository",
  runtimeDir = process.env.NEXUS_BACKUP_RUNTIME_DIR?.trim() || "/run/nexus-backup",
  env = process.env,
} = {}) {
  const settingsDir = join(configDir, "settings");
  const activePath = join(runtimeDir, "repository-active.json");

  async function get() {
    const configured = await readConfigured(settingsDir, env);
    const active = await readActive(activePath);
    return {
      configured,
      active,
      restartRequired: Boolean(active && !sameSettings(configured, active)),
      protections: {
        tls: true,
        tlsMinVersion: "1.3",
        bcryptAuth: true,
        privateRepositories: true,
        appendOnly: configured.appendOnly,
        rateLimit: false,
        bruteForceLockout: false,
      },
    };
  }

  async function update(input) {
    const current = await readConfigured(settingsDir, env);
    const next = normalize({ ...current, ...pickInput(input) });
    await mkdir(settingsDir, { recursive: true, mode: 0o700 });
    await Promise.all([
      writeAtomic(join(settingsDir, KEYS.exposure), next.exposure),
      writeAtomic(join(settingsDir, KEYS.host), next.host),
      writeAtomic(join(settingsDir, KEYS.listenPort), String(next.listenPort)),
      writeAtomic(join(settingsDir, KEYS.endpointPort), String(next.endpointPort)),
      writeAtomic(join(settingsDir, KEYS.appendOnly), String(next.appendOnly)),
    ]);
    const active = await readActive(activePath);
    return {
      configured: next,
      active,
      restartRequired: !active || !sameSettings(next, active),
      protections: {
        tls: true,
        tlsMinVersion: "1.3",
        bcryptAuth: true,
        privateRepositories: true,
        appendOnly: next.appendOnly,
        rateLimit: false,
        bruteForceLockout: false,
      },
    };
  }

  return { get, update };
}

async function readConfigured(settingsDir, env) {
  const exposure = await readSetting(settingsDir, KEYS.exposure)
    ?? env.NEXUS_BACKUP_REPOSITORY_EXPOSURE?.trim()
    ?? "lan";
  const host = await readSetting(settingsDir, KEYS.host)
    ?? env.NEXUS_BACKUP_REPOSITORY_HOST?.trim()
    ?? "";
  const listenPort = await readSetting(settingsDir, KEYS.listenPort)
    ?? env.NEXUS_BACKUP_REPOSITORY_PORT?.trim()
    ?? "8000";
  const endpointPort = await readSetting(settingsDir, KEYS.endpointPort)
    ?? env.NEXUS_BACKUP_REPOSITORY_ENDPOINT_PORT?.trim()
    ?? listenPort;
  const appendFile = await readSetting(settingsDir, KEYS.appendOnly);
  const appendEnv = env.NEXUS_BACKUP_REPOSITORY_APPEND_ONLY?.trim();
  const appendOnly = appendFile ?? appendEnv ?? (exposure === "internet" ? "true" : "false");
  return normalize({ exposure, host, listenPort, endpointPort, appendOnly });
}

async function readActive(path) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return normalize(parsed);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    return null;
  }
}

function pickInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RangeError("Repository settings body must be an object");
  const result = {};
  for (const key of ["exposure", "host", "listenPort", "endpointPort", "appendOnly"]) {
    if (Object.hasOwn(value, key)) result[key] = value[key];
  }
  return result;
}

function normalize(value) {
  const exposure = String(value.exposure ?? "").trim();
  if (exposure !== "lan" && exposure !== "internet") throw new RangeError("Repository exposure must be lan or internet");

  const host = String(value.host ?? "").trim();
  if (!host) throw new RangeError("Repository endpoint host is required");
  if (!/^[A-Za-z0-9.-]+$/.test(host)) throw new RangeError("Repository endpoint host contains unsupported characters");

  const listenPort = port(value.listenPort, "Repository listen port");
  const endpointPort = port(value.endpointPort, "Repository endpoint port");
  const appendOnly = boolean(value.appendOnly, "Repository append-only");

  return { exposure, host, listenPort, endpointPort, appendOnly };
}

function port(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) throw new RangeError(`${name} must be between 1 and 65535`);
  return parsed;
}

function boolean(value, name) {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new RangeError(`${name} must be true or false`);
}

async function readSetting(dir, name) {
  try {
    const value = (await readFile(join(dir, name), "utf8")).trim();
    return value || null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function writeAtomic(path, value) {
  const temporary = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  await writeFile(temporary, `${value}\n`, { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

function sameSettings(left, right) {
  return left.exposure === right.exposure
    && left.host === right.host
    && left.listenPort === right.listenPort
    && left.endpointPort === right.endpointPort
    && left.appendOnly === right.appendOnly;
}
