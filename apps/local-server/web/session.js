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
