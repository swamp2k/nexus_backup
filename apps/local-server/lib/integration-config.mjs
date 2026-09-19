import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { buildRcloneConnectionString, getRcloneProviders, obscureRcloneValue, testRcloneFs } from "./rclone-providers.mjs";

// A function, not a shared object: every caller needs its own fresh arrays.
// A plain module-level object here would have its sources/rcloneEndpoints
// arrays shared (and then mutated in place) by every path whose file
// doesn't exist yet, leaking writes across unrelated service instances.
function defaultConfig() { return { sources: [], rcloneEndpoints: [], rtorrentGates: [], tools: {} }; }

// The integrations.json file predates this module and is still read directly
// (loadSanitizedIntegrationConfig) for display and by the transfer engine at
// run time. This module owns the read-modify-write side: it never drops
// keys it doesn't understand (rtorrentGates, tools) when saving.
export function createIntegrationConfigService({ path, now = () => new Date(), id = () => randomUUID(), rcloneBinary = "rclone" } = {}) {
  if (!path) throw new TypeError("path is required");

  async function readRaw() {
    let text;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return defaultConfig();
      throw error;
    }
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      throw statusError(500, "The local integration configuration file is corrupt");
    }
    if (!isRecord(value)) return defaultConfig();
    return {
      sources: Array.isArray(value.sources) ? value.sources : [],
      rcloneEndpoints: Array.isArray(value.rcloneEndpoints) ? value.rcloneEndpoints : [],
      rtorrentGates: Array.isArray(value.rtorrentGates) ? value.rtorrentGates : [],
      tools: isRecord(value.tools) ? value.tools : {},
    };
  }

  async function writeRaw(config) {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, path);
  }

  async function listSources() {
    return (await readRaw()).sources.map(presentSource);
  }

  async function createSource(input) {
    const config = await readRaw();
    const newId = requireSourceId(input?.id, config.sources);
    const source = { id: newId, paths: requirePaths(input?.paths) };
    config.sources.push(source);
    await writeRaw(config);
    return presentSource(source);
  }

  async function updateSource(sourceId, input) {
    const config = await readRaw();
    const index = config.sources.findIndex((item) => item.id === sourceId);
    if (index === -1) throw statusError(404, `Source not found: ${sourceId}`);
    config.sources[index] = { id: sourceId, paths: requirePaths(input?.paths) };
    await writeRaw(config);
    return presentSource(config.sources[index]);
  }

  async function deleteSource(sourceId) {
    const config = await readRaw();
    const index = config.sources.findIndex((item) => item.id === sourceId);
    if (index === -1) throw statusError(404, `Source not found: ${sourceId}`);
    config.sources.splice(index, 1);
    await writeRaw(config);
    return { deleted: true, id: sourceId };
  }

  // Only non-secret metadata is ever handed back to the browser. The
  // constructed rclone connection string (which embeds obscured, not
  // encrypted, credentials) never leaves the server after creation.
  async function listDestinations() {
    return (await readRaw()).rcloneEndpoints.map(presentDestination);
  }

  async function createDestination(input) {
    const config = await readRaw();
    const newId = requireDestinationId(input?.id, config.rcloneEndpoints);
    const { fs, summary } = await buildFs(input, { binary: rcloneBinary });
    const endpoint = {
      id: newId,
      type: requireNonEmpty(input?.type, "type"),
      fs,
      summary,
      allowMove: input?.allowMove === true,
      mount: normalizeMount(input?.mount),
      createdAt: nowDate(now).toISOString(),
    };
    config.rcloneEndpoints.push(endpoint);
    await writeRaw(config);
    return presentDestination(endpoint);
  }

  async function updateDestination(destinationId, input) {
    const config = await readRaw();
    const index = config.rcloneEndpoints.findIndex((item) => item.id === destinationId);
    if (index === -1) throw statusError(404, `Destination not found: ${destinationId}`);
    const existing = config.rcloneEndpoints[index];
    // Re-entering credentials is optional on update: omit `params` to keep
    // the existing connection string and change only allowMove/mount.
    const { fs, summary, type } = input?.params
      ? await buildFs({ ...input, type: input.type || existing.type }, { binary: rcloneBinary })
      : { fs: existing.fs, summary: existing.summary, type: existing.type };
    config.rcloneEndpoints[index] = {
      ...existing,
      type,
      fs,
      summary,
      allowMove: input?.allowMove === true,
      mount: normalizeMount(input?.mount),
    };
    await writeRaw(config);
    return presentDestination(config.rcloneEndpoints[index]);
  }

  async function deleteDestination(destinationId) {
    const config = await readRaw();
    const index = config.rcloneEndpoints.findIndex((item) => item.id === destinationId);
    if (index === -1) throw statusError(404, `Destination not found: ${destinationId}`);
    config.rcloneEndpoints.splice(index, 1);
    await writeRaw(config);
    return { deleted: true, id: destinationId };
  }

  async function testDestinationParams(input) {
    const { fs } = await buildFs(input, { binary: rcloneBinary });
    return testRcloneFs(fs, { binary: rcloneBinary });
  }

  return {
    listSources, createSource, updateSource, deleteSource,
    listDestinations, createDestination, updateDestination, deleteDestination, testDestinationParams,
  };
}

async function buildFs(input, { binary = "rclone" } = {}) {
  const type = requireNonEmpty(input?.type, "type");
  const rawParams = isRecord(input?.params) ? input.params : {};
  const providers = await getRcloneProviders({ binary });
  const provider = providers.find((item) => item?.Name === type);
  if (!provider) throw statusError(400, `Unknown rclone destination type: ${type}`);
  const passwordFields = new Set((provider.Options ?? []).filter((option) => option?.IsPassword).map((option) => option.Name));
  const params = {};
  for (const [key, value] of Object.entries(rawParams)) {
    if (value === undefined || value === null || value === "") continue;
    params[key] = passwordFields.has(key) ? await obscureRcloneValue(value, { binary }) : String(value);
  }
  const fs = buildRcloneConnectionString(type, params);
  const summary = summarize(type, rawParams);
  return { fs, summary, type };
}

// A short, non-secret label for display: the provider type plus whichever
// of host/user/bucket-ish fields are present, never a password value.
function summarize(type, params) {
  const displayKeys = ["host", "user", "bucket", "url", "endpoint"];
  const bits = displayKeys.map((key) => params[key]).filter((value) => typeof value === "string" && value.trim());
  return bits.length ? `${type} · ${bits.join(" · ")}` : type;
}

function presentSource(source) {
  return { id: String(source.id), paths: Array.isArray(source.paths) ? source.paths.map(String) : [] };
}

function presentDestination(endpoint) {
  return {
    id: String(endpoint.id),
    type: String(endpoint.type || "unknown"),
    summary: String(endpoint.summary || endpoint.type || "endpoint"),
    allowMove: endpoint.allowMove === true,
    mount: normalizeMount(endpoint.mount),
    createdAt: endpoint.createdAt ? String(endpoint.createdAt) : null,
  };
}

function normalizeMount(value) {
  if (!isRecord(value) || value.enabled !== true) return { enabled: false };
  return {
    enabled: true,
    vfsCacheMode: typeof value.vfsCacheMode === "string" && value.vfsCacheMode ? value.vfsCacheMode : "off",
    vfsCacheMaxSize: typeof value.vfsCacheMaxSize === "string" && value.vfsCacheMaxSize ? value.vfsCacheMaxSize : null,
    dirCacheTime: typeof value.dirCacheTime === "string" && value.dirCacheTime ? value.dirCacheTime : null,
    pollInterval: typeof value.pollInterval === "string" && value.pollInterval ? value.pollInterval : null,
  };
}

function requireSourceId(value, existing) {
  const id = requireId(value, "source id");
  if (existing.some((item) => item.id === id)) throw statusError(409, `A source named ${id} already exists`);
  return id;
}

function requireDestinationId(value, existing) {
  const id = requireId(value, "destination id");
  if (existing.some((item) => item.id === id)) throw statusError(409, `A destination named ${id} already exists`);
  return id;
}

function requireId(value, name) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value.trim())) {
    throw statusError(400, `${name} must be 1-64 characters: letters, numbers, dot, underscore or hyphen`);
  }
  return value.trim();
}

function requirePaths(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 50) throw statusError(400, "paths must contain 1-50 entries");
  const paths = value.map((item) => {
    if (typeof item !== "string") throw statusError(400, "Each path must be a string");
    const trimmed = item.trim();
    if (!trimmed || trimmed.length > 4096 || /[\r\n\x00]/.test(trimmed)) throw statusError(400, "Each path must be a safe, non-empty string");
    return trimmed;
  });
  return [...new Set(paths)];
}

function requireNonEmpty(value, name) {
  if (typeof value !== "string" || !value.trim()) throw statusError(400, `${name} is required`);
  return value.trim();
}

function isRecord(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
function nowDate(now) { const date = new Date(now()); if (!Number.isFinite(date.getTime())) throw new TypeError("now() must return a valid date"); return date; }
function statusError(statusCode, message) { const error = new Error(message); error.statusCode = statusCode; return error; }
