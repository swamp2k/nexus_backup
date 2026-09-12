import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const RESTORE_GRANT_TTL_MS = 2 * 60 * 1000;
const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 5 * 60 * 1000;

export async function createLocalAuth({ configDir, log = () => {}, now = () => new Date() }) {
  const authPath = join(configDir, "auth.json");
  const setupPath = join(configDir, "setup-token");
  const sessions = new Map();
  const failures = new Map();
  let configured = await hasAuth(authPath);
  if (!configured) {
    const setupToken = await ensureSetupToken(setupPath);
    log("warn", "local admin setup required", { setupToken });
  } else {
    await unlink(setupPath).catch((error) => { if (error?.code !== "ENOENT") throw error; });
  }

  function cleanup() {
    const timestamp = nowMs(now);
    for (const [id, session] of sessions) {
      if (session.expiresAt <= timestamp) sessions.delete(id);
      else {
        for (const [token, grant] of session.restoreGrants) if (grant.expiresAt <= timestamp) session.restoreGrants.delete(token);
      }
    }
    for (const [key, value] of failures) if (timestamp - value.firstAt > FAILURE_WINDOW_MS) failures.delete(key);
  }

  function sessionFromRequest(request) {
    cleanup();
    const id = cookieValue(request.headers.cookie, "nb_session");
    if (!id) return null;
    const session = sessions.get(id);
    if (!session || session.expiresAt <= nowMs(now)) {
      if (id) sessions.delete(id);
      return null;
    }
    return session;
  }

  function status(request) {
    const session = sessionFromRequest(request);
    return {
      configured,
      authenticated: Boolean(session),
      ...(session ? { csrfToken: session.csrfToken, expiresAt: new Date(session.expiresAt).toISOString() } : {}),
    };
  }

  async function setup({ setupToken, password, request, response }) {
    if (configured) throw statusError(409, "Local admin is already configured");
    const expected = (await readFile(setupPath, "utf8")).trim();
    if (!safeEqual(setupToken, expected)) throw statusError(403, "Invalid setup token");
    const normalizedPassword = validatePassword(password);
    const record = await passwordRecord(normalizedPassword);
    await atomicWrite(authPath, `${JSON.stringify(record, null, 2)}\n`, 0o600, true);
    configured = true;
    await unlink(setupPath).catch(() => {});
    return createSession(request, response);
  }

  async function login({ password, request, response }) {
    if (!configured) throw statusError(409, "Local admin setup is required");
    const key = clientKey(request);
    enforceRateLimit(failures, key, now);
    const record = JSON.parse(await readFile(authPath, "utf8"));
    const ok = await verifyPassword(password, record);
    if (!ok) {
      noteFailure(failures, key, now);
      throw statusError(401, "Invalid password");
    }
    failures.delete(key);
    return createSession(request, response);
  }

  function createSession(request, response) {
    cleanup();
    const id = randomBytes(32).toString("base64url");
    const timestamp = nowMs(now);
    const session = {
      id,
      csrfToken: randomBytes(24).toString("base64url"),
      createdAt: timestamp,
      expiresAt: timestamp + SESSION_TTL_MS,
      restoreGrants: new Map(),
    };
    sessions.set(id, session);
    response.setHeader("set-cookie", sessionCookie(id, SESSION_TTL_MS, request));
    return { authenticated: true, csrfToken: session.csrfToken, expiresAt: new Date(session.expiresAt).toISOString() };
  }

  function requireSession(request) {
    const session = sessionFromRequest(request);
    if (!session) throw statusError(401, "Authentication required");
    return session;
  }

  function requireCsrf(request, session) {
    const supplied = Array.isArray(request.headers["x-nexus-csrf"])
      ? request.headers["x-nexus-csrf"][0]
      : request.headers["x-nexus-csrf"];
    if (!safeEqual(supplied, session.csrfToken)) throw statusError(403, "Invalid CSRF token");
  }

  function logout(request, response) {
    const session = sessionFromRequest(request);
    if (session) sessions.delete(session.id);
    response.setHeader("set-cookie", expiredSessionCookie(request));
  }

  function issueRestoreGrant(session, scope) {
    cleanup();
    const token = randomBytes(32).toString("base64url");
    const expiresAt = nowMs(now) + RESTORE_GRANT_TTL_MS;
    session.restoreGrants.set(token, { scope: normalizeScope(scope), expiresAt });
    return { token, expiresAt: new Date(expiresAt).toISOString() };
  }

  function consumeRestoreGrant(session, token, scope) {
    cleanup();
    if (typeof token !== "string" || !token) throw statusError(403, "Restore authorization is required");
    const grant = session.restoreGrants.get(token);
    session.restoreGrants.delete(token);
    if (!grant || grant.expiresAt <= nowMs(now)) throw statusError(403, "Restore authorization is invalid or expired");
    if (!safeEqual(JSON.stringify(grant.scope), JSON.stringify(normalizeScope(scope)))) {
      throw statusError(403, "Restore authorization does not match this restore");
    }
  }

  return {
    status,
    setup,
    login,
    logout,
    requireSession,
    requireCsrf,
    issueRestoreGrant,
    consumeRestoreGrant,
    get configured() { return configured; },
  };
}

export function confirmationPhrase({ snapshotId, targetId }) {
  return `RESTORE ${String(snapshotId).slice(0, 8).toUpperCase()} TO ${String(targetId)}`;
}

async function passwordRecord(password) {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return { version: 1, algorithm: "scrypt", salt: salt.toString("base64"), hash: Buffer.from(hash).toString("base64") };
}

async function verifyPassword(password, record) {
  if (typeof password !== "string" || !record || record.version !== 1 || record.algorithm !== "scrypt") return false;
  try {
    const salt = Buffer.from(record.salt, "base64");
    const expected = Buffer.from(record.hash, "base64");
    const actual = Buffer.from(await scrypt(password, salt, expected.length));
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch { return false; }
}

function validatePassword(value) {
  if (typeof value !== "string" || value.length < 12 || value.length > 256) {
    throw statusError(400, "Password must be 12-256 characters");
  }
  return value;
}

async function hasAuth(path) {
  try { const value = JSON.parse(await readFile(path, "utf8")); return value?.version === 1 && value?.algorithm === "scrypt"; }
  catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}

async function ensureSetupToken(path) {
  try { const current = (await readFile(path, "utf8")).trim(); if (current) return current; }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  const token = randomBytes(18).toString("base64url");
  await atomicWrite(path, `${token}\n`, 0o600, false);
  return token;
}

async function atomicWrite(path, content, mode, failIfExists) {
  await mkdir(dirname(path), { recursive: true });
  if (failIfExists) {
    const handle = await import("node:fs/promises").then(({ open }) => open(path, "wx", mode));
    try { await handle.writeFile(content); } finally { await handle.close(); }
    await chmod(path, mode);
    return;
  }
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temporary, content, { mode });
  await rename(temporary, path);
  await chmod(path, mode);
}

function normalizeScope(scope) {
  return {
    repositoryId: String(scope.repositoryId),
    snapshotId: String(scope.snapshotId),
    targetId: String(scope.targetId),
    path: scope.path == null || scope.path === "" ? null : String(scope.path),
  };
}
function clientKey(request) { return request.socket?.remoteAddress || "unknown"; }
function enforceRateLimit(map, key, now) {
  const value = map.get(key); if (!value) return;
  const timestamp = nowMs(now);
  if (timestamp - value.firstAt > FAILURE_WINDOW_MS) { map.delete(key); return; }
  if (value.count >= MAX_FAILURES) throw statusError(429, "Too many login attempts; try again later");
}
function noteFailure(map, key, now) {
  const timestamp = nowMs(now); const value = map.get(key);
  if (!value || timestamp - value.firstAt > FAILURE_WINDOW_MS) map.set(key, { count: 1, firstAt: timestamp });
  else value.count += 1;
}
function sessionCookie(id, ttl, request) { return `nb_session=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(ttl / 1000)}${isSecure(request) ? "; Secure" : ""}`; }
function expiredSessionCookie(request) { return `nb_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${isSecure(request) ? "; Secure" : ""}`; }
function isSecure(request) { return request.socket?.encrypted === true || String(request.headers["x-forwarded-proto"] || "").toLowerCase() === "https"; }
function cookieValue(header, name) { if (typeof header !== "string") return null; for (const part of header.split(";")) { const [key, ...rest] = part.trim().split("="); if (key === name) return rest.join("=") || null; } return null; }
function safeEqual(left, right) { if (typeof left !== "string" || typeof right !== "string") return false; const a = Buffer.from(left); const b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); }
function nowMs(now) { const value = now(); const date = value instanceof Date ? value : new Date(value); if (!Number.isFinite(date.getTime())) throw new TypeError("now() must return a valid date"); return date.getTime(); }
function statusError(statusCode, message) { const error = new Error(message); error.statusCode = statusCode; return error; }
