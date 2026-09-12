import type { BackupJob } from "@nexus-backup/core";
import type { ExecutionEventSink } from "./execution-events.js";
import { noopExecutionEventSink } from "./execution-events.js";
import type { JobExecutionResult, JobExecutor } from "./executor.js";
import type { CommandRunner } from "./process-runner.js";
import { ToolExitError } from "./process-runner.js";
import type { AgentRuntimeConfig } from "./runtime-config.js";

const MAX_FILES = 5000;
const MAX_JSON = 600_000;

interface DiscoveryPayload {
  ruleId: string;
  sourceEndpointId: string;
  sourcePath: string;
  includes: string[];
  excludes: string[];
}

interface DiscoveryEntry {
  relPath: string;
  size: number;
  modTime: string;
}

export class RcloneDiscoveryExecutor implements JobExecutor {
  readonly #config: AgentRuntimeConfig;
  readonly #runner: CommandRunner;
  readonly #events: ExecutionEventSink;

  constructor(config: AgentRuntimeConfig, runner: CommandRunner, events: ExecutionEventSink = noopExecutionEventSink) {
    this.#config = config;
    this.#runner = runner;
    this.#events = events;
  }

  async execute(job: BackupJob, signal: AbortSignal): Promise<JobExecutionResult> {
    const payload = parsePayload(job.payload);
    const endpoint = this.#config.rcloneEndpoint(payload.sourceEndpointId);
    const source = joinTarget(endpoint.fs, payload.sourcePath);
    const entries: DiscoveryEntry[] = [];
    let encodedSize = 2;

    const args = [
      "lsf", source,
      "--recursive",
      "--files-only",
      "--format", "pst",
      "--separator", "\t",
      "--time-format", "RFC3339Nano",
      ...(this.#config.tools.rcloneArgs ?? []),
    ];
    if (this.#config.tools.rcloneConfigPath) args.push("--config", this.#config.tools.rcloneConfigPath);

    const result = await this.#runner.run({
      executable: this.#config.tools.rcloneBinary ?? "rclone",
      args,
    }, signal, {
      stdout: (line) => {
        const entry = parseLine(line);
        if (!entry || !pathAllowed(entry.relPath, payload.includes, payload.excludes)) return;
        if (entries.length >= MAX_FILES) throw new Error(`transfer discovery exceeds ${MAX_FILES} files; narrow the rule with include/exclude filters`);
        encodedSize += JSON.stringify(entry).length + 1;
        if (encodedSize > MAX_JSON) throw new Error("transfer discovery result is too large; narrow the rule with include/exclude filters");
        entries.push(entry);
      },
      stderr: (line) => this.#events.emit({ type: "log", tool: "rclone", stream: "stderr", message: compactRcloneLog(line) }),
    });

    if (result.exitCode !== 0) throw new ToolExitError("rclone", result);
    this.#events.emit({
      type: "transfer-discovery",
      tool: "rclone",
      ruleId: payload.ruleId,
      entries,
    });
    this.#events.emit({
      type: "summary",
      tool: "rclone",
      data: { operation: "transfer-discovery", ruleId: payload.ruleId, files: entries.length },
    });
    return { status: "completed" };
  }
}

function parsePayload(value: unknown): DiscoveryPayload {
  if (!isRecord(value)) throw new Error("rclone discovery payload must be an object");
  return {
    ruleId: requireId(value.ruleId, "ruleId"),
    sourceEndpointId: requireId(value.sourceEndpointId, "sourceEndpointId"),
    sourcePath: normalizeBase(value.sourcePath),
    includes: stringArray(value.includes, "includes"),
    excludes: stringArray(value.excludes, "excludes"),
  };
}

function parseLine(line: string): DiscoveryEntry | null {
  if (!line) return null;
  const match = /^(.*)\t(\d+)\t(.+)$/.exec(line);
  if (!match?.[1] || match[2] === undefined || !match[3]) throw new Error("rclone discovery returned an unexpected lsf row");
  const relPath = normalizeObjectPath(match[1]);
  const size = Number(match[2]);
  if (!Number.isSafeInteger(size) || size < 0) throw new Error(`invalid rclone file size for ${relPath}`);
  const parsedTime = Date.parse(match[3]);
  if (!Number.isFinite(parsedTime)) throw new Error(`invalid rclone modification time for ${relPath}`);
  return { relPath, size, modTime: new Date(parsedTime).toISOString() };
}

function pathAllowed(rel: string, includes: readonly string[], excludes: readonly string[]): boolean {
  for (const pattern of includes) if (filterMatch(pattern, rel)) return true;
  for (const pattern of excludes) if (filterMatch(pattern, rel)) return false;
  return true;
}

function filterMatch(input: string, rel: string): boolean {
  let pattern = input.trim().replace(/^\/+/, "");
  if (!pattern) return false;
  if (pattern.endsWith("/")) pattern += "**";
  const regex = new RegExp(globRegex(pattern));
  if (regex.test(rel)) return true;
  if (!pattern.includes("/")) return regex.test(rel.split("/").at(-1) ?? rel);
  return false;
}

function globRegex(pattern: string): string {
  let output = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (char === "*") {
      if (pattern[index + 1] === "*") { output += ".*"; index += 1; }
      else output += "[^/]*";
    } else if (char === "?") output += "[^/]";
    else output += /[.+()|[\]{}^$\\]/.test(char) ? `\\${char}` : char;
  }
  return `${output}$`;
}

function joinTarget(base: string, relative: string): string {
  if (!relative) return base;
  if (base.endsWith(":") || base.endsWith("/")) return `${base}${relative}`;
  return `${base}/${relative}`;
}

function normalizeBase(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") throw new Error("sourcePath must be a string");
  const normalized = value.trim().replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  if (!normalized) return "";
  if (normalized.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("sourcePath may not contain dot segments");
  return normalized;
}

function normalizeObjectPath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  if (!normalized || normalized.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("rclone returned an unsafe relative path");
  return normalized;
}
function stringArray(value: unknown, name: string): string[] { if (value === undefined) return []; if (!Array.isArray(value)) throw new Error(`${name} must be an array`); return value.map((item) => { if (typeof item !== "string" || !item.trim()) throw new Error(`${name} contains an invalid pattern`); return item.trim(); }); }
function requireId(value: unknown, name: string): string { if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value.trim())) throw new Error(`${name} is invalid`); return value.trim(); }
function compactRcloneLog(line: string): string { try { const parsed = JSON.parse(line) as Record<string, unknown>; return typeof parsed.msg === "string" ? parsed.msg : "rclone discovery message"; } catch { return line.length > 2000 ? `${line.slice(0, 2000)}…` : line; } }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
