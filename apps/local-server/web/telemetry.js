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
