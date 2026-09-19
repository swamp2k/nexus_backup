const content=document.querySelector("#content"),title=document.querySelector("#page-title"),eyebrow=document.querySelector("#page-eyebrow"),newButton=document.querySelector("#new-job-button"),refreshButton=document.querySelector("#refresh-button"),toastStack=document.querySelector("#toast-stack");
const sourcesNav=document.querySelector('[data-view="sources"]'),destinationsNav=document.querySelector('[data-view="destinations"]');
let sources=[],destinations=[],providers=null,providersError="",busy=false,modal=null,showAdvanced=false;

sourcesNav?.addEventListener("click",()=>{location.hash="sources";activate()});
destinationsNav?.addEventListener("click",()=>{location.hash="destinations";activate()});
window.addEventListener("hashchange",activate);
newButton?.addEventListener("click",event=>{if(!active())return;event.preventDefault();event.stopImmediatePropagation();if(view()==="sources")openSourceForm();else openDestinationWizard()});
new MutationObserver(()=>{if(active()&&!content.querySelector("#sd-view"))queueMicrotask(render)}).observe(content,{childList:true});
activate();

function view(){return location.hash.replace(/^#/,"")||"overview"}
function active(){return view()==="sources"||view()==="destinations"}
function activate(){
  if(!active())return;
  document.querySelectorAll("[data-view]").forEach(item=>item.classList.toggle("active",item===(view()==="sources"?sourcesNav:destinationsNav)));
  document.querySelector("#transfers-nav")?.classList.remove("active");
  if(title)title.textContent=view()==="sources"?"Sources":"Destinations";
  if(eyebrow)eyebrow.textContent="Local configuration";
  if(newButton){newButton.hidden=false;newButton.textContent=view()==="sources"?"Add source":"Add destination"}
  render();
  void refresh();
}
async function refresh(){
  if(busy)return;busy=true;
  try{
    const [sourceResult,destinationResult]=await Promise.all([api("/v1/local/config/sources"),api("/v1/local/config/destinations")]);
    sources=sourceResult.sources??[];destinations=destinationResult.destinations??[];
    render();
  }catch(error){toast(`${view()==="sources"?"Sources":"Destinations"} failed`,error.message,true)}
  finally{busy=false}
}
function render(){
  if(!active())return;
  content.innerHTML=view()==="sources"?renderSourcesView():renderDestinationsView();
  bind();
}
function renderSourcesView(){
  return `<div id="sd-view"><section class="card card-pad"><div class="flex items-center justify-between gap-8"><div><p class="eyebrow">Local configuration</p><h2>Sources</h2><p class="muted small">Named groups of local paths that Transfer rules can read from.</p></div>${badge(`${sources.length} configured`,sources.length?"success":"warn")}</div><div class="entity-grid mt-16">${sources.map(sourceCard).join("")||empty("No sources configured","Add a source to make its paths available to Transfer rules.")}</div></section></div>`;
}
function sourceCard(source){
  return `<article class="entity-card"><div class="entity-meta"><strong>${esc(source.id)}</strong><p>${source.paths.length} path${source.paths.length===1?"":"s"}</p>${source.paths.map(path=>`<code>${esc(path)}</code>`).join("")}</div><div style="display:flex;flex-direction:column;gap:6px;"><button type="button" class="button ghost compact" data-edit-source="${attr(source.id)}">Edit</button><button type="button" class="button ghost compact" style="color:var(--danger);border-color:color-mix(in srgb,var(--danger) 35%,var(--border));" data-delete-source="${attr(source.id)}">Delete</button></div></article>`;
}
function renderDestinationsView(){
  return `<div id="sd-view"><section class="card card-pad"><div class="flex items-center justify-between gap-8"><div><p class="eyebrow">Local configuration</p><h2>Destinations</h2><p class="muted small">rclone remotes that Transfer rules can copy to or from. Credentials stay on the appliance; the dashboard never sees them again after saving.</p></div>${badge(`${destinations.length} configured`,destinations.length?"success":"warn")}</div><div class="entity-grid mt-16">${destinations.map(destinationCard).join("")||empty("No destinations configured","Add a destination to give Transfer rules somewhere to copy to.")}</div></section></div>`;
}
function destinationCard(destination){
  return `<article class="entity-card"><div class="entity-meta"><strong>${esc(destination.id)}</strong><p>${esc(destination.summary)}</p><p>${destination.allowMove?"Move allowed by local policy":"Copy-only local policy"}</p></div><div style="display:flex;flex-direction:column;gap:6px;"><button type="button" class="button ghost compact" data-edit-destination="${attr(destination.id)}">Edit</button><button type="button" class="button ghost compact" style="color:var(--danger);border-color:color-mix(in srgb,var(--danger) 35%,var(--border));" data-delete-destination="${attr(destination.id)}">Delete</button></div></article>`;
}
function bind(){
  content.querySelectorAll("[data-edit-source]").forEach(button=>button.addEventListener("click",()=>openSourceForm(sources.find(item=>item.id===button.dataset.editSource))));
  content.querySelectorAll("[data-delete-source]").forEach(button=>button.addEventListener("click",async()=>{
    if(!confirm(`Delete source ${button.dataset.deleteSource}? Transfer rules referencing it will need a new source.`))return;
    try{await api(`/v1/local/config/sources/${encodeURIComponent(button.dataset.deleteSource)}`,{method:"DELETE"});toast("Source deleted",button.dataset.deleteSource);await refresh()}
    catch(error){toast("Could not delete source",error.message,true)}
  }));
  content.querySelectorAll("[data-edit-destination]").forEach(button=>button.addEventListener("click",()=>openDestinationWizard(destinations.find(item=>item.id===button.dataset.editDestination))));
  content.querySelectorAll("[data-delete-destination]").forEach(button=>button.addEventListener("click",async()=>{
    if(!confirm(`Delete destination ${button.dataset.deleteDestination}? Transfer rules referencing it will stop working.`))return;
    try{await api(`/v1/local/config/destinations/${encodeURIComponent(button.dataset.deleteDestination)}`,{method:"DELETE"});toast("Destination deleted",button.dataset.deleteDestination);await refresh()}
    catch(error){toast("Could not delete destination",error.message,true)}
  }));
}

/* Sources: a name plus a list of local paths ----------------------------- */
function openSourceForm(source){
  closeModal();
  const editing=Boolean(source);
  modal=document.createElement("div");modal.className="modal-backdrop";modal.id="sd-modal";
  modal.innerHTML=`<section class="modal"><div class="modal-header"><h2>${editing?`Edit ${esc(source.id)}`:"Add source"}</h2><button class="icon-button" data-close>×</button></div><form><label><span>Name</span><input name="id" required maxlength="64" pattern="[A-Za-z0-9][A-Za-z0-9._-]*" value="${attr(source?.id||"")}" ${editing?"readonly":""} placeholder="documents"></label><label><span>Paths <small>one per line</small></span><textarea name="paths" rows="5" required placeholder="C:\\Users\\swamp\\Documents">${esc((source?.paths||[]).join("\n"))}</textarea></label><div class="modal-actions"><button type="button" class="button ghost" data-close>Cancel</button><button type="submit" class="button primary">Save</button></div></form></section>`;
  document.body.append(modal);
  modal.querySelectorAll("[data-close]").forEach(item=>item.addEventListener("click",closeModal));
  modal.querySelector("form").addEventListener("submit",async event=>{
    event.preventDefault();
    const data=new FormData(event.currentTarget);
    const paths=String(data.get("paths")||"").split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
    try{
      if(editing)await api(`/v1/local/config/sources/${encodeURIComponent(source.id)}`,{method:"PUT",body:{paths}});
      else await api("/v1/local/config/sources",{method:"POST",body:{id:String(data.get("id")||"").trim(),paths}});
      toast(editing?"Source updated":"Source created",String(data.get("id")||"").trim());
      closeModal();await refresh();
    }catch(error){toast("Could not save source",error.message,true)}
  });
}

/* Destinations: pick an rclone provider type, fill its fields, test, save */
async function openDestinationWizard(destination){
  closeModal();
  showAdvanced=false;
  const editing=Boolean(destination);
  modal=document.createElement("div");modal.className="modal-backdrop";modal.id="sd-modal";
  modal.innerHTML=`<section class="modal w-lg"><div class="modal-header"><h2>${editing?`Edit ${esc(destination.id)}`:"Add destination"}</h2><button class="icon-button" data-close>×</button></div><div data-wizard-body style="padding:0 20px 20px"><p class="muted-2">Loading rclone provider list…</p></div></section>`;
  document.body.append(modal);
  modal.querySelectorAll("[data-close]").forEach(item=>item.addEventListener("click",closeModal));
  try{
    if(!providers){const result=await api("/v1/local/config/rclone-providers");providers=result.providers??[]}
    providersError="";
  }catch(error){providersError=error.message}
  if(editing)renderDestinationEditForm(destination);
  else renderProviderPicker("");
}
function renderProviderPicker(filterText){
  const body=modal.querySelector("[data-wizard-body]");
  if(providersError){
    body.innerHTML=`<p class="muted-2">Could not load rclone's provider list: ${esc(providersError)}</p>`;return;
  }
  const filtered=providers.filter(provider=>!filterText||provider.Name.toLowerCase().includes(filterText.toLowerCase())||provider.Description?.toLowerCase().includes(filterText.toLowerCase()));
  body.innerHTML=`<label><span>Search remote types</span><input type="text" data-provider-filter placeholder="sftp, s3, ftp, webdav…" value="${attr(filterText)}"></label><div class="stack mt-16" style="max-height:360px;overflow:auto;">${filtered.map(provider=>`<button type="button" class="status-row" style="width:100%;text-align:left;cursor:pointer;" data-pick-provider="${attr(provider.Name)}"><div><strong>${esc(provider.Name)}</strong><span>${esc(provider.Description||"")}</span></div></button>`).join("")||'<p class="muted-2">No matching remote types.</p>'}</div>`;
  body.querySelector("[data-provider-filter]").addEventListener("input",event=>renderProviderPicker(event.target.value));
  body.querySelectorAll("[data-pick-provider]").forEach(button=>button.addEventListener("click",()=>renderDestinationCreateForm(providers.find(provider=>provider.Name===button.dataset.pickProvider))));
}
function renderDestinationCreateForm(provider){
  const body=modal.querySelector("[data-wizard-body]");
  const options=visibleOptions(provider);
  body.innerHTML=`<p class="muted-2"><button type="button" class="button ghost compact" data-back>← Choose a different type</button></p><form data-destination-form><label><span>Name</span><input name="id" required maxlength="64" pattern="[A-Za-z0-9][A-Za-z0-9._-]*" placeholder="seedbox"></label>${optionFields(options)}${advancedToggle(provider)}<label class="enabled-row"><input type="checkbox" name="allowMove"><span>Allow verified move (not just copy)</span></label><div data-test-result></div><div class="modal-actions"><button type="button" class="button ghost" data-test>Test connection</button><button type="button" class="button ghost" data-close>Cancel</button><button type="submit" class="button primary">Save</button></div></form>`;
  wireDestinationForm(body,provider,{editing:false});
  body.querySelector("[data-back]").addEventListener("click",()=>renderProviderPicker(""));
}
function renderDestinationEditForm(destination){
  const body=modal.querySelector("[data-wizard-body]");
  const provider=providers?.find(item=>item.Name===destination.type)||null;
  body.innerHTML=`<form data-destination-form><label><span>Name</span><input value="${attr(destination.id)}" readonly></label><p class="muted-2">${esc(destination.summary)}</p><label class="enabled-row"><input type="checkbox" name="allowMove" ${destination.allowMove?"checked":""}><span>Allow verified move (not just copy)</span></label><details class="mt-16"><summary style="cursor:pointer;color:var(--muted);">Replace credentials</summary><div class="stack mt-16">${provider?optionFields(visibleOptions(provider)):'<p class="muted-2">Original provider type unavailable; re-create this destination to change its connection details.</p>'}${provider?advancedToggle(provider):""}</div></details><div data-test-result></div><div class="modal-actions">${provider?'<button type="button" class="button ghost" data-test>Test connection</button>':""}<button type="button" class="button ghost" data-close>Cancel</button><button type="submit" class="button primary">Save</button></div></form>`;
  wireDestinationForm(body,provider,{editing:true,destination});
}
function wireDestinationForm(body,provider,{editing,destination}){
  const form=body.querySelector("[data-destination-form]");
  body.querySelector("[data-advanced-toggle]")?.addEventListener("click",event=>{showAdvanced=!showAdvanced;event.currentTarget.textContent=showAdvanced?"Hide advanced options":"Show advanced options";body.querySelector("[data-advanced-fields]").hidden=!showAdvanced});
  body.querySelector("[data-test]")?.addEventListener("click",async event=>{
    const params=collectParams(form,provider);
    const resultHost=body.querySelector("[data-test-result]");
    event.currentTarget.disabled=true;resultHost.innerHTML='<p class="muted-2">Testing…</p>';
    try{
      const result=await api("/v1/local/config/destinations/test",{method:"POST",body:{type:provider.Name,params,providerOptions:provider.Options}});
      resultHost.innerHTML=result.ok?'<p class="muted-2" style="color:var(--accent);">Connection succeeded.</p>':`<p class="muted-2" style="color:var(--danger);">${esc(result.message||"Connection failed.")}</p>`;
    }catch(error){resultHost.innerHTML=`<p class="muted-2" style="color:var(--danger);">${esc(error.message)}</p>`}
    finally{event.currentTarget.disabled=false}
  });
  form.addEventListener("submit",async event=>{
    event.preventDefault();
    const data=new FormData(form);
    const allowMove=data.has("allowMove");
    const hasParamInputs=Boolean(provider)&&(!editing||form.querySelector("details[open]"));
    const body={allowMove};
    if(!editing){body.id=String(data.get("id")||"").trim();body.type=provider.Name;body.params=collectParams(form,provider);body.providerOptions=provider.Options}
    else if(hasParamInputs&&formHasAnyValue(form,provider)){body.type=provider.Name;body.params=collectParams(form,provider);body.providerOptions=provider.Options}
    try{
      if(editing)await api(`/v1/local/config/destinations/${encodeURIComponent(destination.id)}`,{method:"PUT",body});
      else await api("/v1/local/config/destinations",{method:"POST",body});
      toast(editing?"Destination updated":"Destination created",editing?destination.id:body.id);
      closeModal();await refresh();
    }catch(error){toast("Could not save destination",error.message,true)}
  });
}
// A checkbox's .value is its static "true" attribute regardless of whether
// it is checked — only .checked reflects the actual state.
function fieldValue(field){return field.type==="checkbox"?(field.checked?"true":""):field.value}
function formHasAnyValue(form,provider){
  return provider.Options.some(option=>{const field=form.elements.namedItem(`param_${option.Name}`);return field&&fieldValue(field)});
}
function collectParams(form,provider){
  const params={};
  for(const option of provider.Options){
    const field=form.elements.namedItem(`param_${option.Name}`);
    const value=field&&fieldValue(field);
    if(value)params[option.Name]=value;
  }
  return params;
}
function visibleOptions(provider){
  return (provider.Options||[]).filter(option=>!option.Hide);
}
function optionFields(options){
  const basic=options.filter(option=>!option.Advanced);
  const advanced=options.filter(option=>option.Advanced);
  return `${basic.map(optionField).join("")}${advanced.length?`<div data-advanced-fields hidden>${advanced.map(optionField).join("")}</div>`:""}`;
}
function advancedToggle(provider){
  return visibleOptions(provider).some(option=>option.Advanced)?'<button type="button" class="button ghost compact" data-advanced-toggle>Show advanced options</button>':"";
}
function optionField(option){
  const type=option.IsPassword?"password":option.Type==="int"?"number":option.Type==="bool"?"checkbox":"text";
  if(type==="checkbox")return `<label class="enabled-row"><input type="checkbox" name="param_${attr(option.Name)}" value="true" ${option.Default===true?"checked":""}><span>${esc(option.Name)}</span></label>`;
  return `<label><span>${esc(option.Name)}${option.Required?" *":""}</span><input type="${type}" name="param_${attr(option.Name)}" placeholder="${attr(option.DefaultStr||"")}" ${option.Required?"required":""}><small>${esc(option.Help||"")}</small></label>`;
}

function closeModal(){modal?.remove();modal=null}
function empty(head,body){return `<div class="empty"><strong>${esc(head)}</strong>${esc(body)}</div>`}
function badge(text,tone=""){return `<span class="badge ${tone}">${esc(text)}</span>`}
function esc(value){return String(value??"").replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[char]))}
function attr(value){return esc(value)}
function toast(head,message="",error=false){const item=document.createElement("div");item.className=`toast${error?" error":""}`;item.innerHTML=`<strong>${esc(head)}</strong>${message?`<div>${esc(message)}</div>`:""}`;toastStack?.append(item);setTimeout(()=>item.remove(),4500)}
async function api(path,{method="GET",body}={}){const response=await fetch(path,{method,headers:{accept:"application/json",...(body===undefined?{}:{"content-type":"application/json"})},body:body===undefined?undefined:JSON.stringify(body),cache:"no-store"});const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.message||`${method} ${path} failed (${response.status})`);return data}
