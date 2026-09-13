export function resolvePublicOrigin({ configured, host, fallbackHost }) {
  const explicit = optionalString(configured);
  if (explicit) return normalizeExplicitOrigin(explicit);

  const authority = optionalString(host) ?? optionalString(fallbackHost);
  if (!authority) throw new Error("A public host is required when NEXUS_BACKUP_PUBLIC_URL is not configured");
  if (/[\s,/@?#]/.test(authority)) throw new Error("Request Host is not a valid public authority");

  let parsed;
  try { parsed = new URL(`http://${authority}`); }
  catch { throw new Error("Request Host is not a valid public authority"); }
  if (!parsed.hostname || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("Request Host is not a valid public authority");
  }
  return `http://${parsed.host}`;
}

export function normalizeExplicitOrigin(value) {
  let parsed;
  try { parsed = new URL(String(value)); }
  catch { throw new Error("NEXUS_BACKUP_PUBLIC_URL must be an absolute http(s) origin"); }
  if (!["http:", "https:"].includes(parsed.protocol)
      || !parsed.hostname
      || parsed.username
      || parsed.password
      || (parsed.pathname !== "/" && parsed.pathname !== "")
      || parsed.search
      || parsed.hash) {
    throw new Error("NEXUS_BACKUP_PUBLIC_URL must be an absolute http(s) origin without credentials, path, query or fragment");
  }
  return `${parsed.protocol}//${parsed.host}`;
}

function optionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
