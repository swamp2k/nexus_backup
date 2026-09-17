const nav=document.querySelector("#plans-nav");
const content=document.querySelector("#content");
const title=document.querySelector("#page-title");
const eyebrow=document.querySelector("#page-eyebrow");
const newButton=document.querySelector("#new-job-button");
const refreshButton=document.querySelector("#refresh-button");
const toastStack=document.querySelector("#toast-stack");
const DAYS=[[1,"Mon"],[2,"Tue"],[3,"Wed"],[4,"Thu"],[5,"Fri"],[6,"Sat"],[0,"Sun"]];
const ACTIVE=new Set(["queued","leased","preparing","running","finalizing"]);
let plans=[];
let config={available:false,sources:[],repositories:[],endpoints:[]};
let loading=false;
let editing=null;
let modal=null;
let form=null;

nav?.addEventListener("click",()=>{location.hash="plans";activate()});
window.addEventListener("hashchange",activate);
document.addEventListener("click",event=>{
  if(!isActive())return;
  if(event.target.closest?.("#new-job-button")){event.preventDefault();event.stopImmediatePropagation();openEditor();}
  if(event.target.closest?.("#refresh-button")){event.preventDefault();event.stopImmediatePropagation();void refresh();}
},true);
document.addEventListener("keydown",event=>{if(event.key==="Escape")closeEditor()});
new MutationObserver(()=>{if(isActive()&&!content.querySelector("#plans-view"))queueMicrotask(render)}).observe(content,{childList:true});
setInterval(()=>{if(isActive())void refresh(true)},5000);
activate();

function isActive(){return (location.hash.replace(/^#/,"")||"overview")==="plans"}
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
  if(title)title.textContent="Backup Plans";
  if(eyebrow)eyebrow.textContent="Automation";
  if(newButton){newButton.hidden=false;newButton.textContent="New plan";}
  render();
  void refresh(plans.length>0);
}

async function refresh(quiet=false){
  if(loading)return;
  loading=true;
  if(!quiet&&isActive())refreshButton.textContent="Refreshing…";
  try{
    const[p,c]=await Promise.all([api("/v1/local/plans"),api("/v1/local/config")]);
    plans=p.plans??[];config=c;
    render();
  }catch(error){if(!quiet)toast("Plans refresh failed",error.message,true)}
  finally{loading=false;if(!quiet&&isActive())refreshButton.textContent="Refresh"}
}

function render(){
  if(!isActive())return;
  document.querySelectorAll("[data-view]").forEach(item=>item.classList.remove("active"));
  nav?.classList.add("active");
  if(title)title.textContent="Backup Plans";
  if(eyebrow)eyebrow.textContent="Automation";
  if(newButton){newButton.hidden=false;newButton.textContent="New plan";}
  const enabled=plans.filter(p=>p.enabled).length;
  const running=plans.filter(p=>p.lastJob&&ACTIVE.has(p.lastJob.state)).length;
  const attention=plans.filter(p=>["failed","partial"].includes(p.lastJob?.state)).length;
  const next=plans.filter(p=>p.enabled&&p.nextRunAt).sort((a,b)=>Date.parse(a.nextRunAt)-Date.parse(b.nextRunAt))[0];
  content.innerHTML=`<div id="plans-view">
    <div class="plans-hero"><div><p class="eyebrow">Local scheduler</p><h2>Backup plans</h2><p>Recurring jobs run entirely inside the self-contained Nexus Backup stack. Schedules follow the plan timezone, including daylight-saving changes.</p></div><span class="badge success">15s scheduler</span></div>
    <div class="grid metrics">${metric("Enabled",enabled,`${plans.length} total`)}${metric("Running",running,running?"Scheduled work active":"Nothing active",running?"blue":"")}${metric("Attention",attention,attention?"Failed or partial last run":"Last results healthy",attention?"danger":"")}${metric("Next run",next?shortFuture(next.nextRunAt):"—",next?.name||"No enabled plans",next&&Date.parse(next.nextRunAt)-Date.now()<3600000?"warn":"")}</div>
    <section class="card section-gap"><div class="card-header"><div><h2>Schedules</h2><p>Daily and weekly local-time plans</p></div><span class="muted small">${plans.length} configured</span></div>${table()}</section>
    <div class="plans-note"><strong>Retention is policy-only for now.</strong> Restic keep-daily/weekly/monthly values are stored with each plan, but <code>forget/prune</code> will be a separate maintenance job with repository locking and explicit safety gates.</div>
  </div>`;
  bindActions();
}

function table(){
  if(!plans.length)return `<div class="empty"><strong>No backup plans yet</strong>Create your first recurring backup with “New plan”.</div>`;
  return `<div class="table-wrap"><table><thead><tr><th>Plan</th><th>Schedule</th><th>Next run</th><th>Last result</th><th>Retention</th><th></th></tr></thead><tbody>${plans.map(p=>`<tr>
    <td><div class="plan-name"><span class="plan-state-dot${p.enabled?"":" paused"}"></span><div><span class="cell-primary">${esc(p.name)}</span><span class="cell-sub">${esc(typeLabel(p.jobType))} · ${p.enabled?"Enabled":"Paused"}</span></div></div></td>
    <td>${scheduleCell(p)}</td>
    <td>${p.enabled&&p.nextRunAt?`<span class="cell-primary">${esc(future(p.nextRunAt))}</span><span class="cell-sub">${esc(dateInZone(p.nextRunAt,p.timezone))}</span>`:'<span class="muted-2">Paused</span>'}</td>
    <td>${lastCell(p)}</td><td>${retentionCell(p)}</td>
    <td><div class="plan-actions"><button class="button ghost" data-action="run" data-id="${attr(p.id)}">Run now</button><button class="button ghost" data-action="edit" data-id="${attr(p.id)}">Edit</button><button class="button ghost" data-action="toggle" data-id="${attr(p.id)}">${p.enabled?"Pause":"Enable"}</button></div></td>
  </tr>`).join("")}</tbody></table></div>`;
}

function bindActions(){
  content.querySelectorAll("[data-action]").forEach(button=>button.addEventListener("click",async event=>{
    event.stopPropagation();
    const plan=plans.find(p=>p.id===button.dataset.id);if(!plan)return;
    if(button.dataset.action==="edit"){openEditor(plan);return;}
    button.disabled=true;
    try{
      if(button.dataset.action==="toggle"){
        await api(`/v1/local/plans/${encodeURIComponent(plan.id)}`,{method:"PATCH",body:{enabled:!plan.enabled}});
        toast(plan.enabled?"Plan paused":"Plan enabled",plan.name);
      }else{
        button.textContent="Queueing…";
        const result=await api(`/v1/local/plans/${encodeURIComponent(plan.id)}/run`,{method:"POST"});
        toast("Backup queued",`${plan.name} · ${result.job?.id??"job created"}`);
      }
      await refresh(true);
    }catch(error){toast("Plan action failed",error.message,true)}
    finally{button.disabled=false;if(button.dataset.action==="run")button.textContent="Run now";}
  }));
}

function openEditor(plan=null){
  if(!config.available){toast("Agent config unavailable","Wait for the local agent configuration before creating a plan.",true);return;}
  ensureModal();editing=plan;
  modal.classList.remove("hidden");
  modal.querySelector("#plan-modal-title").textContent=plan?"Edit backup plan":"New backup plan";
  field("name").value=plan?.name||"";
  field("jobType").value="rclone-transfer";
  field("timezone").value=plan?.timezone||Intl.DateTimeFormat().resolvedOptions().timeZone||"UTC";
  field("scheduleKind").value=plan?.schedule?.kind||"daily";
  field("scheduleTime").value=plan?.schedule?.time||"03:00";
  field("enabled").checked=plan?.enabled??true;
  field("keepDaily").value=plan?.retention?.keepDaily??7;
  field("keepWeekly").value=plan?.retention?.keepWeekly??4;
  field("keepMonthly").value=plan?.retention?.keepMonthly??12;
  const selected=new Set(plan?.schedule?.days??[1,2,3,4,5]);
  form.querySelector("#plan-weekdays").innerHTML=`<div class="weekday-grid">${DAYS.map(([value,label])=>`<label><input type="checkbox" name="weekday" value="${value}" ${selected.has(value)?"checked":""}><span>${label}</span></label>`).join("")}</div>`;
  renderPayload(plan?.payload||{});toggleSections();
}
function closeEditor(){modal?.classList.add("hidden");editing=null;}

function ensureModal(){
  if(modal)return;
  const shell=document.createElement("div");
  shell.innerHTML=`<div class="modal-backdrop hidden" id="plan-modal"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="plan-modal-title"><div class="modal-header"><div><p class="eyebrow">Automation</p><h2 id="plan-modal-title">New backup plan</h2></div><button class="icon-button" type="button" data-close>×</button></div><form id="plan-form"><p class="plan-modal-copy">Plans reference local source/repository IDs only. Credentials stay inside the agent.</p><div class="plan-form-grid"><label class="full"><span>Name</span><input name="name" maxlength="120" required placeholder="Nightly appdata"></label><label><span>Backup type</span><select name="jobType"><option value="restic-backup">Local → Restic</option><option value="rclone-restic-backup">Remote mount → Restic</option><option value="rclone-transfer">Rclone copy</option></select></label><label><span>Timezone</span><input name="timezone" required></label><div class="full" id="plan-payload"></div><div class="plan-section full"><strong>Schedule</strong><div class="plan-form-grid"><label><span>Frequency</span><select name="scheduleKind"><option value="daily">Daily</option><option value="weekly">Weekly</option></select></label><label><span>Local time</span><input type="time" name="scheduleTime" required></label><div class="full" id="plan-weekdays"></div></div></div><div class="plan-section full" id="retention-section"><strong>Retention policy</strong><div class="retention-grid"><label><span>Daily</span><input type="number" name="keepDaily" min="0" max="3650"></label><label><span>Weekly</span><input type="number" name="keepWeekly" min="0" max="3650"></label><label><span>Monthly</span><input type="number" name="keepMonthly" min="0" max="3650"></label></div><small>Stored now; enforcement arrives with maintenance jobs.</small></div><label class="enabled-row full"><input type="checkbox" name="enabled"><span>Enabled</span></label></div><div class="modal-actions"><button type="button" class="button ghost" data-close>Cancel</button><button type="submit" class="button primary">Save plan</button></div></form></section></div>`;
  modal=shell.firstElementChild;document.body.append(modal);form=modal.querySelector("#plan-form");
  field("jobType").innerHTML='<option value="rclone-transfer">File transfer</option>';
  modal.querySelectorAll("[data-close]").forEach(button=>button.addEventListener("click",closeEditor));
  modal.addEventListener("click",event=>{if(event.target===modal)closeEditor();});
  field("jobType").addEventListener("change",()=>{renderPayload();toggleSections();});
  field("scheduleKind").addEventListener("change",toggleSections);
  form.addEventListener("submit",event=>void save(event));
}

function renderPayload(payload={}){
  const host=form.querySelector("#plan-payload"),type=field("jobType").value;
  if(type==="restic-backup")host.innerHTML=`<div class="plan-form-grid"><label><span>Source</span><select name="sourceId" required>${options(config.sources,"Select source",payload.sourceId)}</select></label><label><span>Repository</span><select name="repositoryId" required>${options(config.repositories,"Select repository",payload.repositoryId)}</select></label><label class="full"><span>Tags <small>optional</small></span><input name="tags" value="${attr((payload.tags??[]).join(", "))}" placeholder="nightly, appdata"></label></div>`;
  else if(type==="rclone-restic-backup")host.innerHTML=`<div class="plan-form-grid"><label><span>Remote source</span><select name="sourceEndpointId" required>${options((config.endpoints??[]).filter(e=>e.mount?.enabled),"Select mountable endpoint",payload.sourceEndpointId)}</select></label><label><span>Repository</span><select name="repositoryId" required>${options(config.repositories,"Select repository",payload.repositoryId)}</select></label><label class="full"><span>Tags <small>optional</small></span><input name="tags" value="${attr((payload.tags??[]).join(", "))}" placeholder="cloud, nightly"></label></div>`;
  else host.innerHTML=`<div class="plan-form-grid"><label><span>Source endpoint</span><select name="sourceEndpointId" required>${options(config.endpoints,"Select source",payload.sourceEndpointId)}</select></label><label><span>Destination endpoint</span><select name="destinationEndpointId" required>${options(config.endpoints,"Select destination",payload.destinationEndpointId)}</select></label><p class="muted-2 small full">Scheduled transfers are copy-only. Move/delete is intentionally unavailable.</p></div>`;
}
function toggleSections(){form.querySelector("#plan-weekdays").hidden=field("scheduleKind").value!=="weekly";form.querySelector("#retention-section").hidden=field("jobType").value==="rclone-transfer";}

async function save(event){
  event.preventDefault();const button=form.querySelector('button[type="submit"]');button.disabled=true;button.textContent="Saving…";
  try{
    const data=new FormData(form),jobType=String(data.get("jobType"));
    const tags=String(data.get("tags")||"").split(",").map(v=>v.trim()).filter(Boolean);
    let payload;
    if(jobType==="restic-backup")payload={sourceId:String(data.get("sourceId")),repositoryId:String(data.get("repositoryId")),...(tags.length?{tags}:{})};
    else if(jobType==="rclone-restic-backup")payload={sourceEndpointId:String(data.get("sourceEndpointId")),repositoryId:String(data.get("repositoryId")),...(tags.length?{tags}:{})};
    else payload={sourceEndpointId:String(data.get("sourceEndpointId")),destinationEndpointId:String(data.get("destinationEndpointId")),mode:"copy"};
    const kind=String(data.get("scheduleKind")),schedule={kind,time:String(data.get("scheduleTime"))};
    if(kind==="weekly")schedule.days=[...form.querySelectorAll('input[name="weekday"]:checked')].map(input=>Number(input.value));
    const body={name:String(data.get("name")),enabled:field("enabled").checked,jobType,payload,schedule,timezone:String(data.get("timezone")),retention:jobType==="rclone-transfer"?{keepDaily:0,keepWeekly:0,keepMonthly:0}:{keepDaily:Number(data.get("keepDaily")),keepWeekly:Number(data.get("keepWeekly")),keepMonthly:Number(data.get("keepMonthly"))}};
    if(editing)await api(`/v1/local/plans/${encodeURIComponent(editing.id)}`,{method:"PUT",body});else await api("/v1/local/plans",{method:"POST",body});
    toast(editing?"Plan updated":"Plan created",body.name);closeEditor();await refresh(true);
  }catch(error){toast("Could not save plan",error.message,true)}
  finally{button.disabled=false;button.textContent="Save plan";}
}

function scheduleCell(p){const s=p.schedule??{},days=s.kind==="weekly"?(s.days??[]).map(day=>DAYS.find(([value])=>value===day)?.[1]??day).join(", "):"Every day";return `<div class="plan-schedule"><strong>${esc(s.time||"—")} · ${esc(days)}</strong><span>${esc(p.timezone)}</span></div>`;}
function lastCell(p){if(!p.lastJob)return '<span class="muted-2">Never run</span>';return `<div class="plan-last">${badge(p.lastJob.state)}<span class="cell-sub">${esc(p.lastJob.finishedAt?past(p.lastJob.finishedAt):p.lastJob.updatedAt?past(p.lastJob.updatedAt):"Queued")}</span></div>`;}
function retentionCell(p){if(p.jobType==="rclone-transfer")return '<span class="muted-2">n/a</span>';const r=p.retention??{};return `<div class="plan-retention"><span>${Number(r.keepDaily??0)}d</span><span>${Number(r.keepWeekly??0)}w</span><span>${Number(r.keepMonthly??0)}m</span></div>`;}
function badge(state){const cls=state==="completed"?"success":state==="failed"?"danger":state==="partial"?"warn":ACTIVE.has(state)?"info":"";return `<span class="badge ${cls}">${esc(state||"unknown")}</span>`;}
function metric(label,value,foot,accent=""){return `<article class="card metric"><div class="metric-head"><span>${esc(label)}</span><span class="metric-accent ${accent}"></span></div><div class="metric-value">${esc(value)}</div><div class="metric-foot">${esc(foot)}</div></article>`;}
function typeLabel(type){return type==="restic-backup"?"Local → Restic":type==="rclone-restic-backup"?"Remote → Restic":type==="rclone-transfer"?"Rclone copy":type;}
function options(items,placeholder,selected){return `<option value="">${esc(placeholder)}</option>${(items??[]).map(item=>`<option value="${attr(item.id)}" ${item.id===selected?"selected":""}>${esc(item.id)}</option>`).join("")}`;}
function shortFuture(value){const ms=Date.parse(value)-Date.now();if(ms<=0)return"Due now";if(ms<3600000)return`${Math.max(1,Math.round(ms/60000))}m`;if(ms<86400000)return`${Math.round(ms/3600000)}h`;return`${Math.round(ms/86400000)}d`;}
function future(value){const v=shortFuture(value);return v==="Due now"?v:`in ${v}`;}
function past(value){const ms=Date.now()-Date.parse(value);if(!Number.isFinite(ms)||ms<5000)return"just now";if(ms<60000)return`${Math.round(ms/1000)}s ago`;if(ms<3600000)return`${Math.round(ms/60000)}m ago`;if(ms<86400000)return`${Math.round(ms/3600000)}h ago`;return`${Math.round(ms/86400000)}d ago`;}
function dateInZone(value,zone){try{return new Intl.DateTimeFormat([],{timeZone:zone,dateStyle:"medium",timeStyle:"short"}).format(new Date(value));}catch{return new Date(value).toLocaleString();}}
function field(name){return form.elements.namedItem(name);}
async function api(path,{method="GET",body}={}){const response=await fetch(path,{method,headers:{accept:"application/json",...(body===undefined?{}:{"content-type":"application/json"})},body:body===undefined?undefined:JSON.stringify(body),cache:"no-store"});if(response.ok)return response.status===204?null:await response.json();let message=`${response.status} ${response.statusText}`;try{const data=await response.json();message=data.message??data.code??message;}catch{}throw new Error(message);}
function toast(head,message,error=false){const item=document.createElement("div");item.className=`toast${error?" error":""}`;item.innerHTML=`<strong>${esc(head)}</strong><div>${esc(message||"")}</div>`;toastStack.append(item);setTimeout(()=>item.remove(),4200);}
function esc(value){return String(value??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;");}
function attr(value){return esc(value);}
