const drawer = document.querySelector("#job-drawer");
const drawerContent = document.querySelector("#drawer-content");
let selectedJobId = null;
let timer = null;
let generation = 0;

document.addEventListener("click", (event) => {
  const row = event.target.closest?.("[data-job-id]");
  if (row?.dataset.jobId) {
    selectedJobId = row.dataset.jobId;
    generation += 1;
    scheduleRefresh(220, generation);
    return;
  }
  if (event.target.closest?.("#drawer-close")) stopPolling();
}, true);

const drawerObserver = new MutationObserver(() => {
  if (!drawer.classList.contains("open")) {
    stopPolling();
    return;
  }
  if (selectedJobId) scheduleRefresh(120, generation);
});
drawerObserver.observe(drawer, { attributes: true, attributeFilter: ["class"] });

function scheduleRefresh(delay, expectedGeneration) {
  clearTimeout(timer);
  timer = setTimeout(() => void refreshTelemetry(expectedGeneration), delay);
}

function stopPolling() {
  clearTimeout(timer);
  timer = null;
}

async function refreshTelemetry(expectedGeneration) {
  if (expectedGeneration !== generation || !selectedJobId || !drawer.classList.contains("open")) return;
  try {
    const response = await fetch(`/v1/local/jobs/${encodeURIComponent(selectedJobId)}/runtime?logs=200`, {
      headers: { accept: "application/json" },
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const data = await response.json();
    if (expectedGeneration !== generation || !drawer.classList.contains("open")) return;
    renderTelemetry(data);
  } catch (error) {
    renderTelemetryError(error);
  } finally {
    if (expectedGeneration === generation && drawer.classList.contains("open")) {
      timer = setTimeout(() => void refreshTelemetry(expectedGeneration), 1000);
    }
  }
}

function renderTelemetry(data) {
  let panel = document.querySelector("#runtime-telemetry");
  if (!panel) {
    panel = document.createElement("section");
    panel.id = "runtime-telemetry";
    panel.className = "runtime-telemetry";
    drawerContent.prepend(panel);
  }

  const progress = data.progress;
  const percent = calculatePercent(progress);
  const progressText = progress
    ? `${formatBytes(progress.bytesDone)}${progress.bytesTotal ? ` / ${formatBytes(progress.bytesTotal)}` : ""}`
    : "Waiting for telemetry";
  const fileText = progress?.filesDone != null
    ? `${formatNumber(progress.filesDone)}${progress.filesTotal != null ? ` / ${formatNumber(progress.filesTotal)}` : ""}`
    : "—";
  const speedText = progress?.speedBytesPerSecond != null && progress.speedBytesPerSecond > 0
    ? `${formatBytes(progress.speedBytesPerSecond)}/s`
    : "—";
  const etaText = progress?.etaSeconds != null ? formatDuration(progress.etaSeconds) : "—";
  const errors = progress?.errors ?? 0;

  panel.innerHTML = `
    <div class="runtime-head">
      <div>
        <p class="eyebrow">Live telemetry · attempt ${escapeHtml(data.attempt)}</p>
        <div class="runtime-title"><span class="live-dot"></span><strong>${progress ? escapeHtml(progress.tool) : "Waiting"}</strong></div>
      </div>
      <span class="runtime-updated">${progress?.updatedAt ? relativeTime(progress.updatedAt) : "No samples yet"}</span>
    </div>
    <div class="runtime-progress-copy"><strong>${escapeHtml(progressText)}</strong><span>${percent == null ? "—" : `${percent}%`}</span></div>
    <div class="runtime-bar"><span style="width:${percent ?? 0}%"></span></div>
    <div class="runtime-metrics">
      ${metric("Files", fileText)}
      ${metric("Speed", speedText)}
      ${metric("ETA", etaText)}
      ${metric("Errors", String(errors), errors > 0)}
    </div>
    <div class="runtime-log-head"><strong>Live log</strong><span>${data.logs?.length ?? 0} lines retained here</span></div>
    <pre class="runtime-log" id="runtime-log">${renderLogs(data.logs ?? [])}</pre>
    ${data.summary ? `<details class="runtime-summary"><summary>Tool summary</summary><pre>${escapeHtml(JSON.stringify(data.summary, null, 2))}</pre></details>` : ""}
  `;

  const log = panel.querySelector("#runtime-log");
  if (log) log.scrollTop = log.scrollHeight;
}

function renderTelemetryError(error) {
  let panel = document.querySelector("#runtime-telemetry");
  if (!panel) {
    panel = document.createElement("section");
    panel.id = "runtime-telemetry";
    panel.className = "runtime-telemetry";
    drawerContent.prepend(panel);
  }
  panel.innerHTML = `<div class="runtime-head"><div><p class="eyebrow">Live telemetry</p><strong>Telemetry unavailable</strong></div><span class="runtime-updated">${escapeHtml(error.message || String(error))}</span></div>`;
}

function calculatePercent(progress) {
  if (!progress) return null;
  if (progress.bytesTotal > 0 && progress.bytesDone != null) {
    return Math.max(0, Math.min(100, Math.round(progress.bytesDone / progress.bytesTotal * 100)));
  }
  if (progress.filesTotal > 0 && progress.filesDone != null) {
    return Math.max(0, Math.min(100, Math.round(progress.filesDone / progress.filesTotal * 100)));
  }
  return null;
}

function renderLogs(logs) {
  if (!logs.length) return "Waiting for tool output…";
  return logs.map((entry) => {
    const stamp = new Date(entry.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const stream = entry.stream === "stderr" ? "!" : "›";
    return `${escapeHtml(stamp)} ${stream} ${escapeHtml(entry.message)}`;
  }).join("\n");
}

function metric(label, value, danger = false) {
  return `<div class="runtime-metric${danger ? " danger" : ""}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function formatBytes(value) {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  let number = Number(value);
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let unit = 0;
  while (Math.abs(number) >= 1024 && unit < units.length - 1) {
    number /= 1024;
    unit += 1;
  }
  const digits = unit === 0 ? 0 : number >= 100 ? 0 : number >= 10 ? 1 : 2;
  return `${number.toFixed(digits)} ${units[unit]}`;
}

function formatNumber(value) {
  return Number(value).toLocaleString();
}

function formatDuration(seconds) {
  let remaining = Math.max(0, Math.round(Number(seconds)));
  const hours = Math.floor(remaining / 3600);
  remaining -= hours * 3600;
  const minutes = Math.floor(remaining / 60);
  const secs = remaining % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

function relativeTime(value) {
  const delta = Date.now() - Date.parse(value);
  if (!Number.isFinite(delta)) return "just now";
  const seconds = Math.max(0, Math.round(delta / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// Overview/Jobs live progress uses the enriched job list, keeping refresh to one request.
const listActiveStates = new Set(["leased", "preparing", "running", "finalizing"]);
let latestListJobs = [];
let listRefreshInFlight = false;

void refreshVisibleJobProgress();
setInterval(() => void refreshVisibleJobProgress(), 1000);
window.addEventListener("hashchange", () => setTimeout(() => decorateVisibleJobProgress(latestListJobs), 30));
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void refreshVisibleJobProgress();
});

async function refreshVisibleJobProgress() {
  if (document.hidden || listRefreshInFlight || !isProgressListView()) return;
  listRefreshInFlight = true;
  try {
    const response = await fetch("/v1/local/jobs?limit=200", {
      headers: { accept: "application/json" },
      cache: "no-store",
    });
    if (!response.ok) return;
    const data = await response.json();
    latestListJobs = Array.isArray(data.jobs) ? data.jobs : [];
    decorateVisibleJobProgress(latestListJobs);
  } catch {
    // Main dashboard refresh owns connection/error reporting. Live progress is additive.
  } finally {
    listRefreshInFlight = false;
  }
}

function isProgressListView() {
  const view = location.hash.replace(/^#/, "") || "overview";
  return view === "overview" || view === "jobs";
}

function decorateVisibleJobProgress(jobs) {
  if (!isProgressListView()) return;
  const byId = new Map(jobs.map((job) => [job.id, job]));
  document.querySelectorAll("#content table").forEach((table) => decorateProgressTable(table, byId));
  renderActiveJobStrip(jobs);
}

function decorateProgressTable(table, byId) {
  const header = table.querySelector("thead tr");
  if (header && !header.querySelector(".live-progress-head")) {
    const cell = document.createElement("th");
    cell.className = "live-progress-head";
    cell.textContent = "Progress";
    header.insertBefore(cell, header.lastElementChild);
  }

  table.querySelectorAll("tbody tr[data-job-id]").forEach((row) => {
    let cell = row.querySelector(".live-progress-cell");
    if (!cell) {
      cell = document.createElement("td");
      cell.className = "live-progress-cell";
      row.insertBefore(cell, row.lastElementChild);
    }
    renderListProgressCell(cell, byId.get(row.dataset.jobId));
  });
}

function renderListProgressCell(cell, job) {
  if (!job || !listActiveStates.has(job.state)) {
    cell.innerHTML = '<span class="live-progress-idle">—</span>';
    return;
  }
  const progress = job.runtime;
  if (!progress) {
    cell.innerHTML = '<div class="live-progress-wait"><span class="live-dot"></span><span>Starting…</span></div>';
    return;
  }

  const percent = calculatePercent(progress);
  const speed = progress.speedBytesPerSecond > 0 ? `${formatBytes(progress.speedBytesPerSecond)}/s` : null;
  const eta = progress.etaSeconds != null ? formatDuration(progress.etaSeconds) : null;
  const detail = [speed, eta ? `${eta} left` : null].filter(Boolean).join(" · ") || relativeTime(progress.updatedAt);
  const primary = percent == null
    ? formatBytes(progress.bytesDone)
    : `${percent}%`;

  cell.innerHTML = `
    <div class="live-progress-copy"><strong>${escapeHtml(primary)}</strong><span>${escapeHtml(detail)}</span></div>
    <div class="live-progress-bar"><span style="width:${percent ?? 0}%"></span></div>
  `;
}

function renderActiveJobStrip(jobs) {
  document.querySelector("#active-job-strip")?.remove();
  const view = location.hash.replace(/^#/, "") || "overview";
  if (view !== "overview") return;

  const active = jobs.filter((job) => listActiveStates.has(job.state)).slice(0, 4);
  if (!active.length) return;
  const metrics = document.querySelector("#content .metrics");
  if (!metrics) return;

  const section = document.createElement("section");
  section.id = "active-job-strip";
  section.className = "active-job-strip section-gap";
  section.innerHTML = active.map(renderActiveJobCard).join("");
  metrics.insertAdjacentElement("afterend", section);
}

function renderActiveJobCard(job) {
  const progress = job.runtime;
  const percent = calculatePercent(progress);
  const transferred = progress
    ? `${formatBytes(progress.bytesDone)}${progress.bytesTotal ? ` / ${formatBytes(progress.bytesTotal)}` : ""}`
    : "Waiting for first sample";
  const speed = progress?.speedBytesPerSecond > 0 ? `${formatBytes(progress.speedBytesPerSecond)}/s` : "—";
  const eta = progress?.etaSeconds != null ? `${formatDuration(progress.etaSeconds)} left` : "—";
  const files = progress?.filesDone != null
    ? `${formatNumber(progress.filesDone)}${progress.filesTotal != null ? ` / ${formatNumber(progress.filesTotal)}` : ""} files`
    : null;
  const name = progressJobName(job);

  return `
    <article class="active-job-card">
      <div class="active-job-head">
        <div><p class="eyebrow">${escapeHtml(job.state)} · attempt ${escapeHtml(job.attempt)}</p><strong>${escapeHtml(name)}</strong></div>
        <span class="active-job-percent">${percent == null ? "Live" : `${percent}%`}</span>
      </div>
      <div class="live-progress-bar large"><span style="width:${percent ?? 0}%"></span></div>
      <div class="active-job-meta"><span>${escapeHtml(transferred)}</span><span>${escapeHtml(speed)} · ${escapeHtml(eta)}</span></div>
      ${files ? `<div class="active-job-files">${escapeHtml(files)}</div>` : ""}
    </article>
  `;
}

function progressJobName(job) {
  const payload = job.payload ?? {};
  const source = payload.sourceId ?? payload.sourceEndpointId;
  const destination = payload.repositoryId ?? payload.destinationEndpointId;
  if (source && destination) return `${source} → ${destination}`;
  return job.operationKey || job.type || job.id;
}
