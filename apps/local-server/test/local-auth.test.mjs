import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { confirmationPhrase, createLocalAuth } from "../lib/local-auth.mjs";

function request({cookie,csrf,remote="127.0.0.1"}={}){return{headers:{...(cookie?{cookie}:{}),...(csrf?{"x-nexus-csrf":csrf}:{})},socket:{remoteAddress:remote,encrypted:false}}}
function response(){const headers=new Map();return{headers,setHeader(name,value){headers.set(name.toLowerCase(),value)}}}
function cookieFrom(response){return String(response.headers.get("set-cookie")).split(";")[0]}

test("first-run setup creates a local admin and authenticated csrf session",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"nexus-auth-"));const logs=[];
  try{
    const auth=await createLocalAuth({configDir:dir,log:(level,message,data)=>logs.push({level,message,data})});
    assert.equal(auth.status(request()).configured,false);
    const token=logs.find(item=>item.message==="local admin setup required").data.setupToken;
    const out=response();const session=await auth.setup({setupToken:token,password:"correct horse battery staple",request:request(),response:out});
    assert.equal(session.authenticated,true);assert.ok(session.csrfToken);
    const req=request({cookie:cookieFrom(out),csrf:session.csrfToken});
    assert.equal(auth.requireSession(req).csrfToken,session.csrfToken);
    assert.doesNotThrow(()=>auth.requireCsrf(req,auth.requireSession(req)));
    assert.throws(()=>auth.requireCsrf(request({cookie:cookieFrom(out),csrf:"wrong"}),auth.requireSession(req)),/Invalid CSRF/);
  }finally{await rm(dir,{recursive:true,force:true})}
});

test("restore authorization grants are exact-scope and single-use",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"nexus-auth-grant-"));const logs=[];
  try{
    const auth=await createLocalAuth({configDir:dir,log:(level,message,data)=>logs.push({level,message,data})});
    const token=logs[0].data.setupToken;const out=response();const login=await auth.setup({setupToken:token,password:"correct horse battery staple",request:request(),response:out});
    const session=auth.requireSession(request({cookie:cookieFrom(out)}));
    const scope={repositoryId:"repo",snapshotId:"aaaaaaaaaaaaaaaa",targetId:"restore-staging",path:"/data"};
    const grant=auth.issueRestoreGrant(session,scope);
    assert.doesNotThrow(()=>auth.consumeRestoreGrant(session,grant.token,scope));
    assert.throws(()=>auth.consumeRestoreGrant(session,grant.token,scope),/invalid or expired/);
    const other=auth.issueRestoreGrant(session,scope);
    assert.throws(()=>auth.consumeRestoreGrant(session,other.token,{...scope,path:"/other"}),/does not match/);
    assert.equal(confirmationPhrase(scope),"RESTORE AAAAAAAA TO restore-staging");
    assert.ok(login.csrfToken);
  }finally{await rm(dir,{recursive:true,force:true})}
});

test("invalid login attempts are rate limited",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"nexus-auth-rate-"));const logs=[];
  try{
    const auth=await createLocalAuth({configDir:dir,log:(level,message,data)=>logs.push({level,message,data})});
    await auth.setup({setupToken:logs[0].data.setupToken,password:"correct horse battery staple",request:request(),response:response()});
    for(let i=0;i<5;i++)await assert.rejects(()=>auth.login({password:"wrong-password-value",request:request({remote:"10.0.0.7"}),response:response()}),/Invalid password/);
    await assert.rejects(()=>auth.login({password:"correct horse battery staple",request:request({remote:"10.0.0.7"}),response:response()}),error=>error.statusCode===429);
  }finally{await rm(dir,{recursive:true,force:true})}
});
