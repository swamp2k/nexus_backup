import { domainToASCII } from "node:url";
import { isIP } from "node:net";

const ENABLED_KEY = "remote_connection_enabled";
const HOST_KEY = "remote_connection_allowed_hostname";

export function createRemoteConnectionService({ db, now = () => new Date() } = {}) {
  if (!db) throw new TypeError("db is required");
  async function get() {
    const rows = (await db.prepare("SELECT key,value FROM application_settings WHERE key IN (?,?)").bind(ENABLED_KEY, HOST_KEY).all()).results ?? [];
    const values = new Map(rows.map((row) => [String(row.key), String(row.value)]));
    return { enabled: values.get(ENABLED_KEY) === "1", allowedHostname: values.get(HOST_KEY) ?? "" };
  }
  async function update(input = {}) {
    const enabled = input.enabled === undefined ? (await get()).enabled : requireBoolean(input.enabled, "enabled");
    const allowedHostname = input.allowedHostname === undefined ? (await get()).allowedHostname : normalizeHostname(input.allowedHostname);
    if (enabled && !allowedHostname) throw new RangeError("allowedHostname is required when remote connection is enabled");
    const at = new Date(now()).toISOString();
    await db.batch([
      db.prepare("INSERT INTO application_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").bind(ENABLED_KEY, enabled ? "1" : "0", at),
      db.prepare("INSERT INTO application_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").bind(HOST_KEY, allowedHostname, at),
    ]);
    return { enabled, allowedHostname };
  }
  async function allowsHost(hostHeader) {
    const config = await get();
    const host = normalizeHostHeader(hostHeader);
    if (!config.enabled) return isLocalHost(host);
    return host === config.allowedHostname || isLocalHost(host);
  }
  return { get, update, allowsHost };
}

export function normalizeHostname(value) {
  if (typeof value !== "string") throw new RangeError("allowedHostname must be a string");
  const hostname = domainToASCII(value.trim().replace(/\.$/, "")).toLowerCase();
  if (!hostname || hostname.length > 253 || hostname.includes("*") || hostname.includes("/") || hostname.includes(":")) throw new RangeError("allowedHostname must be a single hostname without a wildcard, path, or port");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(hostname)) throw new RangeError("allowedHostname is malformed");
  return hostname;
}
function normalizeHostHeader(value) { try { return new URL(`http://${String(value || "")}`).hostname.toLowerCase().replace(/\.$/, ""); } catch { return ""; } }
function isLocalHost(host) { if (host === "localhost" || host === "::1") return true; const version = isIP(host); if (version === 4) { const [a,b] = host.split(".").map(Number); return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31); } return false; }
function requireBoolean(value, name) { if (typeof value !== "boolean") throw new RangeError(`${name} must be boolean`); return value; }
