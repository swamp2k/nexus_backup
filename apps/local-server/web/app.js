const state = {
  view: location.hash.replace(/^#/, "") || "overview",
  jobs: [],
  config: { available: false, sources: [], endpoints: [] },
  info: null,
  health: null,
  filter: "",
  statusFilter: "",
  selectedJob: null,
  selectedEvents: [],
  refreshing: false,
};
const pageTitles = { overview: "Overview", jobs: "Jobs", sources: "Sources", destinations: "Destinations", settings: "Settings" };
const sidecarViews = new Set(["transfers", "workstations", "repositories"]);
const terminalStates = new Set(["completed", "partial", "failed", "cancelled"]);
const activeStates = new Set(["leased", "preparing", "running", "finalizing"]);
const content = document.querySelector("#content");
const pageTitle = document.querySelector("#page-title");
const connectionPill = document.querySelector("#connection-pill");
const drawer = document.querySelector("#job-drawer");
const drawerTitle = document.querySelector("#drawer-title");
const drawerContent = document.querySelector("#drawer-content");
const toastStack = document.querySelector("#toast-stack");

applyTheme(localStorage.getItem("nexus-backup-theme") || "dark");
bindStaticEvents();
await refreshAll();
render();
setInterval(() => void refreshAll({ quiet: true }), 5000);

function bindStaticEvents() {
  document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => navigate(button.dataset.view)));
  document.querySelector("#refresh-button").addEventListener("click", () => void refreshAll());
  document.querySelector("#theme-button").addEventListener("click", toggleTheme);
  document.querySelector("#menu-button").addEventListener("click", () => document.body.classList.toggle("menu-open"));
  document.querySelector("#scrim").addEventListener("click", () => document.body.classList.remove("menu-open"));
  document.querySelector("#drawer-close").addEventListener("click", closeDrawer);
  window.addEventListener("hashchange", () => {
    const view = location.hash.replace(/^#/, "") || "overview";
    if (pageTitles[view] || sidecarViews.has(view)) {
      state.view = view;
      if (pageTitles[view]) render();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeDrawer();
  });
}

async function refreshAll({ quiet = false } = {}) {
  if (state.refreshing) return;
  state.refreshing = true;
  const button = document.querySelector("#refresh-button");
  if (!quiet) button.textContent = "Refreshing…";
  try {
    const [jobs, config, info, health] = await Promise.all([
      api("/v1/local/jobs?limit=200"),
      api("/v1/local/config"),
      api("/v1/local/info"),
      api("/healthz"),
    ]);
    state.jobs = jobs.jobs ?? [];
    state.config = config;
    state.info = info;
    state.health = health;
    setConnection(true);
    render();
  } catch (error) {
    setConnection(false);
    if (!quiet) toast("Refresh failed", error.message, true);
  } finally {
    state.refreshing = false;
    if (!quiet) button.textContent = "Refresh";
  }
}

function navigate(view) {
  if (!pageTitles[view]) return;
  state.view = view;
  location.hash = view;
  document.body.classList.remove("menu-open");
  render();
}

function render() {
  if (sidecarViews.has(state.view)) return;
  pageTitle.textContent = pageTitles[state.view] ?? "Overview";
  document.querySelectorAll("[data-view]").forEach((button) => button.classList.toggle("active", button.dataset.view === state.view));
  document.querySelector("#new-job-button").hidden = true;
  if (state.view === "overview") renderOverview();
  else if (state.view === "jobs") renderJobs();
  else if (state.view === "sources") renderSources();
  else if (state.view === "destinations") renderDestinations();
  else renderSettings();
}

function renderOverview() {
  const queued = state.jobs.filter((job) => job.state === "queued").length;
  const active = state.jobs.filter((job) => activeStates.has(job.state)).length;
  const failed = state.jobs.filter((job) => ["failed", "partial"].includes(job.state)).length;
  const recentTerminal = state.jobs.filter((job) => terminalStates.has(job.state)).slice(0, 20);
  const successRate = recentTerminal.length ? Math.round(recentTerminal.filter((job) => job.state === "completed").length / recentTerminal.length * 100) : 100;
  content.innerHTML = `<div class="grid metrics">${metricCard("Active jobs", active, active ? "Work in progress" : "Nothing running", "blue")}${metricCard("Queued", queued, queued ? "Waiting for local execution" : "Queue is clear", queued ? "warn" : "")}${metricCard("Success rate", `${successRate}%`, "Last 20 finished jobs", failed ? "warn" : "")}${metricCard("Workstations", "Available", "Flat-file clients", "")}</div><div class="grid two-col section-gap"><section class="card"><div class="card-header"><div><h2>Recent jobs</h2><p>Live state from local SQLite</p></div><button class="button ghost" data-go-jobs>View all</button></div>${jobsTable(state.jobs.slice(0, 8))}</section><section class="card card-pad"><div class="flex items-center justify-between gap-8"><div><p class="eyebrow">System</p><h2>Local appliance</h2></div>${badge("Self-contained", "success")}</div><div class="stack mt-16">${statusRow("Control plane", state.health?.ok ? "Healthy" : "Unavailable", Boolean(state.health?.ok))}${statusRow("Local execution", "Running in Nexus", true)}${statusRow("Configuration", state.config.available ? "Loaded" : "Waiting for configuration", state.config.available)}${statusRow("Remote connection", "Optional · disabled by default", true)}</div></section></div><div class="grid three-col section-gap">${summaryEntityCard("Sources", state.config.sources?.length ?? 0, "Configured source paths", "⇤", "sources")}${summaryEntityCard("Destinations", state.config.endpoints?.length ?? 0, "Configured source integrations", "⇥", "destinations")}${summaryEntityCard("Repositories", "→", "Ordinary folders under /backup", "▣", "repositories")}</div>`;
  bindJobRows();
  content.querySelector("[data-go-jobs]")?.addEventListener("click", () => navigate("jobs"));
  content.querySelectorAll("[data-summary-view]").forEach((item) => item.addEventListener("click", () => navigate(item.dataset.summaryView)));
}

function renderJobs() {
  const filter = state.filter.toLowerCase();
  const jobs = state.jobs.filter((job) => {
    const matchesText = !filter || [job.id, job.operationKey, job.type, job.state].some((value) => String(value).toLowerCase().includes(filter));
    return matchesText && (!state.statusFilter || job.state === state.statusFilter);
  });
  content.innerHTML = `<div class="toolbar"><div class="toolbar-group"><input class="filter-input" id="job-filter" value="${escapeAttr(state.filter)}" placeholder="Filter jobs…"><select id="status-filter"><option value="">All states</option>${["queued", "leased", "preparing", "running", "finalizing", "completed", "partial", "failed", "cancelled", "interrupted"].map((value) => `<option value="${value}" ${state.statusFilter === value ? "selected" : ""}>${value}</option>`).join("")}</select></div><span class="muted small">${jobs.length} of ${state.jobs.length} jobs</span></div><section class="card">${jobsTable(jobs)}</section>`;
  document.querySelector("#job-filter")?.addEventListener("input", (event) => { state.filter = event.target.value; renderJobs(); });
  document.querySelector("#status-filter")?.addEventListener("change", (event) => { state.statusFilter = event.target.value; renderJobs(); });
  bindJobRows();
}

function renderSources() {
  const sources = state.config.sources ?? [];
  content.innerHTML = `<section class="card card-pad"><div class="flex items-center justify-between gap-8"><div><p class="eyebrow">Local configuration</p><h2>Sources</h2><p class="muted small">Only permitted local paths are exposed to the dashboard.</p></div>${badge(`${sources.length} configured`, sources.length ? "success" : "warn")}</div><div class="entity-grid mt-16">${sources.map((source) => `<article class="entity-card"><div class="entity-meta"><strong>${escapeHtml(source.id)}</strong><p>${source.paths.length} path${source.paths.length === 1 ? "" : "s"}</p>${source.paths.map((path) => `<code>${escapeHtml(path)}</code>`).join("")}</div><div class="entity-icon">⇤</div></article>`).join("") || emptyBlock("No sources configured", "Add a source to the local configuration.")}</div></section>`;
}

function renderDestinations() {
  const endpoints = state.config.endpoints ?? [];
  content.innerHTML = `<section class="card card-pad"><div class="flex items-center justify-between gap-8"><div><p class="eyebrow">Local configuration</p><h2>Source integrations</h2><p class="muted small">Credentials stay inside the appliance. The UI only sees sanitized endpoint metadata.</p></div>${badge(`${endpoints.length} configured`, endpoints.length ? "success" : "warn")}</div><div class="entity-grid mt-16">${endpoints.map((endpoint) => `<article class="entity-card"><div class="entity-meta"><strong>${escapeHtml(endpoint.id)}</strong><p>${endpoint.mount?.enabled ? `Mount · VFS ${escapeHtml(endpoint.mount.vfsCacheMode || "off")}` : "Transfer endpoint"}</p><p>${endpoint.allowMove ? "Move allowed by local policy" : "Copy-only local policy"}</p></div><div class="entity-icon">⇥</div></article>`).join("") || emptyBlock("No integrations configured", "Add a source integration to the local configuration.")}</div></section>`;
}

function renderSettings() {
  content.innerHTML = `<div class="grid two-col"><section class="card card-pad"><p class="eyebrow">Deployment</p><h2>Local-first</h2><div class="stack mt-16">${settingsRow("Primary mode", "Self-contained Docker")}${settingsRow("Database", "Local SQLite")}${settingsRow("Backup data path", "Direct local execution")}${settingsRow("Cloudflare", "Optional remote control only")}${settingsRow("Dashboard refresh", "5 seconds")}</div></section><section class="card card-pad"><p class="eyebrow">Safety boundary</p><h2>Secrets stay local</h2><p class="muted">Control tokens, workstation credentials, rclone credentials and repository environment secrets stay inside Nexus. Manual receiver credentials are shown only during explicit enrollment or reset.</p></section></div>`;
}

function jobsTable(jobs) {
  if (!jobs.length) return emptyBlock("No jobs yet", "Historical job activity appears here.");
  return `<div class="table-wrap"><table><thead><tr><th>Status</th><th>Job</th><th>Type</th><th>Attempt</th><th>Updated</th></tr></thead><tbody>${jobs.map((job) => `<tr data-job-id="${escapeAttr(job.id)}"><td>${statusBadge(job.state)}</td><td><span class="cell-primary">${escapeHtml(shortJobName(job))}</span><span class="cell-sub mono">${escapeHtml(job.id)}</span></td><td>${escapeHtml(jobTypeLabel(job.type))}</td><td>#${Number(job.attempt || 0)}</td><td>${relativeTime(job.updatedAt)}</td></tr>`).join("")}</tbody></table></div>`;
}

function bindJobRows() { content.querySelectorAll("[data-job-id]").forEach((row) => row.addEventListener("click", () => void openJob(row.dataset.jobId))); }
async function openJob(id) { drawer.classList.add("open"); drawer.setAttribute("aria-hidden", "false"); drawerTitle.textContent = "Loading…"; drawerContent.innerHTML = '<div class="loading-card">Loading job detail…</div>'; try { const [detail, history] = await Promise.all([api(`/v1/local/jobs/${encodeURIComponent(id)}`), api(`/v1/local/jobs/${encodeURIComponent(id)}/events`)]); state.selectedJob = detail.job; state.selectedEvents = history.events ?? []; drawerTitle.textContent = shortJobName(detail.job); renderDrawer(); } catch (error) { drawerTitle.textContent = "Job"; drawerContent.innerHTML = `<div class="empty"><strong>Could not load job</strong>${escapeHtml(error.message)}</div>`; } }
function renderDrawer() { const job = state.selectedJob; if (!job) return; drawerContent.innerHTML = `<div class="flex items-center justify-between gap-8">${statusBadge(job.state)}<span class="muted-2 small">${relativeTime(job.updatedAt)}</span></div><div class="detail-grid mt-16">${detailItem("Type", jobTypeLabel(job.type))}${detailItem("Attempt", `#${job.attempt}`)}${detailItem("Created", formatDate(job.createdAt))}${detailItem("Started", job.startedAt ? formatDate(job.startedAt) : "—")}${detailItem("Finished", job.finishedAt ? formatDate(job.finishedAt) : "—")}${detailItem("Execution", "Local Nexus")}</div>${job.lastError ? `<div class="status-row mt-16"><div><strong>Last error</strong><span>${escapeHtml(job.lastError)}</span></div><span class="status-indicator off"></span></div>` : ""}<p class="eyebrow mt-16">Payload</p><pre class="payload">${escapeHtml(JSON.stringify(job.payload, null, 2))}</pre><p class="eyebrow mt-16">Lifecycle</p><div class="timeline">${state.selectedEvents.map((event) => `<div class="timeline-item"><div class="timeline-dot"></div><div><strong>${escapeHtml(eventLabel(event.type))}</strong><span>${formatDate(event.at)}</span></div></div>`).join("") || '<div class="muted small">No lifecycle events recorded.</div>'}</div>`; }
function closeDrawer() { drawer.classList.remove("open"); drawer.setAttribute("aria-hidden", "true"); }
function metricCard(label, value, foot, accent = "") { return `<article class="card metric"><div class="metric-head"><span>${escapeHtml(label)}</span><span class="metric-accent ${accent}"></span></div><div class="metric-value">${escapeHtml(String(value))}</div><div class="metric-foot">${escapeHtml(foot)}</div></article>`; }
function summaryEntityCard(title, count, foot, icon, view) { return `<article class="card card-pad" data-summary-view="${view}" style="cursor:pointer"><div class="flex items-center justify-between gap-8"><div><p class="eyebrow">${escapeHtml(title)}</p><div class="metric-value">${escapeHtml(String(count))}</div></div><div class="entity-icon">${icon}</div></div><p class="muted small">${escapeHtml(foot)}</p></article>`; }
function statusRow(label, value, online) { return `<div class="status-row"><div><strong>${escapeHtml(label)}</strong><span>${escapeHtml(value)}</span></div><span class="status-indicator ${online ? "" : "off"}"></span></div>`; }
function settingsRow(label, value) { return `<div class="status-row"><div><strong>${escapeHtml(label)}</strong><span>${escapeHtml(value)}</span></div></div>`; }
function detailItem(label, value) { return `<div class="detail-item"><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value))}</strong></div>`; }
function emptyBlock(title, body) { return `<div class="empty"><strong>${escapeHtml(title)}</strong>${escapeHtml(body)}</div>`; }
function badge(text, tone = "") { return `<span class="badge ${tone}">${escapeHtml(text)}</span>`; }
function statusBadge(stateValue) { const tone = stateValue === "completed" ? "success" : stateValue === "partial" || stateValue === "queued" ? "warn" : stateValue === "failed" || stateValue === "cancelled" ? "danger" : activeStates.has(stateValue) ? "info" : ""; return badge(stateValue, tone); }
function shortJobName(job) { const payload = job.payload ?? {}; if (job.type === "rclone-transfer") return `${payload.sourceEndpointId ?? "source"} → ${payload.destinationEndpointId ?? "destination"}`; return job.operationKey || job.id; }
function jobTypeLabel(type) { return { "rclone-transfer": "Rclone copy" }[type] || type; }
function eventLabel(type) { return { "job.created": "Job created", "job.leased": "Lease acquired", "job.lease_renewed": "Lease renewed", "job.transitioned": "State changed", "job.recovered": "Recovered after stale lease", "job.note": "Job note" }[type] || type; }
function relativeTime(value) { if (!value) return "—"; const date = new Date(value); const seconds = Math.round((date.getTime() - Date.now()) / 1000); if (!Number.isFinite(seconds)) return "—"; const absolute = Math.abs(seconds); const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }); if (absolute < 60) return formatter.format(seconds, "second"); const minutes = Math.round(seconds / 60); if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute"); const hours = Math.round(minutes / 60); if (Math.abs(hours) < 24) return formatter.format(hours, "hour"); return formatter.format(Math.round(hours / 24), "day"); }
function formatDate(value) { if (!value) return "—"; const date = new Date(value); return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString(); }
function setConnection(online) { connectionPill.classList.toggle("online", online); connectionPill.classList.toggle("offline", !online); connectionPill.querySelector("span:last-child").textContent = online ? "Local control online" : "Control unavailable"; }
function toggleTheme() { const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark"; applyTheme(next); localStorage.setItem("nexus-backup-theme", next); }
function applyTheme(theme) { document.documentElement.dataset.theme = theme === "light" ? "light" : "dark"; }
function toast(title, message = "", error = false) { const item = document.createElement("div"); item.className = `toast ${error ? "error" : ""}`; item.innerHTML = `<strong>${escapeHtml(title)}</strong>${message ? `<div>${escapeHtml(message)}</div>` : ""}`; toastStack.append(item); setTimeout(() => item.remove(), 4500); }
async function api(path, options = {}) { const response = await fetch(path, { cache: "no-store", ...options }); const contentType = response.headers.get("content-type") || ""; const body = contentType.includes("application/json") ? await response.json() : await response.text(); if (!response.ok) throw new Error(typeof body === "object" && body?.message ? body.message : `${response.status} ${response.statusText}`); return body; }
function escapeHtml(value) { return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;"); }
function escapeAttr(value) { return escapeHtml(value); }
