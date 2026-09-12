import type { LocalRtorrentGate } from "./runtime-config.js";

export interface RtorrentTorrent {
  hash: string;
  name: string;
  complete: boolean;
  basePath: string;
}

export class RtorrentClient {
  readonly #gate: LocalRtorrentGate;
  readonly #fetch: typeof fetch;

  constructor(gate: LocalRtorrentGate, fetchImpl: typeof fetch = fetch) {
    this.#gate = gate;
    this.#fetch = fetchImpl;
  }

  async torrents(signal: AbortSignal): Promise<RtorrentTorrent[]> {
    const view = this.#gate.view ?? "main";
    const body = `<?xml version="1.0"?><methodCall><methodName>d.multicall2</methodName><params>`
      + `<param><value><string></string></value></param>`
      + `<param><value><string>${escapeXml(view)}</string></value></param>`
      + `<param><value><string>d.hash=</string></value></param>`
      + `<param><value><string>d.name=</string></value></param>`
      + `<param><value><string>d.complete=</string></value></param>`
      + `<param><value><string>d.base_path=</string></value></param>`
      + `</params></methodCall>`;
    const headers = new Headers({ "content-type": "text/xml" });
    if (this.#gate.username) {
      headers.set("authorization", `Basic ${base64Utf8(`${this.#gate.username}:${this.#gate.password ?? ""}`)}`);
    }
    const timeout = AbortSignal.timeout(15_000);
    const combined = AbortSignal.any([signal, timeout]);
    const response = await this.#fetch(this.#gate.url, { method: "POST", headers, body, signal: combined });
    if (!response.ok) {
      const text = (await response.text()).slice(0, 4096).trim();
      throw new Error(`rtorrent HTTP ${response.status}${text ? `: ${text}` : ""}`);
    }
    return parseRtorrentResponse(await response.text());
  }
}

export function parseRtorrentResponse(xml: string): RtorrentTorrent[] {
  if (typeof xml !== "string" || !xml.trim()) throw new Error("empty rtorrent XML-RPC response");
  if (/<fault\b/i.test(xml)) throw new Error(`rtorrent XML-RPC fault: ${compactXmlText(xml)}`);
  const marker = /<params>\s*<param>\s*<value>\s*<array>\s*<data>/i.exec(xml);
  if (!marker || marker.index === undefined) throw new Error("unexpected rtorrent XML-RPC response");
  const bodyStart = marker.index + marker[0].length;
  const bodyEnd = xml.lastIndexOf("</data>");
  if (bodyEnd < bodyStart) throw new Error("unexpected rtorrent XML-RPC response");
  const body = xml.slice(bodyStart, bodyEnd);
  const rows: RtorrentTorrent[] = [];
  const rowRe = /<value>\s*<array>\s*<data>([\s\S]*?)<\/data>\s*<\/array>\s*<\/value>/gi;
  for (const match of body.matchAll(rowRe)) {
    const values = parseScalarValues(match[1] ?? "");
    if (values.length < 4) continue;
    rows.push({
      hash: stringValue(values[0]),
      name: stringValue(values[1]),
      complete: numberValue(values[2]) !== 0,
      basePath: stringValue(values[3]),
    });
  }
  return rows;
}

function parseScalarValues(xml: string): Array<string | number> {
  const values: Array<string | number> = [];
  const valueRe = /<value>\s*(?:<(?<tag>string|int|i4|i8)>(?<tagged>[\s\S]*?)<\/\k<tag>>|(?<plain>[^<]*))\s*<\/value>/gi;
  for (const match of xml.matchAll(valueRe)) {
    const tag = match.groups?.tag?.toLowerCase();
    const raw = decodeXml((match.groups?.tagged ?? match.groups?.plain ?? "").trim());
    if (tag === "int" || tag === "i4" || tag === "i8") {
      const parsed = Number(raw);
      values.push(Number.isFinite(parsed) ? parsed : 0);
    } else {
      values.push(raw);
    }
  }
  return values;
}

function base64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index] ?? 0;
    const hasB = index + 1 < bytes.length;
    const hasC = index + 2 < bytes.length;
    const b = bytes[index + 1] ?? 0;
    const c = bytes[index + 2] ?? 0;
    const block = (a << 16) | (b << 8) | c;
    output += alphabet[(block >> 18) & 63];
    output += alphabet[(block >> 12) & 63];
    output += hasB ? alphabet[(block >> 6) & 63] : "=";
    output += hasC ? alphabet[block & 63] : "=";
  }
  return output;
}
function stringValue(value: string | number | undefined): string {
  return value === undefined ? "" : String(value);
}
function numberValue(value: string | number | undefined): number {
  if (typeof value === "number") return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}
function decodeXml(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (entity, code: string) => {
    switch (code.toLowerCase()) {
      case "amp": return "&";
      case "lt": return "<";
      case "gt": return ">";
      case "quot": return '"';
      case "apos": return "'";
      default: {
        const numeric = code.startsWith("#x") ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
        return Number.isFinite(numeric) ? String.fromCodePoint(numeric) : entity;
      }
    }
  });
}
function compactXmlText(xml: string): string {
  const text = decodeXml(xml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
  return text.slice(0, 400) || "fault response";
}
