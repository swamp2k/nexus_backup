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

// Repository integrity is intentionally separate from inventory. A successful
// inventory proves that snapshot metadata can be read; only a completed
// restic-check is presented as integrity OK.
const repositoryCheckActiveStates = new Set(["queued", "leased", "preparing", "running", "finalizing"]);
let repositoryCheckJobs = [];
let repositoryCheckRefreshBusy = false;

const repositoryCheckObserver = new MutationObserver(() => {
  if (isRepositoryView()) queueMicrotask(() => decorateRepositoryIntegrity(repositoryCheckJobs));
});
repositoryCheckObserver.observe(document.querySelector("#content"), { childList: true });
window.addEventListener("hashchange", () => {
  if (isRepositoryView()) void refreshRepositoryIntegrity();
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && isRepositoryView()) void refreshRepositoryIntegrity();
});
document.addEventListener("click", (event) => {
  const button = event.target.closest?.("[data-repository-check]");
  if (!button || !isRepositoryView()) return;
  event.preventDefault();
  event.stopPropagation();
  void queueRepositoryIntegrityCheck(button.dataset.repositoryCheck, button);
}, true);
setInterval(() => {
  if (isRepositoryView()) void refreshRepositoryIntegrity();
}, 2500);
if (isRepositoryView()) void refreshRepositoryIntegrity();

function isRepositoryView() {
  return (location.hash.replace(/^#/, "") || "overview") === "repositories";
}

async function refreshRepositoryIntegrity() {
  if (repositoryCheckRefreshBusy || document.hidden || !isRepositoryView()) return;
  repositoryCheckRefreshBusy = true;
  try {
    const response = await fetch("/v1/local/jobs?limit=500", {
      headers: { accept: "application/json" },
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`Integrity status request failed (${response.status})`);
    const data = await response.json();
    repositoryCheckJobs = (Array.isArray(data.jobs) ? data.jobs : [])
      .filter((job) => job.type === "restic-check" && typeof job.payload?.repositoryId === "string");
    decorateRepositoryIntegrity(repositoryCheckJobs);
  } catch (error) {
    decorateRepositoryIntegrityError(error);
  } finally {
    repositoryCheckRefreshBusy = false;
  }
}

function decorateRepositoryIntegrity(jobs) {
  if (!isRepositoryView()) return;
  const byRepository = new Map();
  for (const job of jobs) {
    const repositoryId = job.payload?.repositoryId;
    if (!byRepository.has(repositoryId)) byRepository.set(repositoryId, []);
    byRepository.get(repositoryId).push(job);
  }

  document.querySelectorAll("#repository-inventory-view [data-repo]").forEach((card) => {
    const repositoryId = card.dataset.repo;
    const candidates = byRepository.get(repositoryId) ?? [];
    const active = candidates.find((job) => repositoryCheckActiveStates.has(job.state)) ?? null;
    const latest = candidates[0] ?? null;
    const state = repositoryIntegrityState(active, latest);
    let controls = card.querySelector(".repo-integrity-controls");
    if (!controls) {
      controls = document.createElement("div");
      controls.className = "repo-integrity-controls";
      card.querySelector(".repo-actions")?.append(controls);
    }
    controls.innerHTML = `<span class="badge ${state.tone}">${escapeHtml(state.label)}</span><button class="button ghost" data-repository-check="${escapeHtml(repositoryId)}" ${active ? "disabled" : ""}>${active ? "Checking…" : "Run integrity check"}</button>`;

    card.querySelector(".repo-integrity-error")?.remove();
    if (!active && latest && ["failed", "partial", "cancelled", "interrupted"].includes(latest.state)) {
      const failure = document.createElement("div");
      failure.className = "repo-error repo-integrity-error";
      failure.innerHTML = `<strong>Repository integrity check failed</strong><span>${escapeHtml(latest.lastError || "restic check did not complete successfully. Review the job log before trusting this repository.")}</span>`;
      card.querySelector(".repo-head")?.insertAdjacentElement("afterend", failure);
    }

    let meta = card.querySelector(".repo-integrity-meta");
    if (!meta) {
      meta = document.createElement("span");
      meta.className = "repo-integrity-meta";
      card.querySelector(".repo-meta")?.append(meta);
    }
    meta.textContent = active
      ? `Integrity check ${active.state}`
      : latest?.state === "completed"
        ? `Integrity checked ${relativeTime(latest.finishedAt || latest.updatedAt)}`
        : latest
          ? `Last integrity check ${latest.state} ${relativeTime(latest.finishedAt || latest.updatedAt)}`
          : "Integrity not checked";
  });
}

function repositoryIntegrityState(active, latest) {
  if (active) return { label: "Checking integrity", tone: "blue" };
  if (!latest) return { label: "Integrity not checked", tone: "warn" };
  if (latest.state === "completed") return { label: "Integrity OK", tone: "success" };
  if (["failed", "partial", "cancelled", "interrupted"].includes(latest.state)) return { label: "Integrity failed", tone: "danger" };
  return { label: "Integrity unknown", tone: "warn" };
}

async function queueRepositoryIntegrityCheck(repositoryId, button) {
  if (!repositoryId || button.disabled) return;
  button.disabled = true;
  button.textContent = "Queueing…";
  try {
    const response = await fetch("/v1/local/jobs", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        operationKey: `repository:${repositoryId}:check:${new Date().toISOString()}:${crypto.randomUUID()}`,
        type: "restic-check",
        payload: { repositoryId },
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || data.code || `Integrity check enqueue failed (${response.status})`);
    await refreshRepositoryIntegrity();
  } catch (error) {
    button.disabled = false;
    button.textContent = "Run integrity check";
    let failure = button.closest("[data-repo]")?.querySelector(".repo-integrity-error");
    if (!failure) {
      failure = document.createElement("div");
      failure.className = "repo-error repo-integrity-error";
      button.closest("[data-repo]")?.querySelector(".repo-head")?.insertAdjacentElement("afterend", failure);
    }
    if (failure) failure.innerHTML = `<strong>Could not start integrity check</strong><span>${escapeHtml(error.message || String(error))}</span>`;
  }
}

function decorateRepositoryIntegrityError(error) {
  if (!isRepositoryView()) return;
  document.querySelectorAll("#repository-inventory-view [data-repo]").forEach((card) => {
    let meta = card.querySelector(".repo-integrity-meta");
    if (!meta) {
      meta = document.createElement("span");
      meta.className = "repo-integrity-meta";
      card.querySelector(".repo-meta")?.append(meta);
    }
    meta.textContent = `Integrity status unavailable: ${error.message || String(error)}`;
  });
}

// Workstation integrity is executed by the Windows agent against its locally
// configured repository. Repository location and password stay on the workstation;
// the browser/controller only sees bounded run state and result metadata.
const workstationCheckActiveStates = new Set(["queued", "leased", "running"]);
let workstationIntegrity = new Map();
let workstationIntegrityRefreshBusy = false;

const workstationIntegrityObserver = new MutationObserver(() => {
  if (isWorkstationView()) queueMicrotask(() => decorateWorkstationIntegrity(workstationIntegrity));
});
workstationIntegrityObserver.observe(document.querySelector("#content"), { childList: true });
window.addEventListener("hashchange", () => {
  if (isWorkstationView()) void refreshWorkstationIntegrity();
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && isWorkstationView()) void refreshWorkstationIntegrity();
});
document.addEventListener("click", (event) => {
  const button = event.target.closest?.("[data-workstation-check]");
  if (!button || !isWorkstationView()) return;
  event.preventDefault();
  event.stopPropagation();
  void queueWorkstationIntegrityCheck(button.dataset.workstationCheck, button);
}, true);
setInterval(() => {
  if (isWorkstationView()) void refreshWorkstationIntegrity();
}, 2500);
if (isWorkstationView()) void refreshWorkstationIntegrity();

function isWorkstationView() {
  return (location.hash.replace(/^#/, "") || "overview") === "workstations";
}

async function refreshWorkstationIntegrity() {
  if (workstationIntegrityRefreshBusy || document.hidden || !isWorkstationView()) return;
  workstationIntegrityRefreshBusy = true;
  try {
    const response = await fetch("/v1/local/workstations", {
      headers: { accept: "application/json" },
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`Workstation integrity status request failed (${response.status})`);
    const data = await response.json();
    const workstations = Array.isArray(data.workstations) ? data.workstations : [];
    const entries = await Promise.all(workstations.map(async (workstation) => {
      const capable = workstation.capabilities?.includes("workstation.integrity.v1") === true;
      if (!capable) return [workstation.id, { workstation, check: null }];
      const checkResponse = await fetch(`/v1/local/workstations/${encodeURIComponent(workstation.id)}/recovery/check`, {
        headers: { accept: "application/json" },
        cache: "no-store",
      });
      if (!checkResponse.ok) throw new Error(`Workstation integrity result request failed (${checkResponse.status})`);
      const checkData = await checkResponse.json();
      return [workstation.id, { workstation, check: checkData.check ?? null }];
    }));
    workstationIntegrity = new Map(entries);
    decorateWorkstationIntegrity(workstationIntegrity);
  } catch (error) {
    decorateWorkstationIntegrityError(error);
  } finally {
    workstationIntegrityRefreshBusy = false;
  }
}

function decorateWorkstationIntegrity(byDevice) {
  if (!isWorkstationView()) return;
  document.querySelectorAll("#workstations-view .workstation-card[data-ws]").forEach((card) => {
    const entry = byDevice.get(card.dataset.ws);
    if (!entry) return;
    const { workstation, check } = entry;
    const capable = workstation.capabilities?.includes("workstation.integrity.v1") === true;
    const active = check && workstationCheckActiveStates.has(check.state);
    const state = workstationIntegrityState(capable, check);
    const busy = Boolean(workstation.status?.currentRunId) || active;
    const canRun = capable && workstation.enabled && workstation.online && workstation.status?.repositoryConfigured && !busy;

    let controls = card.querySelector(".ws-integrity-controls");
    if (!controls) {
      controls = document.createElement("div");
      controls.className = "ws-integrity-controls";
      card.querySelector(".transfer-actions")?.append(controls);
    }
    const buttonText = !capable ? "Update agent" : active ? "Checking…" : busy ? "Busy" : "Run integrity check";
    controls.innerHTML = `<span class="badge ${state.tone}">${escapeHtml(state.label)}</span><button class="button ghost compact" data-workstation-check="${escapeHtml(workstation.id)}" ${canRun ? "" : "disabled"}>${escapeHtml(buttonText)}</button>`;

    card.querySelector(".ws-integrity-error")?.remove();
    if (!active && check?.state === "failed") {
      const failure = document.createElement("div");
      failure.className = "repo-error ws-integrity-error";
      failure.innerHTML = `<strong>Repository integrity check failed</strong><span>${escapeHtml(check.error || "restic check did not complete successfully. Do not treat this repository as healthy until the failure is resolved.")}</span>`;
      card.querySelector(".transfer-head")?.insertAdjacentElement("afterend", failure);
    }

    let meta = card.querySelector(".ws-integrity-meta");
    if (!meta) {
      meta = document.createElement("span");
      meta.className = "ws-integrity-meta";
      card.querySelector(".transfer-meta.filters")?.append(meta);
    }
    meta.textContent = !capable
      ? "Integrity: agent update required"
      : active
        ? `Integrity check ${check.state}`
        : check?.state === "completed"
          ? `Integrity checked ${relativeTime(check.finishedAt || check.updatedAt)}`
          : check
            ? `Last integrity check ${check.state} ${relativeTime(check.finishedAt || check.updatedAt)}`
            : "Integrity not checked";
  });
}

function workstationIntegrityState(capable, check) {
  if (!capable) return { label: "Integrity unavailable", tone: "warn" };
  if (!check) return { label: "Integrity not checked", tone: "warn" };
  if (workstationCheckActiveStates.has(check.state)) return { label: "Checking integrity", tone: "blue" };
  if (check.state === "completed" && check.result?.integrity === "ok") return { label: "Integrity OK", tone: "success" };
  if (check.state === "failed") return { label: "Integrity failed", tone: "danger" };
  return { label: "Integrity unknown", tone: "warn" };
}

async function queueWorkstationIntegrityCheck(deviceId, button) {
  if (!deviceId || button.disabled) return;
  button.disabled = true;
  button.textContent = "Queueing…";
  try {
    const response = await fetch(`/v1/local/workstations/${encodeURIComponent(deviceId)}/recovery/check`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || data.code || `Workstation integrity check enqueue failed (${response.status})`);
    await refreshWorkstationIntegrity();
  } catch (error) {
    button.disabled = false;
    button.textContent = "Run integrity check";
    let failure = button.closest("[data-ws]")?.querySelector(".ws-integrity-error");
    if (!failure) {
      failure = document.createElement("div");
      failure.className = "repo-error ws-integrity-error";
      button.closest("[data-ws]")?.querySelector(".transfer-head")?.insertAdjacentElement("afterend", failure);
    }
    if (failure) failure.innerHTML = `<strong>Could not start integrity check</strong><span>${escapeHtml(error.message || String(error))}</span>`;
  }
}

function decorateWorkstationIntegrityError(error) {
  if (!isWorkstationView()) return;
  document.querySelectorAll("#workstations-view .workstation-card[data-ws]").forEach((card) => {
    let meta = card.querySelector(".ws-integrity-meta");
    if (!meta) {
      meta = document.createElement("span");
      meta.className = "ws-integrity-meta";
      card.querySelector(".transfer-meta.filters")?.append(meta);
    }
    meta.textContent = `Integrity status unavailable: ${error.message || String(error)}`;
  });
}
