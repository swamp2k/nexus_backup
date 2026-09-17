const nativeFetch = window.fetch.bind(window);
let authState = null;
let authLoading = null;

async function loadAuth() {
  if (authLoading) return authLoading;
  authLoading = (async () => {
    const response = await nativeFetch("/v1/local/auth/status", { headers: { accept: "application/json" }, cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    authState = data;
    if (!data.authenticated) { location.replace("/auth.html"); throw new Error("Authentication required"); }
    return data;
  })().finally(() => { authLoading = null; });
  return authLoading;
}

window.fetch = async function(input, init = {}) {
  const requestUrl = new URL(typeof input === "string" || input instanceof URL ? input : input.url, location.href);
  const method = String(init.method || (input instanceof Request ? input.method : "GET") || "GET").toUpperCase();
  const local = requestUrl.origin === location.origin && requestUrl.pathname.startsWith("/v1/local/");
  const authPath = requestUrl.pathname.startsWith("/v1/local/auth/");
  let nextInit = init;
  if (local && !authPath && !["GET", "HEAD", "OPTIONS"].includes(method)) {
    const auth = authState?.authenticated ? authState : await loadAuth();
    const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
    headers.set("x-nexus-csrf", auth.csrfToken);
    nextInit = { ...init, headers };
  }
  const response = await nativeFetch(input, nextInit);
  if (local && !authPath && response.status === 401) { authState = null; location.replace("/auth.html"); }
  return response;
};

window.nexusAuth = {
  async status() { return authState?.authenticated ? authState : loadAuth(); },
  async logout() {
    const auth = authState?.authenticated ? authState : await loadAuth();
    await nativeFetch("/v1/local/auth/logout", { method: "POST", headers: { "x-nexus-csrf": auth.csrfToken, accept: "application/json" } }).catch(() => {});
    authState = null;
    location.replace("/auth.html");
  },
};

void loadAuth().then(() => installWorkstationDashboard()).catch(() => {});

function installWorkstationDashboard() {
  const content = document.querySelector("#content");
  const nav = document.querySelector(".nav");
  const devicesNav = document.querySelector("#devices-nav");
  const title = document.querySelector("#page-title");
  const eyebrow = document.querySelector("#page-eyebrow");
  const newButton = document.querySelector("#new-job-button");
  const refreshButton = document.querySelector("#refresh-button");
  const toastStack = document.querySelector("#toast-stack");
  if (!content || !nav || document.querySelector("#workstations-nav")) return;
  const workstationNav = document.createElement("button");
  workstationNav.className = "nav-item";
  workstationNav.id = "workstations-nav";
  workstationNav.innerHTML = "<span class=\"nav-icon\">▤</span><span>Workstations</span>";
  devicesNav?.after(workstationNav);
  if (!devicesNav) nav.append(workstationNav);
  let workstations = [];
  let busy = false;
  let modal = null;
  workstationNav.addEventListener("click", () => { location.hash = "workstations"; activate(); });
  window.addEventListener("hashchange", activate);
  document.addEventListener("click", (event) => {
    if (!active()) return;
    if (event.target.closest?.("#new-job-button")) { event.preventDefault(); event.stopImmediatePropagation(); openEnroll(); }
    if (event.target.closest?.("#refresh-button")) { event.preventDefault(); event.stopImmediatePropagation(); void refresh(false); }
  }, true);
  new MutationObserver(() => { if (active() && !content.querySelector("#workstations-view")) queueMicrotask(render); }).observe(content, { childList: true });
  setInterval(() => { if (active()) void refresh(true); }, 3000);
  activate();

  function active() { return (location.hash.replace(/^#/, "") || "overview") === "workstations"; }
  function activate() {
    if (!active()) { workstationNav.classList.remove("active"); closeModal(); return; }
    document.querySelectorAll("[data-view]").forEach((item) => item.classList.remove("active"));
    document.querySelector("#transfers-nav")?.classList.remove("active");
    document.querySelector("#devices-nav")?.classList.remove("active");
    workstationNav.classList.add("active"); title.textContent = "Workstations"; eyebrow.textContent = "Nexus Backup";
    newButton.hidden = false; newButton.textContent = "Add workstation"; render(); void refresh(workstations.length > 0);
  }
  async function refresh(quiet = true) {
    if (busy) return; busy = true;
    if (!quiet && active()) refreshButton.textContent = "Refreshing…";
    try { const data = await request("/v1/local/workstations"); workstations = data.workstations ?? []; render(); }
    catch (error) { if (!quiet) toast("Workstations refresh failed", error.message, true); }
    finally { busy = false; if (!quiet && active()) refreshButton.textContent = "Refresh"; }
  }
  function render() {
    if (!active()) return;
    const online = workstations.filter((item) => item.online).length;
    const protectedCount = workstations.filter((item) => item.status?.repositoryConfigured && item.status?.lastSuccessAt).length;
    const running = workstations.filter((item) => ["running", "leased"].includes(item.lastRun?.state)).length;
    const attention = workstations.filter((item) => !item.status?.repositoryConfigured || ["failed", "partial"].includes(item.lastRun?.state)).length;
    content.innerHTML = `<div id="workstations-view"><div class="transfer-hero"><div><p class="eyebrow">Endpoint backup</p><h2>Workstations</h2><p>Windows PCs copy selected folders into their assigned Repository as ordinary browsable files.</p></div><span class="badge success">Flat files</span></div><div class="grid metrics">${metric("Online", online, `${workstations.length} enrolled`, online ? "blue" : "")}${metric("Protected", protectedCount, "Has successful backup", protectedCount ? "success" : "")}${metric("Running", running, "Active workstation jobs", running ? "blue" : "")}${metric("Attention", attention, attention ? "Needs setup or review" : "All clear", attention ? "warn" : "")}</div><div class="workstation-grid section-gap">${workstations.map(card).join("") || '<div class="empty"><strong>No workstations yet</strong><span>Add a workstation to generate the one-line installer command.</span></div>'}</div><div class="transfer-note"><strong>Data path:</strong> workstation → selected Repository → workstation folder. Missing source files are never deleted from the backup.</div></div>`;
    content.querySelectorAll("[data-ws-action]").forEach((button) => button.addEventListener("click", () => {
      const workstation = workstations.find((item) => item.id === button.dataset.id); if (!workstation) return;
      if (button.dataset.wsAction === "sources") void openSources(workstation);
      else if (button.dataset.wsAction === "policy") void openPolicy(workstation);
      else if (button.dataset.wsAction === "run") void runNow(workstation, button);
    }));
  }
  function card(ws) {
    const status = ws.status ?? {}, run = ws.lastRun, state = !ws.enabled ? "Disabled" : ws.online ? "Online" : "Offline";
    const tone = !ws.enabled ? "warn" : ws.online ? "success" : "danger";
    const storage = status.repositoryConfigured ? (status.repositoryKind || "flat-file") : "Repository not configured";
    return `<section class="card workstation-card"><div class="transfer-head"><div class="transfer-title"><span class="transfer-state${ws.online ? "" : " paused"}"></span><div><h2>${esc(ws.name)}</h2><span>${esc(ws.hostname || ws.id)} · ${esc(ws.version || "not installed yet")}</span></div></div><div class="transfer-actions"><span class="badge ${tone}">${state}</span><button class="button ghost compact" data-ws-action="sources" data-id="${attr(ws.id)}">Sources</button><button class="button ghost compact" data-ws-action="policy" data-id="${attr(ws.id)}">Policy</button><button class="button primary compact" data-ws-action="run" data-id="${attr(ws.id)}" ${!ws.online || !status.repositoryConfigured || !ws.policy ? "disabled" : ""}>Run now</button></div></div><div class="transfer-facts">${fact("Storage", storage, status.repositoryConfigured ? "Ordinary files under /backup" : "Select a repository in policy", status.repositoryConfigured ? "" : "warn")}${fact("Last success", status.lastSuccessAt ? relative(status.lastSuccessAt) : "Never", "Flat-file copy")}${fact("Next run", ws.policy?.nextRunAt ? relative(ws.policy.nextRunAt) : "Not scheduled", ws.policy?.enabled ? scheduleLabel(ws.policy.schedule) : "Policy disabled")}${fact("Last run", run?.state || "never", run?.error || status.lastError || "No error", ["failed", "partial"].includes(run?.state) ? "danger" : "")}</div><div class="transfer-meta filters"><span>Sources: ${ws.policy?.sourcePaths?.length ? esc(ws.policy.sourcePaths.join(", ")) : "not configured"}</span><span>Excludes: ${ws.policy?.excludePatterns?.length ? esc(ws.policy.excludePatterns.join(", ")) : "none"}</span><span>Last seen: ${ws.lastSeenAt ? relative(ws.lastSeenAt) : "never"}</span></div></section>`;
  }
  async function runNow(ws, button) { button.disabled = true; try { await request(`/v1/local/workstations/${encodeURIComponent(ws.id)}/run`, { method: "POST", body: {} }); toast("Workstation backup queued", ws.name); await refresh(true); } catch (error) { toast("Could not queue backup", error.message, true); } finally { button.disabled = false; } }
  async function openEnroll() {
    closeModal(); let repositories;
    try { repositories = (await request("/v1/local/repositories")).repositories ?? []; } catch (error) { toast("Could not load repositories", error.message, true); return; }
    if (!repositories.length) { toast("Create a repository first", "Workstations need a selected Repository.", true); return; }
    modal = document.createElement("div"); modal.className = "modal-backdrop";
    modal.innerHTML = `<section class="modal"><div class="modal-header"><div><p class="eyebrow">Windows endpoint</p><h2>Add workstation</h2></div><button class="icon-button" data-close>×</button></div><form><label><span>Name</span><input name="name" required maxlength="100"></label><label><span>Repository</span><select name="repositoryId" required>${repositories.map((item) => `<option value="${attr(item.id)}">${esc(item.name)}</option>`).join("")}</select></label><label><span>Destination folder <small>optional</small></span><input name="destinationFolder" maxlength="255" placeholder="Same as workstation name"></label><p class="muted-2">The workstation uses its device token to upload ordinary files directly to the selected Repository.</p><div class="modal-actions"><button type="button" class="button ghost" data-close>Cancel</button><button type="submit" class="button primary">Create installer</button></div></form></section>`;
    document.body.append(modal); modal.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", closeModal));
    modal.querySelector("form").addEventListener("submit", async (event) => { event.preventDefault(); const data = new FormData(event.currentTarget); try { const result = await request("/v1/local/workstations/enroll", { method: "POST", body: { name: data.get("name"), repositoryId: data.get("repositoryId"), destinationFolder: data.get("destinationFolder") || undefined } }); closeModal(); showInstaller(result); await refresh(true); } catch (error) { toast("Enrollment failed", error.message, true); } });
  }
  function showInstaller(data) { modal = document.createElement("div"); modal.className = "modal-backdrop"; modal.innerHTML = `<section class="modal ws-installer-modal"><div class="modal-header"><div><p class="eyebrow">One-line install</p><h2>${esc(data.device?.name || "Workstation")}</h2></div><button class="icon-button" data-close>×</button></div><div class="ws-installer"><p>Run this in an elevated PowerShell, or send the exact same command through PCWatch:</p><pre><code>${esc(data.installCommand || "")}</code></pre><button class="button primary" data-copy>Copy command</button><p class="muted-2">This installer contains the one-time device bootstrap needed by the workstation client.</p></div></section>`; document.body.append(modal); modal.querySelector("[data-close]").addEventListener("click", closeModal); modal.querySelector("[data-copy]").addEventListener("click", async (event) => { await navigator.clipboard?.writeText(data.installCommand || ""); event.currentTarget.textContent = "Copied"; }); }
  async function openSources(ws) { closeModal(); modal = document.createElement("div"); modal.className = "modal-backdrop"; modal.innerHTML = `<section class="modal ws-policy-modal"><div class="modal-header"><div><p class="eyebrow">${esc(ws.name)}</p><h2>Backup sources</h2></div><button class="icon-button" data-close>×</button></div><p class="muted-2">Run TreeSize for the drives you want to inspect. Folder selection reads the saved directory inventory.</p><button class="button ghost" data-scan>Refresh directory inventory</button><div class="transfer-note" data-status>Loading saved inventory…</div><div class="ws-source-tree" data-tree></div><div class="modal-actions"><button class="button ghost" data-close>Cancel</button><button class="button primary" data-save>Save selected folders</button></div></section>`; document.body.append(modal); modal.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", closeModal)); const status = modal.querySelector("[data-status]"), tree = modal.querySelector("[data-tree]"); let scan; const renderTree = () => { tree.innerHTML = (scan?.nodes ?? []).map((node) => `<label class="ws-source-row"><input type="checkbox" data-path value="${attr(node.path)}" ${(ws.policy?.sourcePaths ?? []).includes(node.path) ? "checked" : ""}> <strong>${esc(node.path)}</strong><span>${Number(node.files || 0)} files</span></label>`).join("") || "<div class=\"empty compact\">No directory inventory available.</div>"; }; const load = async () => { const result = await request(`/v1/local/workstations/${encodeURIComponent(ws.id)}/source-scan`); scan = result.scan; status.textContent = scan ? `Last scan ${relative(scan.scannedAt)}` : "No saved directory inventory yet."; renderTree(); }; modal.querySelector("[data-scan]").addEventListener("click", async (event) => { event.currentTarget.disabled = true; try { await request(`/v1/local/workstations/${encodeURIComponent(ws.id)}/source-scan`, { method: "POST", body: { drives: ws.status?.localDrives ?? [] } }); await load(); } catch (error) { status.textContent = error.message; } finally { event.currentTarget.disabled = false; } }); modal.querySelector("[data-save]").addEventListener("click", async () => { const paths = [...modal.querySelectorAll("[data-path]:checked")].map((item) => item.value); const policy = ws.policy || {}; try { await request(`/v1/local/workstations/${encodeURIComponent(ws.id)}/policy`, { method: "PUT", body: { enabled: policy.enabled !== false, repositoryId: policy.repositoryId, destinationFolder: policy.destinationFolder || ws.name, sourcePaths: paths, excludePatterns: policy.excludePatterns || [], schedule: policy.schedule || { kind: "daily", time: "02:00" }, timezone: policy.timezone || "UTC" } }); closeModal(); await refresh(true); } catch (error) { toast("Could not save backup sources", error.message, true); } }); try { await load(); } catch (error) { status.textContent = error.message; } }
  async function openPolicy(ws) { closeModal(); const repositories = (await request("/v1/local/repositories")).repositories ?? []; const policy = ws.policy ?? {}; modal = document.createElement("div"); modal.className = "modal-backdrop"; modal.innerHTML = `<section class="modal ws-policy-modal"><div class="modal-header"><div><p class="eyebrow">${esc(ws.name)}</p><h2>Backup policy</h2></div><button class="icon-button" data-close>×</button></div><form><label><span>Repository</span><select name="repositoryId" required>${repositories.map((item) => `<option value="${attr(item.id)}" ${item.id === policy.repositoryId ? "selected" : ""}>${esc(item.name)}</option>`).join("")}</select></label><label><span>Destination folder</span><input name="destinationFolder" value="${attr(policy.destinationFolder || ws.name)}" required></label><label><span>Source paths</span><textarea name="sourcePaths" rows="5">${esc((policy.sourcePaths || []).join("\n"))}</textarea></label><label><span>Exclude patterns</span><textarea name="excludePatterns" rows="4">${esc((policy.excludePatterns || []).join("\n"))}</textarea></label><div class="ws-form-grid"><label><span>Schedule</span><select name="kind"><option value="daily">Daily</option><option value="weekly">Weekly</option></select></label><label><span>Time</span><input name="time" type="time" value="${attr(policy.schedule?.time || "02:00")}" required></label><label><span>Timezone</span><input name="timezone" value="${attr(policy.timezone || "UTC")}" required></label></div><label class="enabled-row"><input name="enabled" type="checkbox" ${policy.enabled !== false ? "checked" : ""}><span>Enable scheduled backups</span></label><div class="modal-actions"><button type="button" class="button ghost" data-close>Cancel</button><button type="submit" class="button primary">Save policy</button></div></form></section>`; document.body.append(modal); modal.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", closeModal)); modal.querySelector("form").addEventListener("submit", async (event) => { event.preventDefault(); const data = new FormData(event.currentTarget); const body = { enabled: data.has("enabled"), repositoryId: String(data.get("repositoryId")), destinationFolder: String(data.get("destinationFolder")), sourcePaths: lines(data.get("sourcePaths")), excludePatterns: lines(data.get("excludePatterns")), schedule: { kind: String(data.get("kind")), time: String(data.get("time")) }, timezone: String(data.get("timezone")) }; try { await request(`/v1/local/workstations/${encodeURIComponent(ws.id)}/policy`, { method: "PUT", body }); closeModal(); await refresh(true); } catch (error) { toast("Policy save failed", error.message, true); } }); }
  function closeModal() { modal?.remove(); modal = null; }
  async function request(url, { method = "GET", body } = {}) { const response = await fetch(url, { method, headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.message || `${method} ${url} failed (${response.status})`); return data; }
  function lines(value) { return String(value || "").split(/\r?\n/).map((item) => item.trim()).filter(Boolean); }
  function metric(label, value, sub, tone = "") { return `<article class="metric ${tone}"><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(sub)}</small></article>`; }
  function fact(label, value, sub, tone = "") { return `<div class="transfer-fact ${tone}"><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(sub)}</small></div>`; }
  function scheduleLabel(schedule) { return schedule?.kind === "weekly" ? `${schedule.time} weekly` : `${schedule?.time || "02:00"} daily`; }
  function relative(value) { const ms = Date.now() - new Date(value).getTime(); if (!Number.isFinite(ms)) return "—"; const sec = Math.round(Math.abs(ms) / 1000); if (sec < 60) return ms < 0 ? "in <1m" : "just now"; const min = Math.round(sec / 60); if (min < 60) return ms < 0 ? `in ${min}m` : `${min}m ago`; const hr = Math.round(min / 60); return ms < 0 ? `in ${hr}h` : `${hr}h ago`; }
  function esc(value) { return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char])); }
  function attr(value) { return esc(value); }
  function toast(head, detail, error = false) { const item = document.createElement("div"); item.className = `toast${error ? " error" : ""}`; item.innerHTML = `<strong>${esc(head)}</strong><span>${esc(detail || "")}</span>`; toastStack?.append(item); setTimeout(() => item.remove(), 4500); }
}
