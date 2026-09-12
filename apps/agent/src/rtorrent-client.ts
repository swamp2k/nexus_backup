import { readFile } from "node:fs/promises";
import type { LocalRtorrentEndpoint } from "./runtime-config.js";

export interface RtorrentTorrent { hash: string; name: string; basePath: string; complete: boolean; }
export interface RtorrentClientOptions { fetch?: typeof globalThis.fetch; timeoutMs?: number; loadSecret?: (path: string) => Promise<string>; }

export class RtorrentClient {
  readonly #config: LocalRtorrentEndpoint;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutMs: number;
  readonly #loadSecret: (path: string) => Promise<string>;

  constructor(config: LocalRtorrentEndpoint, options: RtorrentClientOptions = {}) {
    this.#config = config;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#loadSecret = options.loadSecret ?? loadSecretFile;
    if (!Number.isInteger(this.#timeoutMs) || this.#timeoutMs <= 0) throw new RangeError("rTorrent timeoutMs must be a positive integer");
  }

  async torrents(signal: AbortSignal): Promise<RtorrentTorrent[]> {
    const view = this.#config.view ?? "main";
    const body = `<?xml version="1.0"?><methodCall><methodName>d.multicall2</methodName><params>`
      + `<param><value><string></string></value></param>`
      + `<param><value><string>${escapeXml(view)}</string></value></param>`
      + `<param><value><string>d.hash=</string></value></param>`
      + `<param><value><string>d.name=</string></value></param>`
      + `<param><value><string>d.complete=</string></value></param>`
      + `<param><value><string>d.base_path=</string></value></param>`
      + `</params></methodCall>`;
    const headers: Record<string, string> = { "content-type": "text/xml", accept: "text/xml, application/xml" };
    if (this.#config.username) {
      const password = this.#config.passwordFile ? await this.#loadSecret(this.#config.passwordFile) : "";
      headers.authorization = `Basic ${Buffer.from(`${this.#config.username}:${password}`).toString("base64")}`;
    }
    const response = await this.#fetch(this.#config.url, {
      method: "POST", headers, body,
      signal: AbortSignal.any([signal, AbortSignal.timeout(this.#timeoutMs)]),
    });
    const text = await response.text();
    if (!response.ok) {
      const safe = text.replace(/\s+/g, " ").trim().slice(0, 1000);
      throw new Error(`rTorrent HTTP ${response.status}${safe ? `: ${safe}` : ""}`);
    }
    return parseMulticallResponse(text);
  }
}

export function parseMulticallResponse(xml: string): RtorrentTorrent[] {
  if (typeof xml !== "string" || !xml.trim()) throw new Error("rTorrent returned an empty XML-RPC response");
  if (/<fault\b/i.test(xml)) {
    const detail = faultText(xml);
    throw new Error(`rTorrent XML-RPC fault${detail ? `: ${detail}` : ""}`);
  }
  const params = tagRange(xml, "params", 0);
  if (!params) throw new Error("Unexpected rTorrent XML-RPC response: params missing");
  const param = tagRange(xml, "param", params.innerStart);
  if (!param || param.end > params.innerEnd) throw new Error("Unexpected rTorrent XML-RPC response: param missing");
  const parsed = parseValue(xml, param.innerStart);
  if (!parsed || !Array.isArray(parsed.value)) throw new Error("Unexpected rTorrent XML-RPC response: torrent array missing");
  return parsed.value.flatMap((row) => {
    if (!Array.isArray(row) || row.length < 4) return [];
    return [{ hash: stringValue(row[0]), name: stringValue(row[1]), complete: numberValue(row[2]) !== 0, basePath: stringValue(row[3]) }];
  });
}

function parseValue(xml: string, from: number): { value: unknown; end: number } | null {
  const valueTag = tagRange(xml, "value", from);
  if (!valueTag) return null;
  let cursor = skipWhitespace(xml, valueTag.innerStart);
  if (xml.startsWith("<array", cursor)) {
    const array = tagRange(xml, "array", cursor);
    if (!array || array.end > valueTag.innerEnd) throw new Error("Malformed rTorrent XML-RPC array");
    const data = tagRange(xml, "data", array.innerStart);
    if (!data || data.end > array.innerEnd) throw new Error("Malformed rTorrent XML-RPC array data");
    const values: unknown[] = [];
    cursor = data.innerStart;
    for (;;) {
      cursor = skipWhitespace(xml, cursor);
      if (cursor >= data.innerEnd) break;
      const child = parseValue(xml, cursor);
      if (!child || child.end > data.innerEnd) throw new Error("Malformed rTorrent XML-RPC array value");
      values.push(child.value);
      cursor = child.end;
    }
    return { value: values, end: valueTag.end };
  }
  for (const tag of ["string", "int", "i4", "i8"] as const) {
    if (!xml.startsWith(`<${tag}`, cursor)) continue;
    const typed = tagRange(xml, tag, cursor);
    if (!typed || typed.end > valueTag.innerEnd) throw new Error(`Malformed rTorrent XML-RPC ${tag} value`);
    const text = decodeXml(xml.slice(typed.innerStart, typed.innerEnd)).trim();
    return { value: tag === "string" ? text : parseInteger(text), end: valueTag.end };
  }
  return { value: decodeXml(xml.slice(valueTag.innerStart, valueTag.innerEnd)).trim(), end: valueTag.end };
}

function tagRange(xml: string, tag: string, from: number): { innerStart: number; innerEnd: number; end: number } | null {
  const openToken = `<${tag}`;
  const closeToken = `</${tag}>`;
  const open = xml.indexOf(openToken, from);
  if (open < 0) return null;
  const openEnd = xml.indexOf(">", open);
  if (openEnd < 0) return null;
  let depth = 1;
  let cursor = openEnd + 1;
  while (depth > 0) {
    const nextOpen = xml.indexOf(openToken, cursor);
    const nextClose = xml.indexOf(closeToken, cursor);
    if (nextClose < 0) return null;
    if (nextOpen >= 0 && nextOpen < nextClose) {
      const boundary = xml[nextOpen + openToken.length];
      if (boundary === ">" || boundary === " " || boundary === "\t" || boundary === "\r" || boundary === "\n") {
        depth += 1;
        const nextOpenEnd = xml.indexOf(">", nextOpen);
        if (nextOpenEnd < 0) return null;
        cursor = nextOpenEnd + 1;
        continue;
      }
    }
    depth -= 1;
    if (depth === 0) return { innerStart: openEnd + 1, innerEnd: nextClose, end: nextClose + closeToken.length };
    cursor = nextClose + closeToken.length;
  }
  return null;
}

async function loadSecretFile(path: string): Promise<string> {
  const value = (await readFile(path, "utf8")).trim();
  if (!value) throw new Error(`rTorrent password file is empty: ${path}`);
  return value;
}
function parseInteger(value: string): number { const parsed = Number(value); return Number.isSafeInteger(parsed) ? parsed : 0; }
function stringValue(value: unknown): string { return typeof value === "string" ? value : ""; }
function numberValue(value: unknown): number { return typeof value === "number" && Number.isFinite(value) ? value : Number(value) || 0; }
function skipWhitespace(value: string, index: number): number { while (index < value.length && /\s/.test(value[index]!)) index += 1; return index; }
function escapeXml(value: string): string { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;"); }
function decodeXml(value: string): string { return value.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (match, token: string) => { const lower=token.toLowerCase();if(lower==="amp")return"&";if(lower==="lt")return"<";if(lower==="gt")return">";if(lower==="quot")return'"';if(lower==="apos")return"'";const code=lower.startsWith("#x")?Number.parseInt(lower.slice(2),16):Number.parseInt(lower.slice(1),10);return Number.isFinite(code)?String.fromCodePoint(code):match; }); }
function faultText(xml: string): string { const strings=[...xml.matchAll(/<string>([\s\S]*?)<\/string>/gi)].map(match=>decodeXml(match[1]??"").trim()).filter(Boolean);return strings.at(-1)?.slice(0,500)??""; }
