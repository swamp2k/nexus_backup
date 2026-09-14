const content=document.querySelector("#content");
let current=null;
let loading=false;

window.addEventListener("hashchange",activate);
new MutationObserver(()=>{if(active()&&!content.querySelector("#repository-exposure-settings"))queueMicrotask(render)}).observe(content,{childList:true});
activate();

function active(){return(location.hash.replace(/^#/,"")||"overview")==="settings"}
function activate(){if(active())void refresh(true)}

async function refresh(quiet=false){
  if(loading)return;loading=true;
  try{
    const response=await fetch("/v1/local/repository-settings",{headers:{accept:"application/json"},cache:"no-store"});
    const data=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(data.message||`Repository settings request failed (${response.status})`);
    current=data;render();
  }catch(error){if(!quiet)toast("Repository settings failed",error.message,true)}
  finally{loading=false;}
}

function render(){
  if(!active()||!current)return;
  let host=document.querySelector("#repository-exposure-settings");
  if(!host){host=document.createElement("section");host.id="repository-exposure-settings";host.className="card card-pad section-gap";content.append(host);}
  const c=current.configured||{};
  const a=current.active;
  const p=current.protections||{};
  const endpoint=c.host?`https://${c.host}:${c.endpointPort||c.listenPort}`:"Not configured";
  const internet=c.exposure==="internet";
  host.innerHTML=`
    <div class="flex items-center justify-between gap-8">
      <div><p class="eyebrow">Workstation Repository</p><h2>Network & protection</h2><p class="muted small">Expose Restic directly over HTTPS. No VPN or cloud data proxy is required.</p></div>
      ${badge(internet?"Internet":"LAN",internet?"warn":"success")}
    </div>
    ${current.restartRequired?'<div class="repo-settings-banner">Saved settings differ from the running Repository. Restart <strong>NexusBackup</strong> from Unraid to apply them.</div>':""}
    <form id="repository-settings-form" class="repo-settings-form mt-16">
      <label><span>Exposure</span><select name="exposure"><option value="lan" ${c.exposure==="lan"?"selected":""}>LAN only</option><option value="internet" ${internet?"selected":""}>Direct Internet</option></select><small>Internet mode is for remote PCs reaching this Restic endpoint through your router/firewall.</small></label>
      <label><span>Endpoint hostname / IP</span><input name="host" required value="${attr(c.host||"")}" placeholder="backup.example.com"><small>This exact identity is pinned into the Repository TLS certificate.</small></label>
      <div class="repo-settings-columns"><label><span>Local listen port</span><input name="listenPort" type="number" min="1" max="65535" required value="${attr(c.listenPort||8000)}"><small>Port on Tower.</small></label><label><span>Advertised endpoint port</span><input name="endpointPort" type="number" min="1" max="65535" required value="${attr(c.endpointPort||c.listenPort||8000)}"><small>May be 443 while router forwards to local 8000.</small></label></div>
      <label class="repo-settings-toggle"><input name="appendOnly" type="checkbox" ${c.appendOnly?"checked":""}><span><strong>Append-only Repository</strong><small>Recommended for Internet exposure. Workstations can add backups but cannot delete or modify existing repository objects through the REST endpoint.</small></span></label>
      <div class="repo-settings-endpoint"><span>Advertised Restic endpoint</span><code>${esc(endpoint)}</code></div>
      <div class="modal-actions"><button type="button" class="button ghost" data-repo-refresh>Reload</button><button type="submit" class="button primary">Save Repository settings</button></div>
    </form>
    <div class="repo-protection-grid mt-16">
      ${protection("TLS",p.tls?`TLS ${esc(p.tlsMinVersion||"1.3")} minimum`:"Off",Boolean(p.tls))}
      ${protection("Authentication",p.bcryptAuth?"bcrypt per workstation":"Off",Boolean(p.bcryptAuth))}
      ${protection("Private namespaces",p.privateRepositories?"Enabled":"Off",Boolean(p.privateRepositories))}
      ${protection("Append-only",c.appendOnly?"Enabled":"Disabled",Boolean(c.appendOnly))}
      ${protection("Rate limit",p.rateLimit?"Enabled":"Not built in yet",false)}
      ${protection("Brute-force lockout",p.bruteForceLockout?"Enabled":"Not built in yet",false)}
    </div>
    ${internet?'<div class="transfer-note mt-16"><strong>Router/firewall required:</strong> forward only the advertised Repository port to the local Repository listen port. Do not expose the Nexus Control UI just because Repository is Internet-facing.</div>':""}
    ${a?`<p class="muted small mt-16">Running now: ${esc(a.exposure)} · ${esc(a.host)}:${esc(a.endpointPort)} · append-only ${a.appendOnly?"on":"off"}</p>`:""}
  `;
  injectStyles();
  host.querySelector("#repository-settings-form")?.addEventListener("submit",save);
  host.querySelector("[data-repo-refresh]")?.addEventListener("click",()=>void refresh(false));
  const exposure=host.querySelector('[name="exposure"]');
  const appendOnly=host.querySelector('[name="appendOnly"]');
  exposure?.addEventListener("change",()=>{if(exposure.value==="internet"&&!appendOnly.checked)appendOnly.checked=true;});
}

async function save(event){
  event.preventDefault();
  const form=event.currentTarget;
  const button=form.querySelector('button[type="submit"]');
  button.disabled=true;button.textContent="Saving…";
  try{
    const body={
      exposure:form.elements.exposure.value,
      host:form.elements.host.value.trim(),
      listenPort:Number(form.elements.listenPort.value),
      endpointPort:Number(form.elements.endpointPort.value),
      appendOnly:form.elements.appendOnly.checked,
    };
    const response=await fetch("/v1/local/repository-settings",{method:"PUT",headers:{"content-type":"application/json",accept:"application/json"},body:JSON.stringify(body)});
    const data=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(data.message||`Repository settings save failed (${response.status})`);
    current=data;render();toast("Repository settings saved",data.restartRequired?"Restart NexusBackup to apply the new listener/TLS policy.":"Repository is already using these settings.");
  }catch(error){toast("Repository settings failed",error.message,true)}
  finally{button.disabled=false;button.textContent="Save Repository settings";}
}

function protection(label,value,on){return`<div class="status-row"><div><strong>${esc(label)}</strong><span>${esc(value)}</span></div><span class="status-indicator ${on?"":"off"}"></span></div>`}
function badge(text,tone=""){return`<span class="badge ${tone}">${esc(text)}</span>`}
function esc(value){return String(value??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
function attr(value){return esc(value).replace(/`/g,"&#96;")}
function toast(title,message,danger=false){
  const stack=document.querySelector("#toast-stack");if(!stack)return;
  const node=document.createElement("div");node.className=`toast${danger?" danger":""}`;node.innerHTML=`<strong>${esc(title)}</strong><span>${esc(message)}</span>`;stack.append(node);setTimeout(()=>node.remove(),5000);
}
function injectStyles(){
  if(document.querySelector("#repository-settings-styles"))return;
  const style=document.createElement("style");style.id="repository-settings-styles";style.textContent=`
    .repo-settings-form{display:grid;gap:14px}.repo-settings-form label{display:grid;gap:6px}.repo-settings-form label>span{font-weight:650}.repo-settings-form small{color:var(--muted);line-height:1.4}.repo-settings-columns{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.repo-settings-toggle{display:flex!important;grid-template-columns:none!important;align-items:flex-start;gap:10px!important;padding:12px;border:1px solid var(--border);border-radius:12px}.repo-settings-toggle input{margin-top:3px}.repo-settings-toggle span{display:grid;gap:3px}.repo-settings-endpoint{display:grid;gap:6px;padding:12px;border-radius:12px;background:var(--surface-2)}.repo-settings-endpoint span{font-size:12px;color:var(--muted)}.repo-settings-endpoint code{overflow-wrap:anywhere}.repo-settings-banner{margin-top:14px;padding:11px 13px;border:1px solid var(--warn);border-radius:12px}.repo-protection-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}@media(max-width:760px){.repo-settings-columns,.repo-protection-grid{grid-template-columns:1fr}}
  `;document.head.append(style);
}
