const content=document.querySelector("#content");
const title=document.querySelector("#page-title");
const eyebrow=document.querySelector("#page-eyebrow");
const refreshButton=document.querySelector("#refresh-button");
const toastStack=document.querySelector("#toast-stack");
let repositories=[];
let available=false;
let loading=false;
let expanded=new Set();
let filters=new Map();

window.addEventListener("hashchange",activate);
document.addEventListener("click",event=>{
  if(!isActive())return;
  const refresh=event.target.closest?.("#refresh-button");
  if(refresh)void load(false);
},true);
new MutationObserver(()=>{
  if(isActive()&&!content.querySelector("#repository-inventory-view"))queueMicrotask(render);
}).observe(content,{childList:true});
setInterval(()=>{if(isActive()&&repositories.some(repository=>repository.activeScan))void load(true)},3000);
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
    available=Boolean(response.available);
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
  const newest=repositories.flatMap(repository=>repository.inventory?.snapshots?.slice(0,1)??[]).sort((a,b)=>Date.parse(b.time)-Date.parse(a.time))[0];
  content.innerHTML=`<div id="repository-inventory-view">
    <div class="repo-hero"><div><p class="eyebrow">Restic inventory</p><h2>Repositories & snapshots</h2><p>Read-only catalog from the local agent. Passwords and repository environment secrets never enter the browser.</p></div><span class="badge success">Read-only</span></div>
    <div class="grid metrics">${metric("Repositories",repositories.length,`${scanned} scanned`)}${metric("Snapshots",snapshots,"Known from latest inventories")}${metric("Stored data",stored?bytes(stored):"—","Raw deduplicated repository data")}${metric("Newest snapshot",newest?relative(newest.time):"—",newest?date(newest.time):"No inventory yet")}</div>
    <div class="repo-stack section-gap">${repositories.map(repository=>repositoryCard(repository)).join("")||empty()}</div>
    <div class="repo-note"><strong>Inventory is intentionally read-only.</strong> Scans use <code>restic snapshots --json</code> and <code>restic stats --json --mode raw-data</code> through the bundled agent and the same per-repository lock as backup/prune. Restore actions come next.</div>
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
  return `<div class="snapshot-browser"><div class="snapshot-toolbar"><div><strong>Snapshot catalog</strong><span>${snapshots.length}${repository.inventory.truncated?` of ${repository.inventory.stats?.snapshotsCount??"many"}`:""} shown</span></div><input data-filter="${attr(repository.id)}" value="${attr(filters.get(repository.id)||"")}" placeholder="Filter tags, paths, host…"></div>
    ${snapshots.length?`<div class="table-wrap"><table class="snapshot-table"><thead><tr><th>Snapshot</th><th>Time</th><th>Source</th><th>Size</th><th>Added</th><th>Tags</th></tr></thead><tbody>${snapshots.map(snapshot=>snapshotRow(snapshot)).join("")}</tbody></table></div>`:`<div class="empty"><strong>No matching snapshots</strong>Adjust the filter to see other entries.</div>`}
  </div>`;
}

function snapshotRow(snapshot){
  const path=(snapshot.paths??[])[0]||"—";
  const more=Math.max(0,(snapshot.paths??[]).length-1);
  const tags=(snapshot.tags??[]).map(tag=>`<span class="snapshot-tag${String(tag).startsWith("nexus-plan:")?" plan":""}">${esc(displayTag(tag))}</span>`).join("")||'<span class="muted-2">—</span>';
  return `<tr><td><span class="cell-primary mono">${esc(snapshot.shortId||shortId(snapshot.id))}</span><span class="cell-sub mono snapshot-full-id">${esc(snapshot.id)}</span></td><td><span class="cell-primary">${esc(relative(snapshot.time))}</span><span class="cell-sub">${esc(date(snapshot.time))}</span></td><td><span class="cell-primary">${esc(path)}</span><span class="cell-sub">${esc(snapshot.hostname||"unknown host")}${more?` · +${more} path${more===1?"":"s"}`:""}</span></td><td>${snapshot.totalBytesProcessed!=null?bytes(snapshot.totalBytesProcessed):"—"}</td><td>${snapshot.dataAddedPacked!=null?bytes(snapshot.dataAddedPacked):snapshot.dataAdded!=null?bytes(snapshot.dataAdded):"—"}</td><td><div class="snapshot-tags">${tags}</div></td></tr>`;
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
    filters.set(input.dataset.filter,input.value);
    const id=input.dataset.filter;expanded.add(id);render();
    requestAnimationFrame(()=>{const next=content.querySelector(`[data-filter="${cssEscape(id)}"]`);next?.focus();if(next)next.setSelectionRange(next.value.length,next.value.length)});
  }));
}

async function api(path,options={}){const init={method:options.method||"GET",headers:{accept:"application/json"}};if(options.body!==undefined){init.headers["content-type"]="application/json";init.body=JSON.stringify(options.body)}const response=await fetch(path,init);const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.message||`${response.status} ${response.statusText}`);return data}
function metric(label,value,sub){return `<article class="metric-card"><span>${esc(label)}</span><strong>${esc(String(value))}</strong><small>${esc(sub)}</small></article>`}
function fact(label,value,sub){return `<div class="repo-fact"><span>${esc(label)}</span><strong>${esc(String(value))}</strong><small>${esc(sub)}</small></div>`}
function empty(){return `<section class="card card-pad"><div class="empty"><strong>No repositories configured</strong>Add a Restic repository to the local agent configuration first.</div></section>`}
function displayTag(tag){const value=String(tag);return value.startsWith("nexus-plan:")?`plan · ${value.slice(11,23)}`:value}
function bytes(value){const n=Number(value);if(!Number.isFinite(n))return"—";const units=["B","KiB","MiB","GiB","TiB","PiB"];let v=n,i=0;while(Math.abs(v)>=1024&&i<units.length-1){v/=1024;i++}return`${v>=100||i===0?v.toFixed(0):v>=10?v.toFixed(1):v.toFixed(2)} ${units[i]}`}
function number(value){return new Intl.NumberFormat().format(Number(value)||0)}
function relative(value){const ms=Date.now()-Date.parse(value);if(!Number.isFinite(ms))return"—";const future=ms<0,n=Math.abs(ms);let amount,unit;if(n<60000){amount=Math.max(1,Math.round(n/1000));unit="s"}else if(n<3600000){amount=Math.round(n/60000);unit="m"}else if(n<86400000){amount=Math.round(n/3600000);unit="h"}else{amount=Math.round(n/86400000);unit="d"}return future?`in ${amount}${unit}`:`${amount}${unit} ago`}
function date(value){const parsed=Date.parse(value);return Number.isFinite(parsed)?new Intl.DateTimeFormat(undefined,{dateStyle:"medium",timeStyle:"short"}).format(new Date(parsed)):"—"}
function shortId(value){return String(value||"").slice(0,8)}
function toast(title,message,error=false){if(!toastStack)return;const node=document.createElement("div");node.className=`toast${error?" error":""}`;node.innerHTML=`<strong>${esc(title)}</strong><span>${esc(message||"")}</span>`;toastStack.append(node);setTimeout(()=>node.remove(),5000)}
function esc(value){return String(value??"").replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[char]))}
function attr(value){return esc(value)}
function cssEscape(value){return globalThis.CSS?.escape?CSS.escape(String(value)):String(value).replace(/["\\]/g,"\\$&")}
