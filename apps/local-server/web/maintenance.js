const content=document.querySelector("#content");
let state=[];
let loading=false;

window.addEventListener("hashchange",()=>setTimeout(()=>{if(isPlans())void refresh();},30));
// Observe only replacement of the top-level content view. Watching the whole
// Plans subtree makes decorate() observe its own DOM writes and can create an
// endless microtask/render loop that freezes the dashboard tab.
new MutationObserver(()=>{if(isPlans())queueMicrotask(decorate)}).observe(content,{childList:true});
setInterval(()=>{if(isPlans())void refresh(true)},5000);
document.addEventListener("click",event=>{
  const button=event.target.closest?.("[data-run-maintenance]");
  if(!button||!isPlans())return;
  event.preventDefault();event.stopPropagation();event.stopImmediatePropagation();
  void runMaintenance(button);
},true);
if(isPlans())void refresh();

function isPlans(){return (location.hash.replace(/^#/,"")||"overview")==="plans"}

async function refresh(quiet=false){
  if(loading)return;loading=true;
  try{
    const response=await fetch("/v1/local/maintenance",{headers:{accept:"application/json"},cache:"no-store"});
    if(!response.ok)throw new Error(`${response.status} ${response.statusText}`);
    const data=await response.json();state=Array.isArray(data.maintenance)?data.maintenance:[];decorate();
  }catch(error){if(!quiet)notify("Maintenance status unavailable",error.message,true)}
  finally{loading=false;}
}

function decorate(){
  if(!isPlans())return;
  const view=content.querySelector("#plans-view");if(!view)return;
  const note=view.querySelector(".plans-note");
  if(note)note.innerHTML='<strong>Retention is enforced automatically.</strong> After a successful Restic plan backup, Nexus Backup queues a separate repository-locked <code>forget --prune</code> maintenance job. Failed maintenance is never auto-retried destructively.';
  const rows=[...view.querySelectorAll("tbody tr")];
  rows.forEach((row,index)=>decorateRow(row,state[index]));
}

function decorateRow(row,item){
  if(!item)return;
  const retention=row.children[4];const actions=row.querySelector(".plan-actions");
  if(!retention||!actions)return;
  let slot=retention.querySelector(".maintenance-state");
  if(!slot){slot=document.createElement("div");slot.className="maintenance-state";retention.append(slot);}
  slot.innerHTML=statusMarkup(item);
  let button=actions.querySelector("[data-run-maintenance]");
  const canRun=item.applicable&&item.retentionEnabled&&item.lastBackup?.state==="completed";
  if(!item.applicable||!item.retentionEnabled){button?.remove();return;}
  if(!button){button=document.createElement("button");button.className="button ghost";button.dataset.runMaintenance=item.planId;actions.insertBefore(button,actions.firstChild);}
  button.textContent=item.maintenance?.active?"Maintenance…":"Run retention";
  button.disabled=!canRun||Boolean(item.maintenance?.active);
  button.title=canRun?"Run retention maintenance now":"A completed backup is required first";
}

function statusMarkup(item){
  if(!item.applicable)return '<span class="maintenance-pill neutral">Not applicable</span>';
  if(!item.retentionEnabled)return '<span class="maintenance-pill neutral">Retention off</span>';
  if(!item.lastBackup)return '<span class="maintenance-pill pending">Waiting for first backup</span>';
  if(item.lastBackup.state!=="completed")return `<span class="maintenance-pill pending">Waiting · ${esc(item.lastBackup.state||"backup")}</span>`;
  const maintenance=item.maintenance;
  if(item.sourceJobHandled!==item.lastBackup.id)return '<span class="maintenance-pill pending">Retention pending</span>';
  if(!maintenance)return '<span class="maintenance-pill neutral">No maintenance job</span>';
  if(maintenance.active)return `<span class="maintenance-pill active">${esc(maintenance.state)}</span>`;
  if(maintenance.state==="completed")return `<span class="maintenance-pill success">Enforced · ${esc(relative(maintenance.finishedAt||maintenance.updatedAt))}</span>`;
  if(maintenance.state==="failed"||maintenance.state==="partial")return `<span class="maintenance-pill danger">${esc(maintenance.state)} · retry manually</span>`;
  return `<span class="maintenance-pill neutral">${esc(maintenance.state||"unknown")}</span>`;
}

async function runMaintenance(button){
  const planId=button.dataset.runMaintenance;if(!planId)return;
  const original=button.textContent;button.disabled=true;button.textContent="Queueing…";
  try{
    const response=await fetch(`/v1/local/plans/${encodeURIComponent(planId)}/maintenance`,{method:"POST",headers:{accept:"application/json"}});
    const data=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(data.message||`${response.status} ${response.statusText}`);
    notify("Retention queued",data.job?.id||"Maintenance job created");await refresh(true);
  }catch(error){notify("Retention failed to queue",error.message,true);}
  finally{button.disabled=false;button.textContent=original;}
}

function notify(title,message,danger=false){
  const stack=document.querySelector("#toast-stack");if(!stack)return;
  const node=document.createElement("div");node.className=`toast${danger?" danger":""}`;node.innerHTML=`<strong>${esc(title)}</strong><span>${esc(message||"")}</span>`;stack.append(node);setTimeout(()=>node.remove(),4500);
}
function relative(value){
  const time=Date.parse(value);if(!Number.isFinite(time))return "done";const seconds=Math.max(0,Math.round((Date.now()-time)/1000));if(seconds<60)return `${seconds}s ago`;const minutes=Math.round(seconds/60);if(minutes<60)return `${minutes}m ago`;const hours=Math.round(minutes/60);if(hours<48)return `${hours}h ago`;return `${Math.round(hours/24)}d ago`;
}
function esc(value){return String(value??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;")}

// Workstation agent updates are intentionally a local maintenance action rather
// than a hidden remote-exec feature. The repair command re-runs the signed/hashed
// installer already served by this Nexus appliance. Existing installs reuse the
// durable device token from ProgramData, preserve workstation settings, reset old
// over-restrictive ACLs, replace the bundled agent/Restic binaries and recreate the
// SYSTEM scheduled task.
new MutationObserver(()=>{if(isWorkstations())queueMicrotask(decorateWorkstationMaintenance)}).observe(content,{childList:true});
window.addEventListener("hashchange",()=>setTimeout(()=>{if(isWorkstations())decorateWorkstationMaintenance();},30));
setInterval(()=>{if(isWorkstations())decorateWorkstationMaintenance()},3000);
if(isWorkstations())decorateWorkstationMaintenance();

document.addEventListener("click",event=>{
  const repair=event.target.closest?.("[data-ws-repair]");
  if(repair&&isWorkstations()){
    event.preventDefault();event.stopPropagation();event.stopImmediatePropagation();
    openWorkstationRepair(repair);
    return;
  }
  const copy=event.target.closest?.("[data-copy-install]");
  if(copy){
    const command=copy.closest(".ws-installer")?.querySelector("pre code")?.textContent||"";
    if(!command)return;
    event.preventDefault();event.stopPropagation();event.stopImmediatePropagation();
    void copyText(command).then(()=>{copy.textContent="Copied";notify("Installer command copied","")}).catch(error=>notify("Could not copy command",error.message,true));
  }
},true);

function isWorkstations(){return (location.hash.replace(/^#/,"")||"overview")==="workstations"}

function decorateWorkstationMaintenance(){
  if(!isWorkstations())return;
  content.querySelectorAll(".workstation-card[data-ws]").forEach(card=>{
    const actions=card.querySelector(".transfer-actions");if(!actions||actions.querySelector("[data-ws-repair]"))return;
    const button=document.createElement("button");
    button.className="button ghost compact";
    button.dataset.wsRepair="";
    button.dataset.id=card.dataset.ws||"";
    button.textContent="Update / repair";
    button.title="Reinstall the workstation agent bundled with this Nexus build";
    const run=actions.querySelector('[data-ws-action="run"]');
    if(run)actions.insertBefore(button,run);else actions.append(button);
  });
}

function openWorkstationRepair(button){
  document.querySelector("[data-ws-repair-modal]")?.remove();
  const card=button.closest(".workstation-card");
  const name=card?.querySelector(".transfer-title h2")?.textContent?.trim()||"Workstation";
  const origin=location.origin.replace(/'/g,"''");
  const command=`$env:NEXUS_BACKUP_URL='${origin}';irm '${origin}/install.ps1'|iex`;
  const modal=document.createElement("div");modal.className="modal-backdrop";modal.dataset.wsRepairModal="";
  modal.innerHTML=`<section class="modal ws-installer-modal" role="dialog" aria-modal="true"><div class="modal-header"><div><p class="eyebrow">Workstation maintenance</p><h2>Update or repair ${esc(name)}</h2></div><button class="icon-button" data-ws-repair-close aria-label="Close">×</button></div><div class="ws-installer"><p>Run this in an elevated PowerShell on <strong>${esc(name)}</strong>. It downloads the workstation agent and Restic bundled with this Nexus build, preserves the existing device identity and settings, and recreates the scheduled task.</p><pre><code>${esc(command)}</code></pre><div class="modal-actions"><button type="button" class="button ghost" data-ws-repair-close>Cancel</button><button type="button" class="button primary" data-ws-repair-copy>Copy command</button></div><p class="muted-2">No enrollment token is included. This command repairs an existing install by reusing its local durable token. For a new PC, use <strong>Add workstation</strong>.</p></div></section>`;
  document.body.append(modal);
  modal.querySelectorAll("[data-ws-repair-close]").forEach(close=>close.addEventListener("click",()=>modal.remove()));
  modal.querySelector("[data-ws-repair-copy]")?.addEventListener("click",async event=>{
    try{await copyText(command);event.currentTarget.textContent="Copied";notify("Repair command copied",name)}
    catch(error){notify("Could not copy command",error.message,true)}
  });
}

async function copyText(value){
  if(navigator.clipboard?.writeText&&window.isSecureContext){await navigator.clipboard.writeText(value);return}
  const textarea=document.createElement("textarea");
  textarea.value=value;textarea.setAttribute("readonly","");textarea.style.position="fixed";textarea.style.opacity="0";textarea.style.pointerEvents="none";
  document.body.append(textarea);textarea.select();textarea.setSelectionRange(0,textarea.value.length);
  try{if(!document.execCommand("copy"))throw new Error("Browser denied clipboard access")}
  finally{textarea.remove()}
}
