const nativeFetch=window.fetch.bind(window);
let state=null;
let loading=null;

async function loadStatus(){
  if(loading)return loading;
  loading=(async()=>{
    const response=await nativeFetch("/v1/local/auth/status",{headers:{accept:"application/json"},cache:"no-store"});
    const data=await response.json().catch(()=>({}));
    state=data;
    if(!data.authenticated){location.replace("/auth.html");throw new Error("Authentication required")}
    return data;
  })().finally(()=>{loading=null});
  return loading;
}

window.fetch=async function(input,init={}){
  const requestUrl=new URL(typeof input==="string"||input instanceof URL?input:input.url,location.href);
  const method=String(init.method||(input instanceof Request?input.method:"GET")||"GET").toUpperCase();
  const local=requestUrl.origin===location.origin&&requestUrl.pathname.startsWith("/v1/local/");
  const authPath=requestUrl.pathname.startsWith("/v1/local/auth/");
  let nextInit=init;
  if(local&&!authPath&&!["GET","HEAD","OPTIONS"].includes(method)){
    const auth=state?.authenticated?state:await loadStatus();
    const headers=new Headers(init.headers||(input instanceof Request?input.headers:undefined));
    headers.set("x-nexus-csrf",auth.csrfToken);
    nextInit={...init,headers};
  }
  const response=await nativeFetch(input,nextInit);
  if(local&&!authPath&&response.status===401){state=null;location.replace("/auth.html")}
  return response;
};

window.nexusAuth={
  async status(){return state?.authenticated?state:loadStatus()},
  async logout(){
    const auth=state?.authenticated?state:await loadStatus();
    await nativeFetch("/v1/local/auth/logout",{method:"POST",headers:{"x-nexus-csrf":auth.csrfToken,accept:"application/json"}}).catch(()=>{});
    state=null;location.replace("/auth.html");
  },
};

void loadStatus().then(()=>{
  const actions=document.querySelector(".topbar-actions");
  if(actions&&!actions.querySelector("[data-logout]")){
    const button=document.createElement("button");
    button.className="button ghost";button.dataset.logout="";button.textContent="Log out";
    button.addEventListener("click",()=>void window.nexusAuth.logout());
    actions.prepend(button);
  }
  installWorkstationDashboard();
  installWorkstationRecoveryDashboard();
}).catch(()=>{});

function installWorkstationDashboard(){
  const devicesNav=document.querySelector("#devices-nav");
  const nav=document.querySelector(".nav");
  const content=document.querySelector("#content");
  const title=document.querySelector("#page-title");
  const eyebrow=document.querySelector("#page-eyebrow");
  const newButton=document.querySelector("#new-job-button");
  const refreshButton=document.querySelector("#refresh-button");
  const toastStack=document.querySelector("#toast-stack");
  if(!nav||!content||document.querySelector("#workstations-nav"))return;

  const workstationNav=document.createElement("button");
  workstationNav.className="nav-item";workstationNav.id="workstations-nav";
  workstationNav.innerHTML='<span class="nav-icon">▤</span><span>Workstations</span>';
  devicesNav?.after(workstationNav);if(!devicesNav)nav.append(workstationNav);
  injectWorkstationStyles();

  let workstations=[];
  let busy=false;
  let modal=null;
  let tokenModal=null;

  workstationNav.addEventListener("click",()=>{location.hash="workstations";activate()});
  window.addEventListener("hashchange",activate);
  document.addEventListener("click",event=>{
    if(!active())return;
    if(event.target.closest?.("#new-job-button")){event.preventDefault();event.stopImmediatePropagation();openEnroll();}
    if(event.target.closest?.("#refresh-button")){event.preventDefault();event.stopImmediatePropagation();void refresh(false);}
  },true);
  new MutationObserver(()=>{if(active()&&!content.querySelector("#workstations-view"))queueMicrotask(render)}).observe(content,{childList:true});
  setInterval(()=>{if(active())void refresh(true)},3000);
  activate();

  function active(){return(location.hash.replace(/^#/,"")||"overview")==="workstations"}
  function activate(){
    if(!active()){
      workstationNav.classList.remove("active");closeModal();return;
    }
    document.querySelectorAll("[data-view]").forEach(item=>item.classList.remove("active"));
    document.querySelector("#plans-nav")?.classList.remove("active");
    document.querySelector("#transfers-nav")?.classList.remove("active");
    document.querySelector("#devices-nav")?.classList.remove("active");
    workstationNav.classList.add("active");
    if(title)title.textContent="Workstations";
    if(eyebrow)eyebrow.textContent="Nexus Backup";
    if(newButton){newButton.hidden=false;newButton.textContent="Add workstation";}
    render();void refresh(workstations.length>0);
  }

  async function refresh(quiet=true){
    if(busy)return;busy=true;
    if(!quiet&&active())refreshButton.textContent="Refreshing…";
    try{
      const response=await fetch("/v1/local/workstations",{headers:{accept:"application/json"}});
      const data=await response.json().catch(()=>({}));
      if(!response.ok)throw new Error(data.message||`Workstations request failed (${response.status})`);
      workstations=data.workstations??[];render();
    }catch(error){if(!quiet)toast("Workstations refresh failed",error.message,true)}
    finally{busy=false;if(!quiet&&active())refreshButton.textContent="Refresh";}
  }

  function render(){
    if(!active())return;
    document.querySelectorAll("[data-view]").forEach(item=>item.classList.remove("active"));
    document.querySelector("#plans-nav")?.classList.remove("active");
    document.querySelector("#transfers-nav")?.classList.remove("active");
    document.querySelector("#devices-nav")?.classList.remove("active");
    workstationNav.classList.add("active");
    if(title)title.textContent="Workstations";
    if(eyebrow)eyebrow.textContent="Nexus Backup";
    if(newButton){newButton.hidden=false;newButton.textContent="Add workstation";}
    const online=workstations.filter(item=>item.online).length;
    const protectedCount=workstations.filter(item=>item.status?.repositoryConfigured&&item.status?.lastSuccessAt).length;
    const running=workstations.filter(item=>item.lastRun?.state==="running"||item.lastRun?.state==="leased").length;
    const attention=workstations.filter(item=>!item.status?.repositoryConfigured||item.lastRun?.state==="failed"||item.lastRun?.state==="partial").length;
    content.innerHTML=`<div id="workstations-view">
      <div class="transfer-hero"><div><p class="eyebrow">Endpoint backup</p><h2>Workstations</h2><p>Windows PCs back themselves up directly with Restic. Nexus owns policy, schedules and status; repository credentials stay on each workstation.</p></div><span class="badge success">M6 workstation</span></div>
      <div class="grid metrics">${metric("Online",online,`${workstations.length} enrolled`,online?"blue":"")}${metric("Protected",protectedCount,"Has successful backup",protectedCount?"success":"")}${metric("Running",running,"Active workstation jobs",running?"blue":"")}${metric("Attention",attention,attention?"Needs setup or review":"All clear",attention?"warn":"")}</div>
      <div class="workstation-grid section-gap">${workstations.map(card).join("")||'<div class="empty"><strong>No workstations yet</strong><span>Add a workstation to generate the one-line irm installer command.</span></div>'}</div>
      <div class="transfer-note"><strong>Data path:</strong> workstation → its locally configured Restic repository. Nexus receives policy, progress and snapshot metadata only; repository URL and password are never uploaded.</div>
    </div>`;
    bind();
  }

  function card(ws){
    const status=ws.status??{};const run=ws.lastRun;const progress=run?.progress;
    const state=!ws.enabled?"Disabled":ws.online?"Online":"Offline";
    const stateTone=!ws.enabled?"warn":ws.online?"success":"danger";
    const storage=status.repositoryConfigured?`${esc(status.repositoryKind||"configured")}`:"Needs storage setup";
    const backupState=run?.state||"never";
    const pct=progress?.percent!=null?Math.max(0,Math.min(100,Number(progress.percent))):null;
    return `<section class="card workstation-card" data-ws="${attr(ws.id)}">
      <div class="transfer-head"><div class="transfer-title"><span class="transfer-state${ws.online?"":" paused"}"></span><div><h2>${esc(ws.name)}</h2><span>${esc(ws.hostname||ws.id)} · ${esc(ws.version||"not installed yet")}</span></div></div><div class="transfer-actions"><span class="badge ${stateTone}">${state}</span><button class="button ghost compact" data-ws-action="policy" data-id="${attr(ws.id)}">Policy</button><button class="button primary compact" data-ws-action="run" data-id="${attr(ws.id)}" ${!ws.online||!status.repositoryConfigured||!ws.policy?"disabled":""}>Run now</button></div></div>
      <div class="transfer-facts">${fact("Storage",storage,status.repositoryConfigured?"Credentials local":"Configure workstation.json",status.repositoryConfigured?"":"warn")}${fact("Last success",status.lastSuccessAt?relative(status.lastSuccessAt):"Never",status.lastSnapshotId?`Snapshot ${String(status.lastSnapshotId).slice(0,12)}`:"No snapshot")}${fact("Next run",ws.policy?.nextRunAt?relative(ws.policy.nextRunAt):"Not scheduled",ws.policy?.enabled?`${scheduleLabel(ws.policy.schedule)} · ${ws.policy.timezone}`:"Policy disabled")}${fact("Last run",backupState,run?.error||status.lastError||"No error",run?.state==="failed"||run?.state==="partial"?"danger":"")}</div>
      ${pct!==null?`<div class="ws-progress"><div><span style="width:${pct.toFixed(1)}%"></span></div><small>${esc(progress.phase||"running")} · ${pct.toFixed(0)}%${progress.bytesDone!=null?` · ${bytes(progress.bytesDone)} / ${bytes(progress.bytesTotal||0)}`:""}${progress.currentPath?` · ${esc(progress.currentPath)}`:""}</small></div>`:""}
      <div class="transfer-meta filters"><span>Sources: ${ws.policy?.sourcePaths?.length?esc(ws.policy.sourcePaths.join(", ")):"not configured"}</span><span>Excludes: ${ws.policy?.excludePatterns?.length?esc(ws.policy.excludePatterns.join(", ")):"none"}</span><span>Retention: ${ws.policy?`${ws.policy.retention.keepDaily}d / ${ws.policy.retention.keepWeekly}w / ${ws.policy.retention.keepMonthly}m`:"—"}</span><span>Last seen: ${ws.lastSeenAt?relative(ws.lastSeenAt):"never"}</span></div>
    </section>`;
  }

  function bind(){
    content.querySelectorAll("[data-ws-action]").forEach(button=>button.addEventListener("click",async()=>{
      const ws=workstations.find(item=>item.id===button.dataset.id);if(!ws)return;
      if(button.dataset.wsAction==="policy"){openPolicy(ws);return;}
      if(button.dataset.wsAction==="run"){
        button.disabled=true;
        try{await request(`/v1/local/workstations/${encodeURIComponent(ws.id)}/run`,{method:"POST",body:{}});toast("Workstation backup queued",ws.name);await refresh(true)}
        catch(error){toast("Could not queue backup",error.message,true)}finally{button.disabled=false}
      }
    }));
  }

  function openEnroll(){
    closeModal();modal=document.createElement("div");modal.className="modal-backdrop";
    modal.innerHTML=`<section class="modal" role="dialog" aria-modal="true"><div class="modal-header"><div><p class="eyebrow">Windows endpoint</p><h2>Add workstation</h2></div><button class="icon-button" data-ws-close>×</button></div><form id="ws-enroll-form"><label><span>Name</span><input name="name" required maxlength="100" autocomplete="off" placeholder="Balder PC"></label><p class="muted-2">Nexus creates a one-time device credential and gives you a direct PowerShell irm command. Run it elevated on the PC or send the same command through PCWatch.</p><div class="modal-actions"><button type="button" class="button ghost" data-ws-close>Cancel</button><button type="submit" class="button primary">Create installer</button></div></form></section>`;
    document.body.append(modal);modal.querySelectorAll("[data-ws-close]").forEach(button=>button.addEventListener("click",closeModal));
    modal.querySelector("form").addEventListener("submit",async event=>{
      event.preventDefault();const submit=event.submitter;submit.disabled=true;
      try{const data=await request("/v1/local/workstations/enroll",{method:"POST",body:{name:new FormData(event.currentTarget).get("name")}});closeModal();showInstaller(data);await refresh(true)}
      catch(error){toast("Enrollment failed",error.message,true);submit.disabled=false}
    });
  }

  function showInstaller(data){
    tokenModal=document.createElement("div");tokenModal.className="modal-backdrop";
    tokenModal.innerHTML=`<section class="modal ws-installer-modal" role="dialog" aria-modal="true"><div class="modal-header"><div><p class="eyebrow">One-line install</p><h2>${esc(data.device?.name||"Workstation")}</h2></div><button class="icon-button" data-token-close>×</button></div><div class="ws-installer"><p>Run this in an elevated PowerShell, or send the exact same command through PCWatch:</p><pre><code>${esc(data.installCommand||"")}</code></pre><button class="button primary" data-copy-install>Copy command</button><p class="muted-2"><strong>Shown once:</strong> the device token is embedded in this command. Nexus stores only its SHA-256 hash.</p></div></section>`;
    document.body.append(tokenModal);tokenModal.querySelectorAll("[data-token-close]").forEach(button=>button.addEventListener("click",()=>{tokenModal.remove();tokenModal=null}));
    tokenModal.querySelector("[data-copy-install]")?.addEventListener("click",async event=>{await navigator.clipboard.writeText(data.installCommand||"");event.currentTarget.textContent="Copied"});
  }

  function openPolicy(ws){
    closeModal();const p=ws.policy??{enabled:true,sourcePaths:[],excludePatterns:[],schedule:{kind:"daily",time:"02:00"},timezone:Intl.DateTimeFormat().resolvedOptions().timeZone||"UTC",retention:{keepDaily:7,keepWeekly:4,keepMonthly:12}};
    modal=document.createElement("div");modal.className="modal-backdrop";
    modal.innerHTML=`<section class="modal ws-policy-modal" role="dialog" aria-modal="true"><div class="modal-header"><div><p class="eyebrow">${esc(ws.name)}</p><h2>Backup policy</h2></div><button class="icon-button" data-ws-close>×</button></div><form id="ws-policy-form"><label><span>Source paths <small>one Windows path per line</small></span><textarea name="sources" rows="5" placeholder="C:\\Users\\Martin\\Documents">${esc((p.sourcePaths||[]).join("\n"))}</textarea></label><label><span>Exclude patterns <small>one Restic pattern per line</small></span><textarea name="excludes" rows="4" placeholder="**/Cache/**">${esc((p.excludePatterns||[]).join("\n"))}</textarea></label><div class="ws-form-grid"><label><span>Schedule</span><select name="kind"><option value="daily" ${p.schedule?.kind==="daily"?"selected":""}>Daily</option><option value="weekly" ${p.schedule?.kind==="weekly"?"selected":""}>Weekly</option></select></label><label><span>Time</span><input name="time" type="time" value="${attr(p.schedule?.time||"02:00")}" required></label><label><span>Timezone</span><input name="timezone" value="${attr(p.timezone||"UTC")}" required></label></div><label class="ws-days"><span>Weekly days</span><div>${[[1,"Mon"],[2,"Tue"],[3,"Wed"],[4,"Thu"],[5,"Fri"],[6,"Sat"],[0,"Sun"]].map(([day,label])=>`<label><input type="checkbox" name="days" value="${day}" ${(p.schedule?.days||[]).includes(day)?"checked":""}> ${label}</label>`).join("")}</div></label><div class="ws-form-grid"><label><span>Keep daily</span><input name="daily" type="number" min="0" max="3650" value="${p.retention?.keepDaily??7}"></label><label><span>Keep weekly</span><input name="weekly" type="number" min="0" max="3650" value="${p.retention?.keepWeekly??4}"></label><label><span>Keep monthly</span><input name="monthly" type="number" min="0" max="3650" value="${p.retention?.keepMonthly??12}"></label></div><label class="enabled-row"><input name="enabled" type="checkbox" ${p.enabled!==false?"checked":""}><span>Enable scheduled backups</span></label><div class="modal-actions"><button type="button" class="button ghost" data-ws-close>Cancel</button><button type="submit" class="button primary">Save policy</button></div></form></section>`;
    document.body.append(modal);modal.querySelectorAll("[data-ws-close]").forEach(button=>button.addEventListener("click",closeModal));
    modal.querySelector("form").addEventListener("submit",async event=>{
      event.preventDefault();const fd=new FormData(event.currentTarget);const kind=String(fd.get("kind"));const days=fd.getAll("days").map(Number);if(kind==="weekly"&&!days.length){toast("Weekly schedule needs a day","Select at least one weekday.",true);return}
      const body={enabled:fd.has("enabled"),sourcePaths:lines(fd.get("sources")),excludePatterns:lines(fd.get("excludes")),schedule:kind==="weekly"?{kind,time:String(fd.get("time")),days}:{kind,time:String(fd.get("time"))},timezone:String(fd.get("timezone")),retention:{keepDaily:Number(fd.get("daily")),keepWeekly:Number(fd.get("weekly")),keepMonthly:Number(fd.get("monthly"))}};
      const submit=event.submitter;submit.disabled=true;
      try{await request(`/v1/local/workstations/${encodeURIComponent(ws.id)}/policy`,{method:"PUT",body});closeModal();toast("Workstation policy saved",ws.name);await refresh(true)}
      catch(error){toast("Policy save failed",error.message,true);submit.disabled=false}
    });
  }

  async function request(url,{method="GET",body}={}){const response=await fetch(url,{method,headers:{accept:"application/json",...(body!==undefined?{"content-type":"application/json"}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.message||`${method} ${url} failed (${response.status})`);return data}
  function closeModal(){if(modal){modal.remove();modal=null}}
  function lines(value){return String(value||"").split(/\r?\n/).map(item=>item.trim()).filter(Boolean)}
  function metric(label,value,sub,tone=""){return`<article class="metric ${tone}"><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(sub)}</small></article>`}
  function fact(label,value,sub,tone=""){return`<div class="transfer-fact ${tone}"><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(sub)}</small></div>`}
  function scheduleLabel(schedule){if(!schedule)return"No schedule";if(schedule.kind==="weekly")return`${schedule.time} weekly`;return`${schedule.time} daily`}
  function relative(value){const ms=Date.now()-new Date(value).getTime();const future=ms<0;const sec=Math.round(Math.abs(ms)/1000);if(sec<60)return future?"in <1m":"just now";const min=Math.round(sec/60);if(min<60)return future?`in ${min}m`:`${min}m ago`;const hr=Math.round(min/60);if(hr<48)return future?`in ${hr}h`:`${hr}h ago`;const day=Math.round(hr/24);return future?`in ${day}d`:`${day}d ago`}
  function bytes(value){const n=Number(value)||0;if(n<1024)return`${n} B`;const units=["KiB","MiB","GiB","TiB"];let v=n/1024,i=0;while(v>=1024&&i<units.length-1){v/=1024;i++}return`${v>=10?v.toFixed(0):v.toFixed(1)} ${units[i]}`}
  function esc(value){return String(value??"").replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[char]))}
  function attr(value){return esc(value)}
  function toast(head,detail,isError=false){if(!toastStack)return;const item=document.createElement("div");item.className=`toast${isError?" error":""}`;item.innerHTML=`<strong>${esc(head)}</strong><span>${esc(detail||"")}</span>`;toastStack.append(item);setTimeout(()=>item.remove(),4500)}
}

function injectWorkstationStyles(){
  if(document.querySelector("#workstation-styles"))return;
  const style=document.createElement("style");style.id="workstation-styles";style.textContent=`
    .workstation-grid{display:grid;gap:16px}.workstation-card{overflow:hidden}.ws-progress{padding:0 18px 16px}.ws-progress>div{height:8px;border-radius:999px;background:var(--surface-3,#202735);overflow:hidden}.ws-progress>div>span{display:block;height:100%;background:currentColor}.ws-progress small{display:block;margin-top:7px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.ws-installer pre{white-space:pre-wrap;word-break:break-all;padding:14px;border-radius:10px;background:var(--surface-2,#111721);border:1px solid var(--border,#2b3442);max-height:220px;overflow:auto}.ws-installer{display:grid;gap:14px}.ws-form-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.ws-policy-modal textarea{resize:vertical;min-height:90px}.ws-days>div{display:flex;flex-wrap:wrap;gap:10px;margin-top:8px}.ws-days>div label{display:flex;flex-direction:row;align-items:center;gap:5px}.transfer-fact.warn strong{color:var(--warning,#e5a93b)}@media(max-width:700px){.ws-form-grid{grid-template-columns:1fr}.workstation-card .transfer-head{align-items:flex-start}.workstation-card .transfer-actions{flex-wrap:wrap}.ws-progress small{white-space:normal}}
  `;document.head.append(style);
}

function installWorkstationRecoveryDashboard(){
  const content=document.querySelector("#content");
  const toastStack=document.querySelector("#toast-stack");
  if(!content||document.querySelector("#workstation-recovery-styles"))return;
  injectWorkstationRecoveryStyles();

  let workstations=[];
  let modal=null;
  let modalSerial=0;
  let refreshing=false;

  const observer=new MutationObserver(()=>{if(active())queueMicrotask(enhanceCards)});
  observer.observe(content,{childList:true,subtree:true});
  window.addEventListener("hashchange",()=>{if(active()){void refreshIndex()}else closeRecovery()});
  document.addEventListener("click",event=>{
    const button=event.target.closest?.("[data-ws-recovery]");
    if(!button||!active())return;
    const ws=workstations.find(item=>item.id===button.dataset.id);
    if(ws)openRecovery(ws);
  });
  setInterval(()=>{if(active())void refreshIndex()},3000);
  if(active())void refreshIndex();

  function active(){return(location.hash.replace(/^#/,"")||"overview")==="workstations"}

  async function refreshIndex(){
    if(refreshing)return;refreshing=true;
    try{
      const data=await api("/v1/local/workstations");
      workstations=data.workstations??[];
      enhanceCards();
    }catch{}finally{refreshing=false}
  }

  function enhanceCards(){
    if(!active())return;
    content.querySelectorAll(".workstation-card[data-ws]").forEach(card=>{
      const ws=workstations.find(item=>item.id===card.dataset.ws);
      const actions=card.querySelector(".transfer-actions");
      if(!actions)return;
      let button=actions.querySelector("[data-ws-recovery]");
      if(!button){
        button=document.createElement("button");button.className="button ghost compact";button.dataset.wsRecovery="";button.dataset.id=card.dataset.ws;button.textContent="Recovery";
        const runButton=actions.querySelector('[data-ws-action="run"]');if(runButton)actions.insertBefore(button,runButton);else actions.append(button);
      }
      const supported=Boolean(ws?.capabilities?.includes("workstation.recovery.v1"));
      const ready=Boolean(ws?.enabled&&ws?.online&&ws?.status?.repositoryConfigured&&supported);
      button.disabled=!ready;
      button.title=ready?"Browse snapshots and restore safely to staging":!supported?"Update the workstation agent to enable recovery":!ws?.online?"Workstation must be online":"Workstation storage must be configured";
    });
    const badge=content.querySelector("#workstations-view .transfer-hero .badge");if(badge)badge.textContent="M7 recovery";
  }

  function openRecovery(ws){
    closeRecovery();
    const serial=++modalSerial;
    const model={ws,inventory:null,snapshotId:null,browse:null,currentPath:"/",selectedPath:null,run:null,preview:null,restore:null,confirmation:"",message:"Loading cached snapshots…",busy:false};
    modal=document.createElement("div");modal.className="modal-backdrop ws-recovery-backdrop";
    modal.innerHTML=`<section class="modal ws-recovery-modal" role="dialog" aria-modal="true"><div class="modal-header"><div><p class="eyebrow">Safe workstation recovery</p><h2>${esc(ws.name)}</h2></div><button class="icon-button" data-recovery-close aria-label="Close">×</button></div><div id="ws-recovery-body"></div></section>`;
    document.body.append(modal);modal.querySelector("[data-recovery-close]")?.addEventListener("click",closeRecovery);
    renderRecovery(model);
    void loadCachedInventory(model,serial);
  }

  async function loadCachedInventory(model,serial){
    try{
      const data=await api(`/v1/local/workstations/${encodeURIComponent(model.ws.id)}/recovery/inventory`);
      if(!current(serial))return;
      model.inventory=data.inventory;
      if(model.inventory?.snapshots?.length){
        const snapshots=[...model.inventory.snapshots].sort((a,b)=>Date.parse(b.time)-Date.parse(a.time));
        model.inventory={...model.inventory,snapshots};model.snapshotId=snapshots[0].id;model.message="Select a snapshot and path to recover.";
        renderRecovery(model);await loadBrowse(model,"/",serial,false);
      }else{model.message="No cached snapshot inventory yet. Refresh snapshots to query the workstation.";renderRecovery(model)}
    }catch(error){if(current(serial)){model.message=error.message;renderRecovery(model,true)}}
  }

  async function refreshInventory(model,serial){
    if(model.busy)return;model.busy=true;model.message="Refreshing snapshot inventory on the workstation…";renderRecovery(model);
    try{
      const queued=await api(`/v1/local/workstations/${encodeURIComponent(model.ws.id)}/recovery/inventory`,{method:"POST"});
      const result=await waitRun(model,queued.run.id,serial);
      if(!current(serial))return;
      if(result.run.state!=="completed")throw new Error(result.run.error||"Snapshot inventory failed");
      const data=await api(`/v1/local/workstations/${encodeURIComponent(model.ws.id)}/recovery/inventory`);
      model.inventory=data.inventory;const snapshots=[...(model.inventory?.snapshots??[])].sort((a,b)=>Date.parse(b.time)-Date.parse(a.time));
      if(model.inventory)model.inventory={...model.inventory,snapshots};model.snapshotId=snapshots[0]?.id??null;model.browse=null;model.selectedPath=null;model.preview=null;model.restore=null;model.message=snapshots.length?"Snapshot inventory refreshed.":"No workstation snapshots were found.";
      if(model.snapshotId)await loadBrowse(model,"/",serial,false);else renderRecovery(model);
    }catch(error){if(current(serial)){model.message=error.message;renderRecovery(model,true)}}finally{model.busy=false;if(current(serial))renderRecovery(model)}
  }

  async function selectSnapshot(model,snapshotId,serial){
    model.snapshotId=snapshotId;model.currentPath="/";model.browse=null;model.selectedPath=null;model.preview=null;model.restore=null;model.confirmation="";model.message="Loading snapshot root…";renderRecovery(model);await loadBrowse(model,"/",serial,false);
  }

  async function loadBrowse(model,path,serial,force){
    if(!model.snapshotId||model.busy)return;
    model.busy=true;model.currentPath=path;model.browse=null;model.selectedPath=null;model.preview=null;model.restore=null;model.confirmation="";model.message=`Loading ${path}…`;renderRecovery(model);
    try{
      const base=`/v1/local/workstations/${encodeURIComponent(model.ws.id)}/recovery/snapshots/${encodeURIComponent(model.snapshotId)}/browse`;
      let data=force?{browse:null}:await api(`${base}?path=${encodeURIComponent(path)}`);
      if(!data.browse){
        const queued=await api(base,{method:"POST",body:{path}});
        const result=await waitRun(model,queued.run.id,serial);
        if(!current(serial))return;
        if(result.run.state!=="completed")throw new Error(result.run.error||"Snapshot browse failed");
        data=await api(`${base}?path=${encodeURIComponent(path)}`);
      }
      if(!current(serial))return;
      model.browse=data.browse;model.currentPath=data.browse?.path??path;model.message=data.browse?.truncated?"Folder contains more entries than the safe browse limit; showing the first results.":"Choose a file or folder, then preview the restore.";
    }catch(error){if(current(serial))model.message=error.message}finally{model.busy=false;if(current(serial))renderRecovery(model)}
  }

  async function previewRestore(model,serial){
    if(model.busy||model.selectedPath===null||!model.snapshotId)return;
    model.busy=true;model.preview=null;model.restore=null;model.confirmation="";model.message="Running Restic dry-run preview…";renderRecovery(model);
    try{
      const queued=await api(`/v1/local/workstations/${encodeURIComponent(model.ws.id)}/recovery/snapshots/${encodeURIComponent(model.snapshotId)}/preview`,{method:"POST",body:{path:model.selectedPath}});
      const result=await waitRun(model,queued.run.id,serial);
      if(!current(serial))return;
      model.preview=result;
      if(result.run.state!=="completed")throw new Error(result.run.error||"Restore preview failed");
      if(!result.restoreConfirmation)throw new Error("Preview completed without a restore confirmation token");
      model.message="Preview completed. Review the changes before enabling the staging restore.";
    }catch(error){if(current(serial)){model.message=error.message;model.preview=null}}finally{model.busy=false;if(current(serial))renderRecovery(model)}
  }

  async function executeRestore(model,serial){
    if(model.busy||!model.preview?.run||model.confirmation!==model.preview.restoreConfirmation)return;
    model.busy=true;model.restore=null;model.message="Restoring into a new workstation-local staging directory…";renderRecovery(model);
    try{
      const queued=await api(`/v1/local/workstations/${encodeURIComponent(model.ws.id)}/recovery/snapshots/${encodeURIComponent(model.snapshotId)}/restore`,{method:"POST",body:{path:model.selectedPath??"",previewRunId:model.preview.run.id,confirmation:model.confirmation}});
      const result=await waitRun(model,queued.run.id,serial);
      if(!current(serial))return;
      model.restore=result;
      if(result.run.state!=="completed")throw new Error(result.run.error||"Staging restore failed");
      model.message=`Restore completed safely. Files are under the workstation-local restores/${result.run.id} directory beside its Nexus config; original files were not overwritten.`;
    }catch(error){if(current(serial))model.message=error.message}finally{model.busy=false;if(current(serial))renderRecovery(model)}
  }

  async function waitRun(model,runId,serial){
    for(let attempt=0;attempt<400;attempt++){
      if(!current(serial))throw new Error("Recovery dialog closed");
      const data=await api(`/v1/local/workstations/${encodeURIComponent(model.ws.id)}/recovery/runs/${encodeURIComponent(runId)}`);
      model.run=data.run;renderRecovery(model);
      if(data.run?.terminal)return data;
      await delay(1500);
    }
    throw new Error("Recovery operation is still running; close and reopen Recovery to check it again.");
  }

  function renderRecovery(model,error=false){
    if(!modal)return;const root=modal.querySelector("#ws-recovery-body");if(!root)return;
    const snapshots=model.inventory?.snapshots??[];
    const entries=model.browse?.entries??[];
    const selectedLabel=model.selectedPath===null?"Nothing selected":model.selectedPath===""?"Entire snapshot":model.selectedPath;
    const previewResult=model.preview?.run?.result;
    const restoreResult=model.restore?.run?.result;
    root.innerHTML=`<div class="ws-recovery-safety"><strong>Staging only</strong><span>Nexus never restores in-place. The Windows agent creates a unique local staging directory and uses <code>--overwrite never</code>.</span></div>
      <div class="ws-recovery-status ${error?"error":""}"><span>${esc(model.message)}</span>${model.run?.active?`<small>${esc(model.run.operation)} · ${esc(model.run.state)}${model.run.progress?.phase?` · ${esc(model.run.progress.phase)}`:""}</small>`:""}</div>
      <div class="ws-recovery-grid">
        <section class="ws-recovery-pane"><div class="ws-pane-head"><div><p class="eyebrow">1 · Snapshot</p><h3>Choose recovery point</h3></div><button class="button ghost compact" data-recovery-refresh ${model.busy?"disabled":""}>Refresh snapshots</button></div>
          ${snapshots.length?`<select data-recovery-snapshot ${model.busy?"disabled":""}>${snapshots.map(snapshot=>`<option value="${attr(snapshot.id)}" ${snapshot.id===model.snapshotId?"selected":""}>${esc(formatSnapshot(snapshot))}</option>`).join("")}</select><small class="muted-2">${model.inventory?.scannedAt?`Inventory ${esc(relative(model.inventory.scannedAt))}`:"Cached inventory"}</small>`:'<div class="empty compact"><strong>No snapshots loaded</strong><span>Refresh snapshots while the workstation is online.</span></div>'}
        </section>
        <section class="ws-recovery-pane"><div class="ws-pane-head"><div><p class="eyebrow">2 · Browse</p><h3>${esc(model.currentPath)}</h3></div><div class="flex gap-8"><button class="button ghost compact" data-recovery-up ${model.busy||model.currentPath==="/"?"disabled":""}>Up</button><button class="button ghost compact" data-recovery-reload ${model.busy||!model.snapshotId?"disabled":""}>Reload</button></div></div>
          ${model.snapshotId?`<div class="ws-browser-actions"><button class="button ghost compact" data-recovery-select-root ${model.busy?"disabled":""}>Use entire snapshot</button>${model.currentPath!=="/"?`<button class="button ghost compact" data-recovery-select-current ${model.busy?"disabled":""}>Use this folder</button>`:""}</div><div class="ws-browser">${entries.map(entry=>browserRow(entry,model.selectedPath)).join("")||'<div class="empty compact"><strong>No entries</strong><span>This folder is empty or has not been loaded yet.</span></div>'}</div>`:'<div class="empty compact"><strong>Select a snapshot</strong><span>Its folders will appear here.</span></div>'}
        </section>
      </div>
      <section class="ws-recovery-pane ws-preview-pane"><div class="ws-pane-head"><div><p class="eyebrow">3 · Preview</p><h3>${esc(selectedLabel)}</h3></div><button class="button primary compact" data-recovery-preview ${model.busy||model.selectedPath===null?"disabled":""}>Preview restore</button></div>
        ${previewResult?resultSummary("Dry-run preview",previewResult):'<p class="muted-2">A real Restic dry-run must complete before any write restore can be requested.</p>'}
      </section>
      ${model.preview?.restoreConfirmation?`<section class="ws-recovery-pane ws-write-pane"><div><p class="eyebrow">4 · Staging restore</p><h3>Type the confirmation</h3><p class="muted-2">Type <code>${esc(model.preview.restoreConfirmation)}</code>. This confirmation is tied to the completed preview; the server also re-checks snapshot, path and preview age.</p></div><input data-recovery-confirm autocomplete="off" spellcheck="false" value="${attr(model.confirmation)}" placeholder="${attr(model.preview.restoreConfirmation)}"><button class="button primary" data-recovery-restore ${model.busy||model.confirmation!==model.preview.restoreConfirmation?"disabled":""}>Restore to staging</button>${restoreResult?resultSummary("Staging restore",restoreResult):""}</section>`:""}`;
    bindRecovery(model);
  }

  function bindRecovery(model){
    if(!modal)return;const serial=modalSerial;
    modal.querySelector("[data-recovery-refresh]")?.addEventListener("click",()=>void refreshInventory(model,serial));
    modal.querySelector("[data-recovery-snapshot]")?.addEventListener("change",event=>void selectSnapshot(model,event.target.value,serial));
    modal.querySelector("[data-recovery-up]")?.addEventListener("click",()=>void loadBrowse(model,parentPath(model.currentPath),serial,false));
    modal.querySelector("[data-recovery-reload]")?.addEventListener("click",()=>void loadBrowse(model,model.currentPath,serial,true));
    modal.querySelector("[data-recovery-select-root]")?.addEventListener("click",()=>{model.selectedPath="";model.preview=null;model.restore=null;model.confirmation="";renderRecovery(model)});
    modal.querySelector("[data-recovery-select-current]")?.addEventListener("click",()=>{model.selectedPath=model.currentPath;model.preview=null;model.restore=null;model.confirmation="";renderRecovery(model)});
    modal.querySelectorAll("[data-recovery-entry]").forEach(button=>button.addEventListener("click",()=>{
      const path=button.dataset.path||"";if(button.dataset.kind==="dir"&&button.dataset.action==="open")void loadBrowse(model,path,serial,false);else{model.selectedPath=path;model.preview=null;model.restore=null;model.confirmation="";renderRecovery(model)}
    }));
    modal.querySelector("[data-recovery-preview]")?.addEventListener("click",()=>void previewRestore(model,serial));
    modal.querySelector("[data-recovery-confirm]")?.addEventListener("input",event=>{model.confirmation=event.target.value;const button=modal?.querySelector("[data-recovery-restore]");if(button)button.disabled=model.busy||model.confirmation!==model.preview?.restoreConfirmation});
    modal.querySelector("[data-recovery-restore]")?.addEventListener("click",()=>void executeRestore(model,serial));
  }

  function browserRow(entry,selected){
    const dir=entry.nodeType==="dir";const chosen=selected===entry.path;
    return `<div class="ws-browser-row ${chosen?"selected":""}"><button class="ws-browser-name" data-recovery-entry data-action="${dir?"open":"select"}" data-kind="${dir?"dir":"file"}" data-path="${attr(entry.path)}"><span>${dir?"▸":"·"}</span><strong>${esc(entry.name)}</strong></button><span>${dir?"Folder":bytes(entry.size||0)}</span>${dir?`<button class="button ghost compact" data-recovery-entry data-action="select" data-kind="dir" data-path="${attr(entry.path)}">Select</button>`:`<button class="button ghost compact" data-recovery-entry data-action="select" data-kind="file" data-path="${attr(entry.path)}">${chosen?"Selected":"Select"}</button>`}</div>`;
  }

  function resultSummary(label,result){
    const logs=result.changedLogs??[];
    return `<div class="ws-result"><div><strong>${esc(label)}</strong><span>${Number(result.restored||0)} restored · ${Number(result.updated||0)} updated · ${Number(result.unchanged||0)} unchanged</span></div>${logs.length?`<details><summary>Changed files (${logs.length}${result.changedLogsTruncated?"+":""})</summary><pre>${esc(logs.join("\n"))}</pre></details>`:""}</div>`;
  }

  function closeRecovery(){modalSerial++;modal?.remove();modal=null}
  function current(serial){return Boolean(modal&&modal.isConnected&&serial===modalSerial)}
  function parentPath(path){if(!path||path==="/")return"/";const clean=path.replace(/\/+$/,"");const index=clean.lastIndexOf("/");return index<=0?"/":clean.slice(0,index)}
  function formatSnapshot(snapshot){const when=snapshot.time?new Date(snapshot.time).toLocaleString():"Unknown time";return `${when} · ${snapshot.shortId||String(snapshot.id).slice(0,12)}${snapshot.hostname?` · ${snapshot.hostname}`:""}`}
  function relative(value){const ms=Date.now()-new Date(value).getTime();if(!Number.isFinite(ms))return"—";const sec=Math.round(Math.abs(ms)/1000);const future=ms<0;if(sec<60)return future?"in <1m":"just now";const min=Math.round(sec/60);if(min<60)return future?`in ${min}m`:`${min}m ago`;const hr=Math.round(min/60);if(hr<48)return future?`in ${hr}h`:`${hr}h ago`;const day=Math.round(hr/24);return future?`in ${day}d`:`${day}d ago`}
  function bytes(value){const n=Number(value)||0;if(n<1024)return`${n} B`;const units=["KiB","MiB","GiB","TiB"];let v=n/1024,i=0;while(v>=1024&&i<units.length-1){v/=1024;i++}return`${v>=10?v.toFixed(0):v.toFixed(1)} ${units[i]}`}
  function delay(ms){return new Promise(resolve=>setTimeout(resolve,ms))}
  async function api(url,{method="GET",body}={}){const response=await fetch(url,{method,headers:{accept:"application/json",...(body!==undefined?{"content-type":"application/json"}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.message||`${method} ${url} failed (${response.status})`);return data}
  function esc(value){return String(value??"").replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[char]))}
  function attr(value){return esc(value).replace(/`/g,"&#096;")}
}

function injectWorkstationRecoveryStyles(){
  const style=document.createElement("style");style.id="workstation-recovery-styles";style.textContent=`
    .ws-recovery-backdrop{z-index:80}.ws-recovery-modal{width:min(1100px,calc(100vw - 32px));max-width:1100px;max-height:calc(100vh - 32px);overflow:auto}.ws-recovery-safety{display:flex;gap:12px;align-items:flex-start;padding:12px 14px;margin-bottom:12px;border:1px solid var(--border,#2b3442);border-radius:10px;background:var(--surface-2,#111721)}.ws-recovery-safety strong{white-space:nowrap}.ws-recovery-safety span{color:var(--muted,#9aa5b5)}.ws-recovery-status{display:flex;justify-content:space-between;gap:12px;padding:10px 12px;margin-bottom:14px;border-radius:8px;background:var(--surface-3,#202735)}.ws-recovery-status.error{outline:1px solid var(--danger,#e35d6a)}.ws-recovery-status small{color:var(--muted,#9aa5b5)}.ws-recovery-grid{display:grid;grid-template-columns:minmax(260px,.75fr) minmax(360px,1.25fr);gap:14px}.ws-recovery-pane{border:1px solid var(--border,#2b3442);border-radius:12px;padding:14px;background:var(--surface-1,#151b25)}.ws-pane-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:12px}.ws-pane-head h3{margin:2px 0 0;overflow-wrap:anywhere}.ws-recovery-pane select{width:100%}.ws-browser-actions{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px}.ws-browser{border:1px solid var(--border,#2b3442);border-radius:9px;max-height:340px;overflow:auto}.ws-browser-row{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:8px;align-items:center;padding:7px 8px;border-bottom:1px solid var(--border,#2b3442)}.ws-browser-row:last-child{border-bottom:0}.ws-browser-row.selected{background:var(--surface-3,#202735)}.ws-browser-name{display:flex;align-items:center;gap:8px;min-width:0;border:0;background:none;color:inherit;text-align:left;padding:5px;cursor:pointer}.ws-browser-name strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ws-browser-row>span{font-size:12px;color:var(--muted,#9aa5b5)}.ws-preview-pane,.ws-write-pane{margin-top:14px}.ws-write-pane{display:grid;grid-template-columns:minmax(0,1fr) minmax(220px,.45fr) auto;gap:12px;align-items:end}.ws-write-pane .ws-result{grid-column:1/-1}.ws-result{margin-top:10px;padding:10px 12px;border-radius:9px;background:var(--surface-2,#111721)}.ws-result>div{display:flex;justify-content:space-between;gap:12px}.ws-result span{color:var(--muted,#9aa5b5)}.ws-result pre{white-space:pre-wrap;word-break:break-word;max-height:220px;overflow:auto}.empty.compact{padding:18px}.workstation-card [data-ws-recovery]:disabled{opacity:.5}@media(max-width:760px){.ws-recovery-grid{grid-template-columns:1fr}.ws-write-pane{grid-template-columns:1fr}.ws-browser-row{grid-template-columns:minmax(0,1fr) auto}.ws-browser-row>span{display:none}.ws-recovery-status{flex-direction:column}.ws-result>div{flex-direction:column}}
  `;document.head.append(style);
}
