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
  if(!actions||actions.querySelector("[data-logout]"))return;
  const button=document.createElement("button");
  button.className="button ghost";button.dataset.logout="";button.textContent="Log out";
  button.addEventListener("click",()=>void window.nexusAuth.logout());
  actions.prepend(button);
}).catch(()=>{});
