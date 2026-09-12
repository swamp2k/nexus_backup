const form=document.querySelector("#auth-form");
const title=document.querySelector("#auth-title");
const copy=document.querySelector("#auth-copy");
const note=document.querySelector("#auth-note");
const errorBox=document.querySelector("#auth-error");
const setupField=document.querySelector("#setup-token-field");
const confirmField=document.querySelector("#confirm-field");
const password=document.querySelector("#password");
const confirmPassword=document.querySelector("#confirm-password");
const setupToken=document.querySelector("#setup-token");
const submit=document.querySelector("#submit-button");
let mode="login";

void init();

async function init(){
  try{
    const status=await api("/v1/local/auth/status");
    if(status.authenticated){location.replace("/");return}
    mode=status.configured?"login":"setup";
    if(mode==="setup"){
      title.textContent="Create local admin";
      copy.textContent="First-run setup. Enter the setup token from the Nexus Backup control-container log, then choose a local password.";
      note.textContent="The setup token is invalidated immediately after setup. The password hash stays in /config/auth.json.";
      setupField.classList.remove("hidden");
      confirmField.classList.remove("hidden");
      password.autocomplete="new-password";
      submit.textContent="Create admin";
    }else{
      title.textContent="Welcome back";
      copy.textContent="Sign in to the local Nexus Backup control plane.";
      submit.textContent="Sign in";
    }
    form.classList.remove("hidden");
    (mode==="setup"?setupToken:password).focus();
  }catch(error){showError(error.message)}
}

form.addEventListener("submit",async event=>{
  event.preventDefault();hideError();submit.disabled=true;submit.textContent=mode==="setup"?"Creating…":"Signing in…";
  try{
    if(mode==="setup"){
      if(password.value!==confirmPassword.value)throw new Error("Passwords do not match");
      await api("/v1/local/auth/setup",{method:"POST",body:{setupToken:setupToken.value,password:password.value}});
    }else{
      await api("/v1/local/auth/login",{method:"POST",body:{password:password.value}});
    }
    location.replace("/");
  }catch(error){showError(error.message);submit.disabled=false;submit.textContent=mode==="setup"?"Create admin":"Sign in"}
});

async function api(path,options={}){
  const init={method:options.method||"GET",headers:{accept:"application/json"},cache:"no-store"};
  if(options.body!==undefined){init.headers["content-type"]="application/json";init.body=JSON.stringify(options.body)}
  const response=await fetch(path,init);const data=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(data.message||`${response.status} ${response.statusText}`);return data;
}
function showError(message){errorBox.textContent=message;errorBox.classList.remove("hidden")}
function hideError(){errorBox.textContent="";errorBox.classList.add("hidden")}
