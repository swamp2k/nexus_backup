import type { BackupJob } from "@nexus-backup/core";
import type { ExecutionEventSink, TransferGroupEvent } from "./execution-events.js";
import { noopExecutionEventSink } from "./execution-events.js";
import type { JobExecutionResult, JobExecutor } from "./executor.js";
import type { CommandRunner } from "./process-runner.js";
import { ToolExitError } from "./process-runner.js";
import { RtorrentClient, type RtorrentTorrent } from "./rtorrent-client.js";
import type { AgentRuntimeConfig } from "./runtime-config.js";

const MAX_FILES = 5000;
const MAX_RAW_JSON = 800_000;
const MAX_EVENT_JSON = 600_000;
const MAX_GROUP_EVENT_JSON = 350_000;

interface DiscoveryPayload {
  ruleId: string;
  sourceEndpointId: string;
  sourcePath: string;
  includes: string[];
  excludes: string[];
  rtorrentGateId?: string;
}
interface DiscoveryEntry { relPath: string; size: number; modTime: string; }
interface TorrentMatch { torrent: RtorrentTorrent; root: string; }

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
    const chunks: string[] = [];
    let rawSize = 0;
    let overflow = false;

    const args = ["lsjson", source, "--recursive", "--files-only", ...(this.#config.tools.rcloneArgs ?? [])];
    if (this.#config.tools.rcloneConfigPath) args.push("--config", this.#config.tools.rcloneConfigPath);

    const result = await this.#runner.run({ executable: this.#config.tools.rcloneBinary ?? "rclone", args }, signal, {
      stdout: (line) => {
        rawSize += line.length + 1;
        if (rawSize > MAX_RAW_JSON) { overflow = true; return; }
        chunks.push(line);
      },
      stderr: (line) => this.#events.emit({ type: "log", tool: "rclone", stream: "stderr", message: compactRcloneLog(line) }),
    });
    if (result.exitCode !== 0) throw new ToolExitError("rclone", result);
    if (overflow) throw new Error("transfer discovery result is too large; narrow the rule with include/exclude filters");

    let raw: unknown;
    try { raw = JSON.parse(chunks.join("\n")); }
    catch { throw new Error("rclone discovery returned invalid JSON"); }
    if (!Array.isArray(raw)) throw new Error("rclone discovery did not return a JSON file list");

    let entries: DiscoveryEntry[] = [];
    for (const item of raw) {
      const entry = parseLsjsonItem(item);
      if (!pathAllowed(entry.relPath, payload.includes, payload.excludes)) continue;
      if (entries.length >= MAX_FILES) throw new Error(`transfer discovery exceeds ${MAX_FILES} files; narrow the rule with include/exclude filters`);
      entries.push(entry);
    }

    let groups: TransferGroupEvent[] = [];
    let rtorrentSummary: Record<string, unknown> = { enabled: false };
    if (payload.rtorrentGateId) {
      const gate = this.#config.rtorrentGate(payload.rtorrentGateId);
      try {
        const torrents = await new RtorrentClient(gate).torrents(signal);
        const complete = torrents.filter((torrent) => torrent.complete).length;
        let blocked = 0;
        let grouped = 0;
        const groupMap = new Map<string, TransferGroupEvent>();
        entries = entries.flatMap((entry) => {
          const match = torrentForPath(entry.relPath, torrents, gate.sourceBasePath);
          if (!match) return [entry];
          if (!match.torrent.complete) {
            blocked += 1;
            return [];
          }
          grouped += 1;
          const key = requireTorrentKey(match.torrent.hash);
          const name = compactGroupName(match.torrent.name, match.root);
          let group = groupMap.get(key);
          if (!group) {
            group = { kind: "torrent", key, name, root: match.root, paths: [] };
            groupMap.set(key, group);
          }
          if (group.root !== match.root) throw new Error(`rtorrent group ${key} resolved to multiple roots`);
          (group.paths as string[]).push(entry.relPath);
          return [entry];
        });
        groups = [...groupMap.values()]
          .map((group) => ({ ...group, paths: [...group.paths].sort((a, b) => a.localeCompare(b)) }))
          .sort((left, right) => left.root.localeCompare(right.root));
        if (JSON.stringify(groups).length > MAX_GROUP_EVENT_JSON) {
          throw new Error("rtorrent group manifest is too large; narrow the rule with include/exclude filters");
        }
        rtorrentSummary = {
          enabled: true,
          gateId: payload.rtorrentGateId,
          available: true,
          parsed: torrents.length,
          complete,
          groups: groups.length,
          groupedCompleteFiles: grouped,
          blockedIncompleteFiles: blocked,
        };
        this.#events.emit({ type: "log", tool: "rclone", stream: "stdout", message: `rTorrent gate ${payload.rtorrentGateId}: ${torrents.length} torrents, ${complete} complete, ${groups.length} group${groups.length === 1 ? "" : "s"}, ${blocked} incomplete file${blocked === 1 ? "" : "s"} held back` });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (gate.required) throw new Error(`rtorrent required: ${message}`);
        groups = [];
        rtorrentSummary = { enabled: true, gateId: payload.rtorrentGateId, available: false, fallback: "stability", error: message };
        this.#events.emit({ type: "log", tool: "rclone", stream: "stderr", message: `rTorrent gate unavailable; using stability fallback (${message})` });
      }
    }

    if (JSON.stringify(entries).length > MAX_EVENT_JSON) throw new Error("filtered transfer discovery result is too large; narrow the rule with include/exclude filters");

    this.#events.emit({ type: "transfer-discovery", tool: "rclone", ruleId: payload.ruleId, entries });
    if (payload.rtorrentGateId) {
      this.#events.emit({ type: "transfer-groups", tool: "rclone", ruleId: payload.ruleId, groups });
    }
    this.#events.emit({ type: "summary", tool: "rclone", data: { operation: "transfer-discovery", ruleId: payload.ruleId, files: entries.length, groups: groups.length, rtorrent: rtorrentSummary } });
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
    ...(value.rtorrentGateId === undefined || value.rtorrentGateId === null || value.rtorrentGateId === "" ? {} : { rtorrentGateId: requireId(value.rtorrentGateId, "rtorrentGateId") }),
  };
}
function parseLsjsonItem(value: unknown): DiscoveryEntry {
  if (!isRecord(value) || value.IsDir === true) throw new Error("rclone discovery returned an invalid file entry");
  const relPath = normalizeObjectPath(value.Path);
  const size = Number(value.Size);
  if (!Number.isSafeInteger(size) || size < 0) throw new Error(`invalid rclone file size for ${relPath}`);
  if (typeof value.ModTime !== "string" || !Number.isFinite(Date.parse(value.ModTime))) throw new Error(`invalid rclone modification time for ${relPath}`);
  return { relPath, size, modTime: new Date(value.ModTime).toISOString() };
}
function torrentForPath(relPath: string, torrents: readonly RtorrentTorrent[], sourceBasePath: string): TorrentMatch | null {
  let best: TorrentMatch | null = null;
  for (const torrent of torrents) {
    const root = torrentRelativeRoot(torrent.basePath, sourceBasePath);
    if (!root || !pathWithinRoot(relPath, root)) continue;
    if (!best || root.length > best.root.length) best = { torrent, root };
  }
  return best;
}
function torrentRelativeRoot(basePath: string, sourceBasePath: string): string {
  let value = basePath.trim().replaceAll("\\", "/").replace(/\/+$/g, "");
  const base = sourceBasePath.trim().replaceAll("\\", "/").replace(/\/+$/g, "");
  if (!value || !base) return "";
  if (value === base) return value.split("/").filter(Boolean).at(-1) ?? "";
  const prefix = `${base}/`;
  if (!value.startsWith(prefix)) return "";
  value = value.slice(prefix.length);
  return value.replace(/^\/+|\/+$/g, "");
}
function pathWithinRoot(relPath: string, root: string): boolean {
  const rel = relPath.replace(/^\/+|\/+$/g, "");
  const normalizedRoot = root.replace(/^\/+|\/+$/g, "");
  return rel === normalizedRoot || rel.startsWith(`${normalizedRoot}/`);
}
function compactGroupName(name: string, root: string): string {
  const candidate = name.trim() || root.split("/").filter(Boolean).at(-1) || "torrent";
  return candidate.slice(0, 240);
}
function requireTorrentKey(value: string): string {
  const key = value.trim();
  if (!/^(?:[A-Fa-f0-9]{40}|[A-Fa-f0-9]{64})$/.test(key)) throw new Error("rtorrent returned an invalid torrent info hash");
  return key.toLowerCase();
}
function pathAllowed(rel: string, includes: readonly string[], excludes: readonly string[]): boolean { for (const pattern of includes) if (filterMatch(pattern, rel)) return true; for (const pattern of excludes) if (filterMatch(pattern, rel)) return false; return true; }
function filterMatch(input: string, rel: string): boolean { let pattern=input.trim().replace(/^\/+/,""); if(!pattern)return false; if(pattern.endsWith("/"))pattern+="**"; const regex=new RegExp(globRegex(pattern)); if(regex.test(rel))return true; if(!pattern.includes("/"))return regex.test(rel.split("/").at(-1)??rel); return false; }
function globRegex(pattern: string): string { let output="^"; for(let index=0;index<pattern.length;index+=1){const char=pattern[index]!;if(char==="*"){if(pattern[index+1]==="*"){output+=".*";index+=1}else output+="[^/]*"}else if(char==="?")output+="[^/]";else output+=/[.+()|[\]{}^$\\]/.test(char)?`\\${char}`:char}return`${output}$`; }
function joinTarget(base: string, relative: string): string { if(!relative)return base; if(base.endsWith(":")||base.endsWith("/"))return`${base}${relative}`; return`${base}/${relative}`; }
function normalizeBase(value: unknown): string { if(value===undefined||value===null||value==="")return""; if(typeof value!=="string")throw new Error("sourcePath must be a string"); const normalized=value.trim().replaceAll("\\","/").replace(/^\/+|\/+$/g,""); if(!normalized)return""; if(normalized.split("/").some(part=>!part||part==="."||part===".."))throw new Error("sourcePath may not contain dot segments"); return normalized; }
function normalizeObjectPath(value: unknown): string { if(typeof value!=="string")throw new Error("rclone file path must be a string"); const normalized=value.replaceAll("\\","/").replace(/^\/+|\/+$/g,""); if(!normalized||normalized.split("/").some(part=>!part||part==="."||part===".."))throw new Error("rclone returned an unsafe relative path"); return normalized; }
function stringArray(value: unknown,name:string):string[]{if(value===undefined)return[];if(!Array.isArray(value))throw new Error(`${name} must be an array`);return value.map(item=>{if(typeof item!=="string"||!item.trim())throw new Error(`${name} contains an invalid pattern`);return item.trim()})}
function requireId(value: unknown,name:string):string{if(typeof value!=="string"||!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value.trim()))throw new Error(`${name} is invalid`);return value.trim()}
function compactRcloneLog(line:string):string{try{const parsed=JSON.parse(line) as Record<string,unknown>;return typeof parsed.msg==="string"?parsed.msg:"rclone discovery message"}catch{return line.length>2000?`${line.slice(0,2000)}…`:line}}
function isRecord(value:unknown):value is Record<string,unknown>{return typeof value==="object"&&value!==null&&!Array.isArray(value)}
