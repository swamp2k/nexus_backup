const nav=document.querySelector("#transfers-nav");
const content=document.querySelector("#content");
const title=document.querySelector("#page-title");
const eyebrow=document.querySelector("#page-eyebrow");
const newButton=document.querySelector("#new-job-button");
const refreshButton=document.querySelector("#refresh-button");
const toastStack=document.querySelector("#toast-stack");
const ACTIVE=new Set(["queued","leased","preparing","running","finalizing"]);
let rules=[];
let endpoints=[];
let repositories=[];
let available=false;
let loading=false;
let editing=null;
let modal=null;
let form=null;
let expanded=new Set();
let objectCache=new Map();
let objectLoading=new Set();

nav?.addEventListener("click",()=>{location.hash="transfers";activate()});
window.addEventListener("hashchange",activate);
document.addEventListener("click",event=>{
  if(!isActive())return;
  if(event.target.closest?.("#new-job-button")){event.preventDefault();event.stopImmediatePropagation();openEditor();}
  if(event.target.closest?.("#refresh-button")){event.preventDefault();event.stopImmediatePropagation();void refresh();}
},true);
document.addEventListener("keydown",event=>{if(event.key==="Escape")closeEditor()});
new MutationObserver(()=>{if(isActive()&&!content.querySelector("#transfers-view"))queueMicrotask(render)}).observe(content,{childList:true});
setInterval(()=>{if(isActive())void refresh(true)},3000);
activate();

function isActive(){return(location.hash.replace(/^#/,"")||"overview")==="transfers"}
function activate(){
  if(!isActive()){
    nav?.classList.remove("active");
    if(newButton)newButton.textContent="New job";
    if(eyebrow)eyebrow.textContent="Nexus Backup";
    closeEditor();
    return;
  }
  document.querySelectorAll("[data-view]").forEach(item=>item.classList.remove("active"));
  nav?.classList.add("active");
  if(title)title.textContent="Transfers";
  if(eyebrow)eyebrow.textContent="Copyarr engine";
  if(newButton){newButton.hidden=false;newButton.textContent="New transfer rule";}
  render();
  void refresh(rules.length>0);
}

async function refresh(quiet=false){
  if(loading)return;loading=true;
  if(!quiet&&isActive())refreshButton.textContent="Refreshing…";
  try{
    const [result,repositoryResult]=await Promise.all([api("/v1/local/transfers"),api("/v1/local/repositories")]);
    rules=result.rules??[];endpoints=result.endpoints??[];repositories=repositoryResult.repositories??[];available=Boolean(result.available);
    render();
    for(const id of expanded)void loadObjects(id,true);
  }catch(error){if(!quiet)toast("Transfers refresh failed",error.message,true)}
  finally{loading=false;if(!quiet&&isActive())refreshButton.textContent="Refresh";}
}

function render(){
  if(!isActive())return;
  document.querySelectorAll("[data-view]").forEach(item=>item.classList.remove("active"));
  nav?.classList.add("active");
  if(title)title.textContent="Transfers";
  if(eyebrow)eyebrow.textContent="Copyarr engine";
  if(newButton){newButton.hidden=false;newButton.textContent="New transfer rule";}
  const enabled=rules.filter(rule=>rule.enabled).length;
  const waiting=rules.reduce((sum,rule)=>sum+count(rule,"discovered")+count(rule,"retry_wait"),0);
  const active=rules.reduce((sum,rule)=>sum+count(rule,"queued"),0);
  const failed=rules.reduce((sum,rule)=>sum+count(rule,"failed"),0);
  content.innerHTML=`<div id="transfers-view">
    <div class="transfer-hero"><div><p class="eyebrow">Persistent transfer automation</p><h2>Transfer rules</h2><p>Discover new objects, wait until they are stable, stage and verify them, then commit to the destination. State survives restarts.</p></div><span class="badge success">Copyarr recipe</span></div>
    <div class="grid metrics">${metric("Enabled",enabled,`${rules.length} rules`)}${metric("Waiting",waiting,"Stable/discovery queue",waiting?"warn":"")}${metric("Active",active,"Queued or transferring",active?"blue":"")}${metric("Failed",failed,failed?"Needs attention":"No failed objects",failed?"danger":"")}</div>
    <div class="transfer-stack section-gap">${rules.map(ruleCard).join("")||empty()}</div>
    <div class="transfer-note"><strong>Transfer safety boundary:</strong> staging + exact-size verification + commit is active. Move deletes only the exact source files after final verification. Cleanup-days are stored as policy; optional rTorrent readiness gates can hold incomplete torrent files until completion.</div>
  </div>`;
  bindActions();
}

function ruleCard(rule){
  const open=expanded.has(rule.id);
  const scanActive=rule.lastScanJob&&ACTIVE.has(rule.lastScanJob.state);
  const source=`${rule.sourceEndpointId}${rule.sourcePath?`/${rule.sourcePath}`:""}`;
  const destination=rule.destinationRepositoryId?`${repositories.find(repo=>repo.id===rule.destinationRepositoryId)?.name||rule.destinationRepositoryId}${rule.destinationPath?`/${rule.destinationPath}`:""}`:`${rule.destinationEndpointId}${rule.destinationPath?`/${rule.destinationPath}`:""}`;
  const total=count(rule,"done")+count(rule,"discovered")+count(rule,"ignored")+count(rule,"queued")+count(rule,"retry_wait")+count(rule,"failed")+count(rule,"cancelled")+count(rule,"superseded");
  return `<section class="card transfer-card" data-rule="${attr(rule.id)}">
    <div class="transfer-head"><div class="transfer-title"><span class="transfer-state${rule.enabled?"":" paused"}"></span><div><h2>${esc(rule.name)}</h2><span>${esc(rule.mode.toUpperCase())} · ${rule.enabled?"Enabled":"Paused"}</span></div></div><div class="transfer-actions"><span class="badge ${scanActive?"blue":rule.lastError?"danger":rule.initializedAt?"success":"warn"}">${scanActive?"Scanning":rule.lastError?"Scan failed":rule.initializedAt?"Watching":"Not initialized"}</span><button class="button ghost compact" data-action="scan" data-id="${attr(rule.id)}" ${scanActive||!rule.enabled?"disabled":""}>${scanActive?"Scanning…":"Scan now"}</button><button class="button ghost compact" data-action="edit" data-id="${attr(rule.id)}">Edit</button><button class="button ghost compact" data-action="toggle" data-id="${attr(rule.id)}">${rule.enabled?"Pause":"Enable"}</button></div></div>
    <div class="transfer-route"><div><span>Source</span><strong>${esc(source)}</strong></div><span class="transfer-arrow">→</span><div><span>Destination</span><strong>${esc(destination)}</strong></div></div>
    ${rule.lastError?`<div class="repo-error"><strong>Last scan failed</strong><span>${esc(rule.lastError)}</span></div>`:""}
    <div class="transfer-facts">${fact("Discovered",count(rule,"discovered"),bytesLabel(bytesFor(rule,"discovered")))}${fact("Queued",count(rule,"queued"),bytesLabel(bytesFor(rule,"queued")))}${fact("Done",count(rule,"done"),bytesLabel(bytesFor(rule,"done")))}${fact("Failed",count(rule,"failed"),bytesLabel(bytesFor(rule,"failed")),count(rule,"failed")?"danger":"")}</div>
    <div class="transfer-meta"><span>Scan ${duration(rule.scanIntervalSeconds)}</span><span>Stable ${duration(rule.stabilitySeconds)}</span><span>${rule.initialBehavior==="ignore_existing"?"Ignore existing on first scan":"Process existing"}</span><span>Retry ${rule.retryCount} × ${duration(rule.retryWaitSeconds)}</span><span>MT ${rule.multiThreadStreams} × ${esc(rule.multiThreadCutoff)}</span><span>Size verify</span><span>Cleanup ${rule.cleanupDays?`${rule.cleanupDays}d policy-only`:"off"}</span></div>
    <div class="transfer-meta filters"><span>Include: ${rule.includes.length?esc(rule.includes.join(", ")):"all"}</span><span>Exclude: ${rule.excludes.length?esc(rule.excludes.join(", ")):"none"}</span><span>${rule.rcloneArgs?.length?`Extra rclone: ${esc(rule.rcloneArgs.join(" "))}`:"No extra rclone args"}</span><span>${rule.lastScanCompletedAt?`Last scan ${relative(rule.lastScanCompletedAt)}`:"Never scanned"}</span><span>${total} tracked generations</span></div>
    <button class="transfer-toggle" data-action="objects" data-id="${attr(rule.id)}"><span>${open?"Hide":"Show"} recent objects</span><span>${open?"▴":"▾"}</span></button>
    ${open?objectsPanel(rule):""}
  </section>`;
}

function objectsPanel(rule){
  if(objectLoading.has(rule.id)&&!objectCache.has(rule.id))return'<div class="transfer-objects-loading">Loading objects…</div>';
  const objects=objectCache.get(rule.id)??[];
  if(!objects.length)return'<div class="empty compact-empty"><strong>No tracked objects yet</strong>Run a scan to initialize this rule.</div>';
  return `<div class="transfer-objects"><div class="transfer-objects-head"><strong>Recent objects</strong><span>${objects.length} shown</span></div><div class="table-wrap"><table><thead><tr><th>Object</th><th>State</th><th>Size</th><th>Seen / committed</th><th>Progress</th></tr></thead><tbody>${objects.map(objectRow).join("")}</tbody></table></div></div>`;
}

function objectRow(object){
  const progress=object.job?.progress;
  const pct=progress?.bytesTotal>0?Math.max(0,Math.min(100,progress.bytesDone/progress.bytesTotal*100)):null;
  const detail=object.state==="retry_wait"&&object.nextRetryAt?`Retry ${future(object.nextRetryAt)}`:object.error||object.job?.error||"";
  return `<tr><td><span class="cell-primary">${esc(object.path)}</span><span class="cell-sub mono">${esc(object.objectKey.slice(0,12))}</span></td><td><span class="transfer-object-state ${attr(object.state)}">${esc(stateLabel(object.state))}</span>${detail?`<span class="cell-sub">${esc(detail)}</span>`:""}</td><td>${bytesLabel(object.size)}</td><td><span class="cell-primary">${object.committedAt?`Committed ${relative(object.committedAt)}`:`Seen ${relative(object.lastSeenAt)}`}</span><span class="cell-sub">${esc(date(object.modTime))}</span></td><td>${pct!==null?`<div class="object-progress"><div><span style="width:${pct.toFixed(1)}%"></span></div><small>${pct.toFixed(0)}% · ${bytesLabel(progress.speedBytesPerSecond||0)}/s${progress.etaSeconds!=null?` · ${duration(progress.etaSeconds)}`:""}</small></div>`:object.job?`<span class="cell-primary">${esc(object.job.state||object.state)}</span><span class="cell-sub">attempt ${object.attemptCount}</span>`:'<span class="muted-2">—</span>'}</td></tr>`;
}

function bindActions(){
  content.querySelectorAll("[data-action]").forEach(button=>button.addEventListener("click",async event=>{
    event.stopPropagation();const rule=rules.find(item=>item.id===button.dataset.id);if(!rule)return;
    const action=button.dataset.action;
    if(action==="edit"){openEditor(rule);return;}
    if(action==="objects"){
      if(expanded.has(rule.id)){expanded.delete(rule.id);render();return;}
      expanded.add(rule.id);render();await loadObjects(rule.id,false);return;
    }
    button.disabled=true;
    try{
      if(action==="toggle"){
        await api(`/v1/local/transfers/${encodeURIComponent(rule.id)}`,{method:"PATCH",body:{enabled:!rule.enabled}});
        toast(rule.enabled?"Transfer paused":"Transfer enabled",rule.name);
      }else if(action==="scan"){
        button.textContent="Queueing…";
        const result=await api(`/v1/local/transfers/${encodeURIComponent(rule.id)}/scan`,{method:"POST"});
        toast(result.alreadyRunning?"Scan already active":"Scan queued",rule.name);
      }
      await refresh(true);
    }catch(error){toast("Transfer action failed",error.message,true)}finally{button.disabled=false;}
  }));
}

async function loadObjects(ruleId,quiet=true){
  if(objectLoading.has(ruleId))return;objectLoading.add(ruleId);render();
  try{const result=await api(`/v1/local/transfers/${encodeURIComponent(ruleId)}/objects?limit=120`);objectCache.set(ruleId,result.objects??[]);render();}
  catch(error){if(!quiet)toast("Could not load transfer objects",error.message,true)}
  finally{objectLoading.delete(ruleId);render();}
}

function openEditor(rule=null){
  if(!available){toast("Local configuration unavailable","Wait for the local configuration before creating a transfer rule.",true);return;}
  ensureModal();ensureDestinationRepositoryField();editing=rule;modal.classList.remove("hidden");
  modal.querySelector("#transfer-modal-title").textContent=rule?"Edit transfer rule":"New transfer rule";
  field("name").value=rule?.name||"";
  field("sourceEndpointId").value=rule?.sourceEndpointId||endpoints[0]?.id||"";
  field("sourcePath").value=rule?.sourcePath||"";
  field("destinationEndpointId").value=rule?.destinationRepositoryId?endpoints[0]?.id||"":rule?.destinationEndpointId||endpoints[1]?.id||endpoints[0]?.id||"";
  field("destinationPath").value=rule?.destinationPath||"";
  field("destinationRepositoryId").value=rule?.destinationRepositoryId||"";
  field("mode").value=rule?.mode||"copy";
  field("initialBehavior").value=rule?.initialBehavior||"ignore_existing";
  field("stabilitySeconds").value=rule?.stabilitySeconds??600;
  field("scanIntervalSeconds").value=rule?.scanIntervalSeconds??300;
  field("cleanupDays").value=rule?.cleanupDays??14;
  field("retryCount").value=rule?.retryCount??3;
  field("retryWaitSeconds").value=rule?.retryWaitSeconds??300;
  field("multiThreadStreams").value=rule?.multiThreadStreams??4;
  field("multiThreadCutoff").value=rule?.multiThreadCutoff??"256M";
  field("rcloneArgs").value=(rule?.rcloneArgs??[]).join("\n");
  field("includes").value=(rule?.includes??[]).join("\n");
  field("excludes").value=(rule?.excludes??[]).join("\n");
  field("enabled").checked=rule?.enabled??true;
  updateMoveHint();
}
function closeEditor(){modal?.classList.add("hidden");editing=null;}

function ensureDestinationRepositoryField(){
  if(form.elements.namedItem("destinationRepositoryId"))return;
  const endpoint=field("destinationEndpointId");
  const label=document.createElement("label");
  label.innerHTML=`<span>Destination repository <small>optional</small></span><select name="destinationRepositoryId"><option value="">Use endpoint</option>${repositories.map(repo=>`<option value="${attr(repo.id)}">${esc(repo.name)}</option>`).join("")}</select>`;
  endpoint.closest("label")?.after(label);
}

function ensureModal(){
  if(modal)return;
  const shell=document.createElement("div");
  shell.innerHTML=`<div class="modal-backdrop hidden" id="transfer-modal"><section class="modal transfer-modal" role="dialog" aria-modal="true" aria-labelledby="transfer-modal-title"><div class="modal-header"><div><p class="eyebrow">Copyarr engine</p><h2 id="transfer-modal-title">New transfer rule</h2></div><button class="icon-button" type="button" data-close>×</button></div><form id="transfer-form"><p class="transfer-modal-copy">Rules reference configured rclone endpoints by ID. Existing files can be ignored on bootstrap so only new generations are automated.</p><div class="transfer-form-grid"><label class="full"><span>Name</span><input name="name" maxlength="120" required placeholder="Seedbox → downloads"></label><label><span>Source endpoint</span><select name="sourceEndpointId" required>${endpointOptions()}</select></label><label><span>Source subpath</span><input name="sourcePath" placeholder="rtorrent/complete"></label><label><span>Destination endpoint</span><select name="destinationEndpointId" required>${endpointOptions()}</select></label><label><span>Destination subpath</span><input name="destinationPath" placeholder="downloads"></label><label><span>Mode</span><select name="mode"><option value="copy">Copy</option><option value="move">Move after verified commit</option></select><small id="move-hint"></small></label><label><span>First scan</span><select name="initialBehavior"><option value="ignore_existing">Ignore existing</option><option value="process_existing">Process existing</option></select></label><label><span>Scan every (seconds)</span><input name="scanIntervalSeconds" type="number" min="15" max="86400" required></label><label><span>Stable for (seconds)</span><input name="stabilitySeconds" type="number" min="0" max="604800" required></label><label><span>Retry count</span><input name="retryCount" type="number" min="0" max="20" required></label><label><span>Retry wait (seconds)</span><input name="retryWaitSeconds" type="number" min="0" max="86400" required></label><label><span>Multi-thread streams</span><input name="multiThreadStreams" type="number" min="1" max="32" required></label><label><span>Multi-thread cutoff</span><input name="multiThreadCutoff" maxlength="32" required placeholder="256M"></label><label><span>Cleanup days <small>policy only</small></span><input name="cleanupDays" type="number" min="0" max="3650" required></label><label class="full"><span>Extra rclone args <small>one argument per line; safety-critical flags are blocked</small></span><textarea name="rcloneArgs" rows="3" placeholder="--bwlimit\n50M"></textarea></label><label class="full"><span>Include patterns <small>one per line or comma; includes win</small></span><textarea name="includes" rows="3" placeholder="*.mkv\nshows/**"></textarea></label><label class="full"><span>Exclude patterns</span><textarea name="excludes" rows="3" placeholder="*.part\n**/sample/**"></textarea></label><label class="enabled-row full"><input type="checkbox" name="enabled"><span>Enabled</span></label></div><div class="modal-actions"><button type="button" class="button ghost" data-close>Cancel</button><button type="submit" class="button primary">Save rule</button></div></form></section></div>`;
  modal=shell.firstElementChild;document.body.append(modal);form=modal.querySelector("#transfer-form");
  modal.querySelectorAll("[data-close]").forEach(button=>button.addEventListener("click",closeEditor));
  modal.addEventListener("click",event=>{if(event.target===modal)closeEditor()});
  field("sourceEndpointId").addEventListener("change",updateMoveHint);
  form.addEventListener("submit",event=>void save(event));
}

async function save(event){
  event.preventDefault();const button=form.querySelector('button[type="submit"]');button.disabled=true;button.textContent="Saving…";
  try{
    const data=new FormData(form);
    const payload={
      name:String(data.get("name")),enabled:field("enabled").checked,
      sourceEndpointId:String(data.get("sourceEndpointId")),sourcePath:String(data.get("sourcePath")||""),
      destinationEndpointId:String(data.get("destinationEndpointId")),destinationPath:String(data.get("destinationPath")||""),
      mode:String(data.get("mode")),initialBehavior:String(data.get("initialBehavior")),
      stabilitySeconds:Number(data.get("stabilitySeconds")),scanIntervalSeconds:Number(data.get("scanIntervalSeconds")),cleanupDays:Number(data.get("cleanupDays")),verification:"size",
      multiThreadStreams:Number(data.get("multiThreadStreams")),multiThreadCutoff:String(data.get("multiThreadCutoff")||"256M"),
      retryCount:Number(data.get("retryCount")),retryWaitSeconds:Number(data.get("retryWaitSeconds")),
      rcloneArgs:lines(data.get("rcloneArgs")),includes:patterns(data.get("includes")),excludes:patterns(data.get("excludes")),
    };
    payload.destinationRepositoryId=String(data.get("destinationRepositoryId")||"")||null;
    if(payload.destinationRepositoryId)payload.destinationEndpointId="repository";
    if(editing)await api(`/v1/local/transfers/${encodeURIComponent(editing.id)}`,{method:"PUT",body:payload});else await api("/v1/local/transfers",{method:"POST",body:payload});
    toast(editing?"Transfer rule updated":"Transfer rule created",payload.name);closeEditor();await refresh(true);
  }catch(error){toast("Could not save transfer rule",error.message,true)}finally{button.disabled=false;button.textContent="Save rule";}
}

function updateMoveHint(){if(!form)return;const source=endpoints.find(item=>item.id===field("sourceEndpointId").value),hint=form.querySelector("#move-hint");hint.textContent=source?.allowMove?"Source allows verified move.":"Move is blocked for this source until allowMove:true is configured locally.";const option=field("mode").querySelector('option[value="move"]');if(option)option.disabled=!source?.allowMove;if(!source?.allowMove&&field("mode").value==="move")field("mode").value="copy";}
function endpointOptions(){return endpoints.map(endpoint=>`<option value="${attr(endpoint.id)}">${esc(endpoint.id)} · ${esc(endpoint.fs||"endpoint")}</option>`).join("")||'<option value="">No endpoints configured</option>'}
function patterns(value){return String(value||"").split(/[\n,]+/).map(item=>item.trim()).filter(Boolean)}
function lines(value){return String(value||"").split(/\n+/).map(item=>item.trim()).filter(Boolean)}
function field(name){return form.elements.namedItem(name)}
function count(rule,state){return Number(rule.counts?.[state]?.count??0)}
function bytesFor(rule,state){return Number(rule.counts?.[state]?.bytes??0)}
function metric(label,value,sub,tone=""){return `<article class="metric-card ${tone}"><span>${esc(label)}</span><strong>${esc(String(value))}</strong><small>${esc(sub)}</small></article>`}
function fact(label,value,sub,tone=""){return `<div class="transfer-fact ${tone}"><span>${esc(label)}</span><strong>${esc(String(value))}</strong><small>${esc(sub)}</small></div>`}
function empty(){return `<section class="card card-pad"><div class="empty"><strong>No transfer rules yet</strong>Create a rule to start watching an rclone source.</div></section>`}
function stateLabel(value){return({retry_wait:"retry wait",superseded:"superseded",discovered:"waiting"}[value]||value).replaceAll("_"," ")}
function duration(seconds){const n=Number(seconds)||0;if(n<60)return`${n}s`;if(n<3600)return`${Math.round(n/60)}m`;if(n<86400)return`${Math.round(n/3600)}h`;return`${Math.round(n/86400)}d`}
function bytesLabel(value){const n=Number(value);if(!Number.isFinite(n))return"—";const units=["B","KiB","MiB","GiB","TiB","PiB"];let v=n,i=0;while(Math.abs(v)>=1024&&i<units.length-1){v/=1024;i++}return`${v>=100||i===0?v.toFixed(0):v>=10?v.toFixed(1):v.toFixed(2)} ${units[i]}`}
function relative(value){const ms=Date.now()-Date.parse(value);if(!Number.isFinite(ms))return"—";const f=ms<0,n=Math.abs(ms);let a,u;if(n<60000){a=Math.max(1,Math.round(n/1000));u="s"}else if(n<3600000){a=Math.round(n/60000);u="m"}else if(n<86400000){a=Math.round(n/3600000);u="h"}else{a=Math.round(n/86400000);u="d"}return f?`in ${a}${u}`:`${a}${u} ago`}
function future(value){const ms=Date.parse(value)-Date.now();return ms<=0?"now":`in ${duration(Math.max(1,Math.round(ms/1000)))}`}
function date(value){const parsed=Date.parse(value);return Number.isFinite(parsed)?new Intl.DateTimeFormat(undefined,{dateStyle:"medium",timeStyle:"short"}).format(new Date(parsed)):"—"}
function toast(head,message,error=false){if(!toastStack)return;const node=document.createElement("div");node.className=`toast${error?" error":""}`;node.innerHTML=`<strong>${esc(head)}</strong><span>${esc(message||"")}</span>`;toastStack.append(node);setTimeout(()=>node.remove(),5000)}
async function api(path,options={}){const init={method:options.method||"GET",headers:{accept:"application/json"}};if(options.body!==undefined){init.headers["content-type"]="application/json";init.body=JSON.stringify(options.body)}const response=await fetch(path,init);const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.message||`${response.status} ${response.statusText}`);return data}
function esc(value){return String(value??"").replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[char]))}
function attr(value){return esc(value)}
