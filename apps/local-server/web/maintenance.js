// Workstation updates are a local maintenance action rather than remote exec.
// The repair command re-runs the signed installer served by this appliance.
const content = document.querySelector("#content");

new MutationObserver(() => {
  if (isWorkstations()) queueMicrotask(decorateWorkstationMaintenance);
}).observe(content,{childList:true});
window.addEventListener("hashchange", () => setTimeout(() => {
  if (isWorkstations()) decorateWorkstationMaintenance();
}, 30));
setInterval(() => { if (isWorkstations()) decorateWorkstationMaintenance(); }, 3000);
if (isWorkstations()) decorateWorkstationMaintenance();

document.addEventListener("click", (event) => {
  const repair = event.target.closest?.("[data-ws-repair]");
  if (repair && isWorkstations()) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    openWorkstationRepair(repair);
    return;
  }
  const copy = event.target.closest?.("[data-copy-install]");
  if (copy) {
    const command = copy.closest(".ws-installer")?.querySelector("pre code")?.textContent || "";
    if (!command) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    void copyText(command).then(() => {
      copy.textContent = "Copied";
      notify("Installer command copied", "");
    }).catch((error) => notify("Could not copy command", error.message, true));
  }
}, true);

function isWorkstations() {
  return (location.hash.replace(/^#/, "") || "overview") === "workstations";
}

function decorateWorkstationMaintenance() {
  if (!isWorkstations()) return;
  content.querySelectorAll(".workstation-card[data-ws]").forEach((card) => {
    const actions = card.querySelector(".transfer-actions");
    if (!actions || actions.querySelector("[data-ws-repair]")) return;
    const button = document.createElement("button");
    button.className = "button ghost compact";
    button.dataset.wsRepair = "";
    button.dataset.id = card.dataset.ws || "";
    button.textContent = "Update / repair";
    button.title = "Reinstall the workstation client bundled with this Nexus build";
    const run = actions.querySelector('[data-ws-action="run"]');
    if (run) actions.insertBefore(button, run); else actions.append(button);
  });
}

function openWorkstationRepair(button) {
  document.querySelector("[data-ws-repair-modal]")?.remove();
  const card = button.closest(".workstation-card");
  const name = card?.querySelector(".transfer-title h2")?.textContent?.trim() || "Workstation";
  const origin = location.origin.replace(/'/g, "''");
  const command = `$env:NEXUS_BACKUP_URL='${origin}';irm '${origin}/install.ps1'|iex`;
  const modal = document.createElement("div");
  modal.className = "modal-backdrop";
  modal.dataset.wsRepairModal = "";
  modal.innerHTML = `<section class="modal ws-installer-modal" role="dialog" aria-modal="true"><div class="modal-header"><div><p class="eyebrow">Workstation maintenance</p><h2>Update or repair ${esc(name)}</h2></div><button class="icon-button" data-ws-repair-close aria-label="Close">×</button></div><div class="ws-installer"><p>Run this in an elevated PowerShell on <strong>${esc(name)}</strong>. It downloads the workstation client bundled with this Nexus build, preserves the existing device identity and settings, and recreates the scheduled task.</p><pre><code>${esc(command)}</code></pre><div class="modal-actions"><button type="button" class="button ghost" data-ws-repair-close>Cancel</button><button type="button" class="button primary" data-ws-repair-copy>Copy command</button></div><p class="muted-2">No enrollment token is included. This repairs an existing install by reusing its local durable token. For a new PC, use <strong>Add workstation</strong>.</p></div></section>`;
  document.body.append(modal);
  modal.querySelectorAll("[data-ws-repair-close]").forEach((close) => close.addEventListener("click", () => modal.remove()));
  modal.querySelector("[data-ws-repair-copy]")?.addEventListener("click", async (event) => {
    try {
      await copyText(command);
      event.currentTarget.textContent = "Copied";
      notify("Repair command copied", name);
    } catch (error) {
      notify("Could not copy command", error.message, true);
    }
  });
}

async function copyText(value) {
  if (navigator.clipboard?.writeText&&window.isSecureContext) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.append(textarea);
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);
  try {
    if (!document.execCommand("copy")) throw new Error("Browser denied clipboard access");
  } finally {
    textarea.remove();
  }
}

function notify(title, message, danger = false) {
  const stack = document.querySelector("#toast-stack");
  if (!stack) return;
  const node = document.createElement("div");
  node.className = `toast${danger ? " danger" : ""}`;
  node.innerHTML = `<strong>${esc(title)}</strong><span>${esc(message || "")}</span>`;
  stack.append(node);
  setTimeout(() => node.remove(), 4500);
}

function esc(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}
