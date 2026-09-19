import { spawn } from "node:child_process";

// rclone already ships in the appliance image for the Transfers engine.
// Rather than hand-coding a form per backend type, ask rclone for its own
// schema (`rclone config providers`) and drive the wizard from that, the
// same trick Copyarr's Remotes page uses.
let cachedProviders = null;

export async function getRcloneProviders({ binary = "rclone", refresh = false } = {}) {
  if (cachedProviders && !refresh) return cachedProviders;
  const result = await run(binary, ["config", "providers"]);
  if (result.code !== 0) throw new Error(`rclone config providers failed: ${result.stderr.trim().slice(-1000)}`);
  let providers;
  try { providers = JSON.parse(result.stdout); } catch { throw new Error("rclone config providers returned invalid JSON"); }
  if (!Array.isArray(providers)) throw new Error("rclone config providers returned an unexpected shape");
  cachedProviders = providers;
  return providers;
}

export async function obscureRcloneValue(value, { binary = "rclone" } = {}) {
  const result = await run(binary, ["obscure", String(value)]);
  if (result.code !== 0) throw new Error(`rclone obscure failed: ${result.stderr.trim().slice(-500)}`);
  return result.stdout.trim();
}

// Builds rclone's inline, config-less remote syntax: :type,key=value,...:
// This keeps Nexus from needing to own a separate rclone.conf credentials
// file — the fully-formed connection string lives only in integrations.json.
export function buildRcloneConnectionString(type, params) {
  const typeToken = requireToken(type, "provider type");
  const parts = [typeToken];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    parts.push(`${requireToken(key, "option name")}=${quoteRcloneValue(String(value))}`);
  }
  return `:${parts.join(",")}:`;
}

function quoteRcloneValue(value) {
  if (!/[,:"\s]/.test(value)) return value;
  return `"${value.replaceAll('"', '""')}"`;
}

function requireToken(value, name) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed || /[,:"\s]/.test(trimmed)) throw new RangeError(`${name} must not contain commas, colons, quotes or whitespace`);
  return trimmed;
}

export async function testRcloneFs(fsSpec, { binary = "rclone", timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const result = await run(binary, ["lsjson", fsSpec, "--max-depth", "1"], controller.signal);
    // The killed process resolves through the normal 'close' handler (spawn
    // has no built-in abort-to-rejection path), so a timeout must be
    // detected by checking the signal rather than by catching a rejection.
    if (controller.signal.aborted) return { ok: false, message: "Connection test timed out" };
    if (result.code === 0) return { ok: true };
    return { ok: false, message: redact(result.stderr.trim().slice(-500) || `rclone exited with code ${result.code}`, fsSpec) };
  } catch (error) {
    return { ok: false, message: redact(error.message, fsSpec) };
  } finally {
    clearTimeout(timer);
  }
}

// rclone's own error text can echo the probed fs string back, which may
// still carry an unobscured parameter the caller passed in for a live test.
function redact(message, fsSpec) {
  return fsSpec ? message.split(fsSpec).join("<remote>") : message;
}

function run(executable, args, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const abort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", abort, { once: true });
    child.once("error", reject);
    child.once("close", (code) => { signal?.removeEventListener("abort", abort); resolve({ code, stdout, stderr }); });
  });
}
