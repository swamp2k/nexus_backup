import type { BackupJob } from "@nexus-backup/core";
import type { ExecutionEventSink, TransferDiscoveryEntryEvent, TransferReadiness } from "./execution-events.js";
import { noopExecutionEventSink } from "./execution-events.js";
import type { JobExecutionResult, JobExecutor } from "./executor.js";
import type { CommandRunner } from "./process-runner.js";
import { ToolExitError } from "./process-runner.js";
import { RtorrentClient, type RtorrentTorrent } from "./rtorrent-client.js";
import type { AgentRuntimeConfig, LocalRtorrentEndpoint } from "./runtime-config.js";

const MAX_FILES = 5000;
const MAX_RAW_JSON = 800_000;
const MAX_EVENT_JSON = 600_000;

interface DiscoveryPayload {
  ruleId: string;
  sourceEndpointId: string;
  sourcePath: string;
  includes: string[];
  excludes: string[];
  rtorrentEndpointId?: string;
  rtorrentRequired: boolean;
}
interface BaseDiscoveryEntry { relPath: string; size: number; modTime: string; }
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
    const rtorrent = await this.#loadRtorrent(payload, signal);
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

    const entries: TransferDiscoveryEntryEvent[] = [];
    let encodedSize = 2;
    const counts: Record<TransferReadiness, number> = { stability: 0, rtorrent_complete: 0, rtorrent_incomplete: 0 };
    for (const item of raw) {
      const base = parseLsjsonItem(item);
      if (!pathAllowed(base.relPath, payload.includes, payload.excludes)) continue;
      if (entries.length >= MAX_FILES) throw new Error(`transfer discovery exceeds ${MAX_FILES} files; narrow the rule with include/exclude filters`);
      const entry = withReadiness(base, rtorrent.endpoint, rtorrent.torrents);
      encodedSize += JSON.stringify(entry).length + 1;
      if (encodedSize > MAX_EVENT_JSON) throw new Error("filtered transfer discovery result is too large; narrow the rule with include/exclude filters");
      counts[entry.readiness] += 1;
      entries.push(entry);
    }

    this.#events.emit({
      type: "transfer-discovery",
      tool: "rclone",
      ruleId: payload.ruleId,
      rtorrent: { configured: Boolean(payload.rtorrentEndpointId), available: rtorrent.available },
      entries,
    });
    this.#events.emit({
      type: "summary",
      tool: "rclone",
      data: {
        operation: "transfer-discovery",
        ruleId: payload.ruleId,
        files: entries.length,
        rtorrentConfigured: Boolean(payload.rtorrentEndpointId),
        rtorrentAvailable: rtorrent.available,
        readiness: counts,
      },
    });
    return { status: "completed" };
  }

  async #loadRtorrent(payload: DiscoveryPayload, signal: AbortSignal): Promise<{ available: boolean; endpoint?: LocalRtorrentEndpoint; torrents: RtorrentTorrent[] }> {
    if (!payload.rtorrentEndpointId) return { available: false, torrents: [] };
    const endpoint = this.#config.rtorrentEndpoint(payload.rtorrentEndpointId);
    try {
      const torrents = await new RtorrentClient(endpoint).torrents(signal);
      this.#events.emit({ type: "log", tool: "rclone", stream: "stdout", message: `rTorrent readiness loaded (${torrents.length} torrent${torrents.length === 1 ? "" : "s"})` });
      return { available: true, endpoint, torrents };
    } catch (error) {
      if (payload.rtorrentRequired) throw new Error(`rTorrent readiness is required but unavailable: ${errorMessage(error)}`);
      this.#events.emit({ type: "log", tool: "rclone", stream: "stderr", message: `rTorrent unavailable; using stability fallback (${errorMessage(error)})` });
      return { available: false, endpoint, torrents: [] };
    }
  }
}

function withReadiness(base: BaseDiscoveryEntry, endpoint: LocalRtorrentEndpoint | undefined, torrents: readonly RtorrentTorrent[]): TransferDiscoveryEntryEvent {
  if (!endpoint || torrents.length === 0) return { ...base, readiness: "stability" };
  const match = torrentForPath(base.relPath, endpoint.sourceBasePath, torrents);
  if (!match) return { ...base, readiness: "stability" };
  return {
    ...base,
    readiness: match.torrent.complete ? "rtorrent_complete" : "rtorrent_incomplete",
    ...(match.torrent.hash ? { torrentHash: match.torrent.hash } : {}),
    ...(match.torrent.name ? { torrentName: match.torrent.name } : {}),
    torrentRoot: match.root,
  };
}

export function torrentForPath(relPath: string, sourceBasePath: string, torrents: readonly RtorrentTorrent[]): TorrentMatch | null {
  const candidates: TorrentMatch[] = [];
  for (const torrent of torrents) {
    const root = torrentRelativeRoot(sourceBasePath, torrent.basePath);
    if (root && pathWithinRoot(relPath, root)) candidates.push({ torrent, root });
  }
  candidates.sort((left, right) => right.root.length - left.root.length);
  return candidates[0] ?? null;
}

export function torrentRelativeRoot(sourceBasePath: string, torrentBasePath: string): string {
  let current = normalizeSlashPath(torrentBasePath);
  const base = normalizeSlashPath(sourceBasePath);
  if (!current) return "";
  if (base) {
    if (current === base) return posixBase(current);
    const prefix = `${base}/`;
    if (current.startsWith(prefix)) current = current.slice(prefix.length);
  }
  return current.replace(/^\/+|\/+$/g, "");
}

function pathWithinRoot(relPath: string, root: string): boolean {
  const rel = relPath.replace(/^\/+|\/+$/g, "");
  const normalizedRoot = root.replace(/^\/+|\/+$/g, "");
  return rel === normalizedRoot || rel.startsWith(`${normalizedRoot}/`);
}

function parsePayload(value: unknown): DiscoveryPayload {
  if (!isRecord(value)) throw new Error("rclone discovery payload must be an object");
  const rtorrentEndpointId = value.rtorrentEndpointId === undefined || value.rtorrentEndpointId === null || value.rtorrentEndpointId === ""
    ? undefined
    : requireId(value.rtorrentEndpointId, "rtorrentEndpointId");
  const rtorrentRequired = value.rtorrentRequired === true;
  if (rtorrentRequired && !rtorrentEndpointId) throw new Error("rtorrentRequired needs rtorrentEndpointId");
  return {
    ruleId: requireId(value.ruleId, "ruleId"),
    sourceEndpointId: requireId(value.sourceEndpointId, "sourceEndpointId"),
    sourcePath: normalizeBase(value.sourcePath),
    includes: stringArray(value.includes, "includes"),
    excludes: stringArray(value.excludes, "excludes"),
    ...(rtorrentEndpointId ? { rtorrentEndpointId } : {}),
    rtorrentRequired,
  };
}
function parseLsjsonItem(value: unknown): BaseDiscoveryEntry {
  if (!isRecord(value) || value.IsDir === true) throw new Error("rclone discovery returned an invalid file entry");
  const relPath = normalizeObjectPath(value.Path);
  const size = Number(value.Size);
  if (!Number.isSafeInteger(size) || size < 0) throw new Error(`invalid rclone file size for ${relPath}`);
  if (typeof value.ModTime !== "string" || !Number.isFinite(Date.parse(value.ModTime))) throw new Error(`invalid rclone modification time for ${relPath}`);
  return { relPath, size, modTime: new Date(value.ModTime).toISOString() };
}
function pathAllowed(rel: string, includes: readonly string[], excludes: readonly string[]): boolean { for (const pattern of includes) if (filterMatch(pattern, rel)) return true; for (const pattern of excludes) if (filterMatch(pattern, rel)) return false; return true; }
function filterMatch(input: string, rel: string): boolean { let pattern=input.trim().replace(/^\/+/,""); if(!pattern)return false; if(pattern.endsWith("/"))pattern+="**"; const regex=new RegExp(globRegex(pattern)); if(regex.test(rel))return true; if(!pattern.includes("/"))return regex.test(rel.split("/").at(-1)??rel); return false; }
function globRegex(pattern: string): string { let output="^"; for(let index=0;index<pattern.length;index+=1){const char=pattern[index]!;if(char==="*"){if(pattern[index+1]==="*"){output+=".*";index+=1}else output+="[^/]*"}else if(char==="?")output+="[^/]";else output+=/[.+()|[\]{}^$\\]/.test(char)?`\\${char}`:char}return`${output}$`; }
function joinTarget(base: string, relative: string): string { if(!relative)return base; if(base.endsWith(":")||base.endsWith("/"))return`${base}${relative}`; return`${base}/${relative}`; }
function normalizeBase(value: unknown): string { if(value===undefined||value===null||value==="")return""; if(typeof value!=="string")throw new Error("sourcePath must be a string"); const normalized=value.trim().replaceAll("\\","/").replace(/^\/+|\/+$/g,""); if(!normalized)return""; if(normalized.split("/").some(part=>!part||part==="."||part===".."))throw new Error("sourcePath may not contain dot segments"); return normalized; }
function normalizeObjectPath(value: unknown): string { if(typeof value!=="string")throw new Error("rclone file path must be a string"); const normalized=value.replaceAll("\\","/").replace(/^\/+|\/+$/g,""); if(!normalized||normalized.split("/").some(part=>!part||part==="."||part===".."))throw new Error("rclone returned an unsafe relative path"); return normalized; }
function normalizeSlashPath(value: string): string { return value.trim().replaceAll("\\","/").replace(/\/+$/g,""); }
function posixBase(value: string): string { const normalized=value.replace(/\/+$/g,""); const index=normalized.lastIndexOf("/"); return index>=0?normalized.slice(index+1):normalized; }
function stringArray(value: unknown,name:string):string[]{if(value===undefined)return[];if(!Array.isArray(value))throw new Error(`${name} must be an array`);return value.map(item=>{if(typeof item!=="string"||!item.trim())throw new Error(`${name} contains an invalid pattern`);return item.trim()})}
function requireId(value: unknown,name:string):string{if(typeof value!=="string"||!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value.trim()))throw new Error(`${name} is invalid`);return value.trim()}
function compactRcloneLog(line:string):string{try{const parsed=JSON.parse(line) as Record<string,unknown>;return typeof parsed.msg==="string"?parsed.msg:"rclone discovery message"}catch{return line.length>2000?`${line.slice(0,2000)}…`:line}}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function isRecord(value:unknown):value is Record<string,unknown>{return typeof value==="object"&&value!==null&&!Array.isArray(value)}
