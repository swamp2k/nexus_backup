const content=document.querySelector("#content");
const title=document.querySelector("#page-title");
const eyebrow=document.querySelector("#page-eyebrow");
const toastStack=document.querySelector("#toast-stack");
const terminalStates=new Set(["completed","partial","failed","cancelled","interrupted"]);
let repositories=[];
let restoreTargets=[];
let available=false;
let loading=false;
let expanded=new Set();
let filters=new Map();
let workspace=null;
let browseLoading=false;
let previewLoading=false;

window.addEventListener("hashchange",activate);
document.addEventListener("click",event=>{
  if(!isActive())return;
  const refresh=event.target.closest?.("#refresh-button");
  if(refresh)void load(false);
},true);
new MutationObserver(()=>{
  if(isActive()&&!content.querySelector("#repository-inventory-view"))queueMicrotask(render);
}).observe(content,{childList:true});
setInterval(()=>{
  if(!isActive())return;
  if(repositories.some(repository=>repository.activeScan))void load(true);
  if(workspace?.browse?.activeJob)void loadBrowse(true,false);
  if(workspace?.previewJob&&!terminalStates.has(workspace.previewJob.state))void loadPreview(true);
},1500);
activate();

function isActive(){return(location.hash.replace(/^#/,"")||"overview")==="repositories"}
function activate(){
  if(!isActive())return;
  if(title)title.textContent="Repositories";
  if(eyebrow)eyebrow.textContent="Restore readiness";
  render();
  void load(repositories.length>0);
}

async function load(quiet=true){
  if(loading)return;
  loading=true;
  try{
    const response=await api("/v1/local/repositories");
    repositories=response.repositories??[];
    restoreTargets=response.restoreTargets??[];
    available=Boolean(response.available);
    if(workspace&&!restoreTargets.some(target=>target.id===workspace.targetId))workspace.targetId=restoreTargets[0]?.id??"";
    render();
  }catch(error){if(!quiet)toast("Repository refresh failed",error.message,true)}
  finally{loading=false;}
}

function render(){
  if(!isActive())return;
  if(title)title.textContent="Repositories";
  if(eyebrow)eyebrow.textContent="Restore readiness";
  const scanned=repositories.filter(repository=>repository.inventory).length;
  const snapshots=repositories.reduce((sum,repository)=>sum+Number(repository.inventory?.stats?.snapshotsCount??repository.inventory?.returnedSnapshots??0),0);
  const stored=repositories.reduce((sum,repository)=>sum+Number(repository.inventory?.stats?.totalSize??0),0);
  content.innerHTML=`<div id="repository-inventory-view">
    <div class="repo-hero"><div><p class="eyebrow">Restic inventory</p><h2>Repositories & snapshots</h2><p>Read-only catalog, snapshot content browser and real restore dry-runs from the local agent. Credentials and restore paths stay agent-local.</p></div><span class="badge success">Safe preview</span></div>
    <div class="grid metrics">${metric("Repositories",repositories.length,`${scanned} scanned`)}${metric("Snapshots",snapshots,"Known from latest inventories")}${metric("Stored data",stored?bytes(stored):"—","Raw deduplicated repository data")}${metric("Restore targets",restoreTargets.length,restoreTargets.length?"Local IDs · paths hidden":"Configure a staging target")}</div>
    <div class="repo-stack section-gap">${repositories.map(repository=>repositoryCard(repository)).join("")||empty()}</div>
    <div class="repo-note"><strong>Restore execution is intentionally disabled.</strong> Browse uses read-only <code>restic ls</code>. Preview runs a real <code>restic restore --dry-run</code> against an agent-local target. No files are written; actual restore stays locked until local authentication is added.</div>
  </div>`;
  bind();
}

function repositoryCard(repository){
  const inventory=repository.inventory;
  const scan=repository.activeScan||repository.lastScan;
  const active=Boolean(repository.activeScan);
  const failed=repository.lastScan?.state==="failed";
  const open=expanded.has(repository.id);
  const stats=inventory?.stats??{};
  const latest=inventory?.snapshots?.[0];
  const count=stats.snapshotsCount??inventory?.returnedSnapshots??null;
  return `<section class="card repo-card" data-repo="${attr(repository.id)}">
    <div class="repo-head"><div class="repo-title"><div class="entity-icon">▣</div><div><h2>${esc(repository.id)}</h2><code>${esc(repository.repository||"repository path hidden")}</code></div></div><div class="repo-actions"><span class="badge ${active?"blue":failed?"danger":inventory?"success":"warn"}">${active?"Scanning":failed?"Last scan failed":inventory?"Indexed":"Not scanned"}</span><button class="button ghost" data-scan="${attr(repository.id)}" ${active||!available?"disabled":""}>${active?"Scanning…":inventory?"Refresh inventory":"Scan repository"}</button></div></div>
    ${failed?`<div class="repo-error"><strong>Last inventory scan failed</strong><span>${esc(repository.lastScan.error||"Open the scan job for details.")}</span></div>`:""}
    <div class="repo-facts">${fact("Snapshots",count??"—",inventory?.truncated?`Showing latest ${inventory.returnedSnapshots}`:"Catalogued snapshots")}${fact("Stored",stats.totalSize!=null?bytes(stats.totalSize):"—","Raw data after dedupe/compression")}${fact("Files",stats.totalFileCount!=null?number(stats.totalFileCount):"—","Across scanned snapshots")}${fact("Latest",latest?relative(latest.time):"—",latest?date(latest.time):"No snapshot data")}</div>
    <div class="repo-meta"><span>${repository.passwordProtected?"Password protected":"No password file"}</span><span>${repository.cacheConfigured?"Cache configured":"Default cache"}</span><span>${inventory?`Scanned ${relative(inventory.scannedAt)}`:"Inventory not run"}</span>${scan?`<span>Scan job ${esc(shortId(scan.id))} · ${esc(scan.state)}</span>`:""}</div>
    ${inventory?`<button class="repo-browser-toggle" data-toggle="${attr(repository.id)}"><span>${open?"Hide":"Browse"} snapshots</span><span>${open?"▴":"▾"}</span></button>`:""}
    ${open&&inventory?snapshotBrowser(repository):""}
  </section>`;
}

function snapshotBrowser(repository){
  const all=repository.inventory?.snapshots??[];
  const filter=(filters.get(repository.id)||"").toLowerCase();
  const snapshots=filter?all.filter(snapshot=>[snapshot.id,snapshot.shortId,snapshot.hostname,snapshot.username,...(snapshot.paths??[]),...(snapshot.tags??[])].some(value=>String(value||"").toLowerCase().includes(filter))):all;
  const activeWorkspace=workspace?.repositoryId===repository.id?restoreWorkspace(repository):"";
  return `<div class="snapshot-browser"><div class="snapshot-toolbar"><div><strong>Snapshot catalog</strong><span>${snapshots.length}${repository.inventory.truncated?` of ${repository.inventory.stats?.snapshotsCount??"many"}`:""} shown</span></div><input data-filter="${attr(repository.id)}" value="${attr(filters.get(repository.id)||"")}" placeholder="Filter tags, paths, host…"></div>
    ${snapshots.length?`<div class="table-wrap"><table class="snapshot-table"><thead><tr><th>Snapshot</th><th>Time</th><th>Source</th><th>Size</th><th>Tags</th><th></th></tr></thead><tbody>${snapshots.map(snapshot=>snapshotRow(snapshot,repository.id)).join("")}</tbody></table></div>`:`<div class="empty"><strong>No matching snapshots</strong>Adjust the filter to see other entries.</div>`}
    ${activeWorkspace}
  </div>`;
}

function snapshotRow(snapshot,repositoryId){
  const path=(snapshot.paths??[])[0]||"—";
  const more=Math.max(0,(snapshot.paths??[]).length-1);
  const tags=(snapshot.tags??[]).map(tag=>`<span class="snapshot-tag${String(tag).startsWith("nexus-plan:")?" plan":""}">${esc(displayTag(tag))}</span>`).join("")||'<span class="muted-2">—</span>';
  const selected=workspace?.repositoryId===repositoryId&&workspace?.snapshotId===snapshot.id;
  return `<tr class="${selected?"snapshot-selected":""}"><td><span class="cell-primary mono">${esc(snapshot.shortId||shortId(snapshot.id))}</span><span class="cell-sub mono snapshot-full-id">${esc(snapshot.id)}</span></td><td><span class="cell-primary">${esc(relative(snapshot.time))}</span><span class="cell-sub">${esc(date(snapshot.time))}</span></td><td><span class="cell-primary">${esc(path)}</span><span class="cell-sub">${esc(snapshot.hostname||"unknown host")}${more?` · +${more} path${more===1?"":"s"}`:""}</span></td><td>${snapshot.totalBytesProcessed!=null?bytes(snapshot.totalBytesProcessed):"—"}</td><td><div class="snapshot-tags">${tags}</div></td><td><button class="button ghost compact" data-open-snapshot="${attr(snapshot.id)}" data-open-repo="${attr(repositoryId)}">${selected?"Open":"Browse & preview"}</button></td></tr>`;
}

function restoreWorkspace(repository){
  const snapshot=repository.inventory?.snapshots?.find(item=>item.id===workspace.snapshotId);
  if(!snapshot)return"";
  const browse=workspace.browse;
  const data=browse?.browse;
  const active=browse?.activeJob;
  const last=browse?.lastJob;
  const entries=data?.entries??[];
  const targets=restoreTargets;
  const target=targets.find(item=>item.id===workspace.targetId)??targets[0];
  return `<section class="restore-workspace">
    <div class="restore-header"><div><p class="eyebrow">Snapshot content</p><h3>${esc(snapshot.shortId||shortId(snapshot.id))} · ${esc(date(snapshot.time))}</h3><p>Navigate the snapshot, select a safe local target and run a dry-run before any future restore.</p></div><div class="restore-safe"><strong>Dry-run only</strong><span>No files are written</span></div></div>
    <div class="restore-controls"><div class="restore-breadcrumbs">${breadcrumbs(workspace.path)}</div><div class="restore-target"><label><span>Preview target</span><select data-restore-target ${targets.length?"":"disabled"}>${targets.length?targets.map(item=>`<option value="${attr(item.id)}" ${item.id===target?.id?"selected":""}>${esc(item.label)} · ${esc(overwriteLabel(item.overwrite))}</option>`).join(""):'<option>No restore targets configured</option>'}</select></label><button class="button primary" data-preview-path="" ${targets.length?"":"disabled"}>Preview whole snapshot</button>${workspace.path!=="/"?`<button class="button ghost" data-preview-path="${attr(workspace.path)}" ${targets.length?"":"disabled"}>Preview current path</button>`:""}</div></div>
    ${browseLoading&&!browse?'<div class="restore-loading">Loading snapshot contents…</div>':active?`<div class="restore-loading">Reading snapshot directory… <span>${esc(active.state)}</span></div>`:last?.state==="failed"&&!data?`<div class="repo-error"><strong>Could not browse snapshot</strong><span>${esc(last.error||"Browse job failed.")}</span></div>`:data?browseEntries(entries,data):'<div class="restore-loading">Snapshot contents have not been loaded yet.</div>'}
    ${previewPanel()}
  </section>`;
}

function browseEntries(entries,data){
  return `<div class="restore-list-head"><span>${entries.length}${data.truncated?"+":""} entries</span>${data.truncated?'<span class="badge warn">List truncated</span>':""}</div>${entries.length?`<div class="table-wrap"><table class="restore-table"><thead><tr><th>Name</th><th>Type</th><th>Size</th><th>Modified</th><th></th></tr></thead><tbody>${entries.map(entry=>`<tr><td>${entry.nodeType==="dir"?`<button class="restore-path-link" data-browse-path="${attr(entry.path)}"><span class="restore-kind">▸</span>${esc(entry.name)}</button>`:`<span class="restore-file"><span class="restore-kind">·</span>${esc(entry.name)}</span>`}<span class="cell-sub mono">${esc(entry.path)}</span></td><td>${esc(entry.nodeType)}</td><td>${entry.size!=null?bytes(entry.size):"—"}</td><td>${entry.mtime?esc(date(entry.mtime)):"—"}</td><td><button class="button ghost compact" data-preview-path="${attr(entry.path)}" ${restoreTargets.length?"":"disabled"}>Preview</button></td></tr>`).join("")}</tbody></table></div>`:'<div class="empty"><strong>Empty directory</strong>No entries were returned for this path.</div>'}`;
}

function previewPanel(){
  const job=workspace?.previewJob;
  const runtime=workspace?.previewRuntime;
  if(!job&&!previewLoading)return"";
  if(previewLoading&&!job)return'<div class="preview-panel"><strong>Queueing restore preview…</strong></div>';
  const summary=runtime?.summary;
  const running=job&&!terminalStates.has(job.state);
  const failed=job?.state==="failed"||job?.state==="partial";
  const logs=(runtime?.logs??[]).filter(item=>item.stream==="stdout"||item.stream==="stderr");
  return `<div class="preview-panel ${failed?"failed":""}"><div class="preview-head"><div><p class="eyebrow">Restore preview</p><h4>${running?"Analyzing changes…":failed?"Preview failed":"Dry-run complete"}</h4></div><span class="badge ${running?"blue":failed?"danger":"success"}">${esc(job?.state||"queued")}</span></div>
    ${summary?`<div class="preview-metrics"><div><span>New</span><strong>${number(summary.restored??0)}</strong></div><div><span>Updated</span><strong>${number(summary.updated??0)}</strong></div><div><span>Unchanged</span><strong>${number(summary.unchanged??0)}</strong></div><div><span>Target</span><strong>${esc(summary.targetId||"local target")}</strong></div></div>`:""}
    ${job?.lastError?`<div class="repo-error"><strong>Preview error</strong><span>${esc(job.lastError)}</span></div>`:""}
    ${logs.length?`<div class="preview-log">${logs.slice(-120).map(item=>`<div class="${item.stream==="stderr"?"error":""}"><span>${esc(item.stream)}</span><code>${esc(item.message)}</code></div>`).join("")}</div>`:""}
    <div class="preview-lock"><strong>Actual restore remains locked.</strong><span>Authentication + explicit confirmation will be required before Nexus Backup can write restored files.</span></div></div>`;
}

function breadcrumbs(path){
  const parts=String(path||"/").split("/").filter(Boolean);
  let current="";
  const items=[`<button data-browse-path="/">/</button>`];
  for(const part of parts){current+=`/${part}`;items.push(`<span>›</span><button data-browse-path="${attr(current)}">${esc(part)}</button>`)}
  return items.join("");
}

function bind(){
  content.querySelectorAll("[data-scan]").forEach(button=>button.addEventListener("click",async event=>{
    event.stopPropagation();button.disabled=true;button.textContent="Queueing…";
    try{
      const result=await api(`/v1/local/repositories/${encodeURIComponent(button.dataset.scan)}/refresh`,{method:"POST"});
      toast(result.alreadyRunning?"Scan already active":"Inventory scan queued",button.dataset.scan);
      await load(true);
    }catch(error){toast("Could not scan repository",error.message,true)}
    finally{button.disabled=false;}
  }));
  content.querySelectorAll("[data-toggle]").forEach(button=>button.addEventListener("click",()=>{
    const id=button.dataset.toggle;if(expanded.has(id))expanded.delete(id);else expanded.add(id);render();
  }));
  content.querySelectorAll("[data-filter]").forEach(input=>input.addEventListener("input",()=>{
    filters.set(input.dataset.filter,input.value);const id=input.dataset.filter;expanded.add(id);render();
    requestAnimationFrame(()=>{const next=content.querySelector(`[data-filter="${cssEscape(id)}"]`);next?.focus();if(next)next.setSelectionRange(next.value.length,next.value.length)});
  }));
  content.querySelectorAll("[data-open-snapshot]").forEach(button=>button.addEventListener("click",()=>void openSnapshot(button.dataset.openRepo,button.dataset.openSnapshot)));
  content.querySelectorAll("[data-browse-path]").forEach(button=>button.addEventListener("click",()=>void browsePath(button.dataset.browsePath)));
  content.querySelector("[data-restore-target]")?.addEventListener("change",event=>{if(workspace)workspace.targetId=event.target.value;});
  content.querySelectorAll("[data-preview-path]").forEach(button=>button.addEventListener("click",()=>void startPreview(button.dataset.previewPath||null)));
}

async function openSnapshot(repositoryId,snapshotId){
  expanded.add(repositoryId);
  workspace={repositoryId,snapshotId,path:"/",targetId:restoreTargets[0]?.id??"",browse:null,previewJob:null,previewRuntime:null};
  render();
  await loadBrowse(false,true);
}

async function browsePath(path){
  if(!workspace)return;
  workspace.path=path||"/";workspace.browse=null;workspace.previewJob=null;workspace.previewRuntime=null;render();
  await loadBrowse(false,true);
}

async function loadBrowse(quiet=true,queueIfMissing=true){
  if(!workspace||browseLoading)return;
  browseLoading=true;
  const activeWorkspace=workspace;
  try{
    const base=`/v1/local/repositories/${encodeURIComponent(activeWorkspace.repositoryId)}/snapshots/${encodeURIComponent(activeWorkspace.snapshotId)}/browse`;
    let result=await api(`${base}?path=${encodeURIComponent(activeWorkspace.path)}`);
    if(workspace!==activeWorkspace)return;
    activeWorkspace.browse=result;
    if(!result.browse&&!result.activeJob&&queueIfMissing){
      await api(base,{method:"POST",body:{path:activeWorkspace.path}});
      result=await api(`${base}?path=${encodeURIComponent(activeWorkspace.path)}`);
      if(workspace===activeWorkspace)activeWorkspace.browse=result;
    }
    render();
  }catch(error){if(!quiet)toast("Could not browse snapshot",error.message,true)}
  finally{browseLoading=false;}
}

async function startPreview(path){
  if(!workspace||previewLoading)return;
  if(!workspace.targetId){toast("No restore target","Configure a restoreTargets entry in the local agent config first.",true);return}
  previewLoading=true;workspace.previewJob=null;workspace.previewRuntime=null;render();
  try{
    const result=await api(`/v1/local/repositories/${encodeURIComponent(workspace.repositoryId)}/snapshots/${encodeURIComponent(workspace.snapshotId)}/preview`,{method:"POST",body:{targetId:workspace.targetId,...(path?{path}:{})}});
    workspace.previewJob={id:result.job.id,state:result.job.state??"queued"};
    render();
    await loadPreview(true);
  }catch(error){toast("Could not start restore preview",error.message,true)}
  finally{previewLoading=false;render();}
}

async function loadPreview(quiet=true){
  if(!workspace?.previewJob?.id)return;
  const id=workspace.previewJob.id;
  try{
    const[job,runtime]=await Promise.all([api(`/v1/local/jobs/${encodeURIComponent(id)}`),api(`/v1/local/jobs/${encodeURIComponent(id)}/runtime?logs=200`)]);
    if(!workspace||workspace.previewJob?.id!==id)return;
    workspace.previewJob=job.job;workspace.previewRuntime=runtime;render();
  }catch(error){if(!quiet)toast("Could not refresh restore preview",error.message,true)}
}

async function api(path,options={}){const init={method:options.method||"GET",headers:{accept:"application/json"}};if(options.body!==undefined){init.headers["content-type"]="application/json";init.body=JSON.stringify(options.body)}const response=await fetch(path,init);const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.message||`${response.status} ${response.statusText}`);return data}
function metric(label,value,sub){return `<article class="metric-card"><span>${esc(label)}</span><strong>${esc(String(value))}</strong><small>${esc(sub)}</small></article>`}
function fact(label,value,sub){return `<div class="repo-fact"><span>${esc(label)}</span><strong>${esc(String(value))}</strong><small>${esc(sub)}</small></div>`}
function empty(){return `<section class="card card-pad"><div class="empty"><strong>No repositories configured</strong>Add a Restic repository to the local agent configuration first.</div></section>`}
function displayTag(tag){const value=String(tag);return value.startsWith("nexus-plan:")?`plan · ${value.slice(11,23)}`:value}
function overwriteLabel(value){return value==="always"?"overwrite always":value==="if-changed"?"overwrite changed":value==="if-newer"?"overwrite newer":"never overwrite"}
function bytes(value){const n=Number(value);if(!Number.isFinite(n))return"—";const units=["B","KiB","MiB","GiB","TiB","PiB"];let v=n,i=0;while(Math.abs(v)>=1024&&i<units.length-1){v/=1024;i++}return`${v>=100||i===0?v.toFixed(0):v>=10?v.toFixed(1):v.toFixed(2)} ${units[i]}`}
function number(value){return new Intl.NumberFormat().format(Number(value)||0)}
function relative(value){const ms=Date.now()-Date.parse(value);if(!Number.isFinite(ms))return"—";const future=ms<0,n=Math.abs(ms);let amount,unit;if(n<60000){amount=Math.max(1,Math.round(n/1000));unit="s"}else if(n<3600000){amount=Math.round(n/60000);unit="m"}else if(n<86400000){amount=Math.round(n/3600000);unit="h"}else{amount=Math.round(n/86400000);unit="d"}return future?`in ${amount}${unit}`:`${amount}${unit} ago`}
function date(value){const parsed=Date.parse(value);return Number.isFinite(parsed)?new Intl.DateTimeFormat(undefined,{dateStyle:"medium",timeStyle:"short"}).format(new Date(parsed)):"—"}
function shortId(value){return String(value||"").slice(0,8)}
function toast(title,message,error=false){if(!toastStack)return;const node=document.createElement("div");node.className=`toast${error?" error":""}`;node.innerHTML=`<strong>${esc(title)}</strong><span>${esc(message||"")}</span>`;toastStack.append(node);setTimeout(()=>node.remove(),5000)}
function esc(value){return String(value??"").replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[char]))}
function attr(value){return esc(value)}
function cssEscape(value){return globalThis.CSS?.escape?CSS.escape(String(value)):String(value).replace(/["\\]/g,"\\$&")}
