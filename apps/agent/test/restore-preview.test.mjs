import assert from "node:assert/strict";
import test from "node:test";
import {
  ResticBrowseExecutor,
  ResticRestorePreviewExecutor,
  StaticAgentRuntimeConfig,
} from "../dist/index.js";

const SNAPSHOT="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function job(type,payload){
  return {id:`job-${type}`,operationKey:`op-${type}`,type,state:"running",attempt:1,revision:1,payload,lease:null,createdAt:"2026-09-12T10:00:00.000Z",updatedAt:"2026-09-12T10:00:00.000Z",startedAt:"2026-09-12T10:00:00.000Z",finishedAt:null,lastError:null};
}

function config(){
  return new StaticAgentRuntimeConfig({
    resticRepositories:[{id:"repo-main",repository:"/backup/restic/main",passwordFile:"/config/secrets/restic",environment:{RESTIC_CACHE_DIR:"/state/cache"}}],
    restoreTargets:[{id:"restore-staging",label:"Restore staging",path:"/restore",overwrite:"never"}],
    tools:{resticBinary:"/usr/local/bin/restic"},
  });
}

class SequenceRunner{
  constructor(steps){this.steps=[...steps];this.calls=[];}
  async run(spec,_signal,handlers={}){
    this.calls.push(spec);
    const step=this.steps.shift();
    if(!step)throw new Error("unexpected command");
    for(const line of step.stdout??[])handlers.stdout?.(line);
    for(const line of step.stderr??[])handlers.stderr?.(line);
    return step.result??{exitCode:0,signal:null,durationMs:5,stdoutTail:"",stderrTail:""};
  }
}

test("snapshot browser uses non-recursive read-only restic ls",async()=>{
  const runner=new SequenceRunner([{stdout:[
    JSON.stringify({message_type:"snapshot",id:SNAPSHOT}),
    JSON.stringify({message_type:"node",name:"beta.txt",type:"file",path:"/data/beta.txt",size:42,mtime:"2026-09-12T09:00:00Z",permissions:"-rw-r--r--"}),
    JSON.stringify({struct_type:"node",name:"alpha",type:"dir",path:"/data/alpha",mtime:"2026-09-12T08:00:00Z",permissions:"drwxr-xr-x"}),
  ]}]);
  const events=[];
  const executor=new ResticBrowseExecutor(config(),runner,{emit:event=>events.push(event)});
  const result=await executor.execute(job("restic-browse",{repositoryId:"repo-main",snapshotId:SNAPSHOT,path:"/data"}),new AbortController().signal);

  assert.equal(result.status,"completed");
  assert.deepEqual(runner.calls[0].args,["ls","--json",SNAPSHOT,"/data"]);
  assert.equal(runner.calls[0].args.includes("--recursive"),false);
  assert.equal(runner.calls[0].env.RESTIC_REPOSITORY,"/backup/restic/main");
  const browse=events.find(event=>event.type==="snapshot-browse");
  assert.ok(browse);
  assert.equal(browse.repositoryId,"repo-main");
  assert.equal(browse.snapshotId,SNAPSHOT);
  assert.equal(browse.path,"/data");
  assert.deepEqual(browse.entries.map(entry=>[entry.nodeType,entry.path]),[["dir","/data/alpha"],["file","/data/beta.txt"]]);
  assert.equal(browse.truncated,false);
});

test("restore preview is hard-coded dry-run and resolves target path locally",async()=>{
  const runner=new SequenceRunner([{stdout:[
    "restored  /data/new.txt with size 10 B",
    "updated   /data/changed.txt with size 20 B",
    "unchanged /data/same.txt with size 30 B",
    "Summary: Restored 3 files/dirs (60 B) in 0:00",
  ]}]);
  const events=[];
  const executor=new ResticRestorePreviewExecutor(config(),runner,{emit:event=>events.push(event)});
  const result=await executor.execute(job("restic-restore-preview",{
    repositoryId:"repo-main",
    snapshotId:SNAPSHOT,
    targetId:"restore-staging",
    path:"/data",
  }),new AbortController().signal);

  assert.equal(result.status,"completed");
  const args=runner.calls[0].args;
  assert.equal(args[0],"restore");
  assert.ok(args.includes("--dry-run"));
  assert.ok(args.includes("--verbose=2"));
  assert.deepEqual(args.slice(args.indexOf("--target"),args.indexOf("--target")+2),["--target","/restore"]);
  assert.deepEqual(args.slice(args.indexOf("--overwrite"),args.indexOf("--overwrite")+2),["--overwrite","never"]);
  assert.deepEqual(args.slice(args.indexOf("--include"),args.indexOf("--include")+2),["--include","/data"]);
  assert.equal(args.includes("--delete"),false);
  const summary=events.find(event=>event.type==="summary");
  assert.ok(summary);
  assert.deepEqual({restored:summary.data.restored,updated:summary.data.updated,unchanged:summary.data.unchanged,dryRun:summary.data.dryRun},{restored:1,updated:1,unchanged:1,dryRun:true});
  assert.equal(summary.data.targetId,"restore-staging");
  assert.equal(JSON.stringify(summary.data).includes("/restore"),false);
});

test("restore preview cannot accept a raw target path in place of a configured target",async()=>{
  const runner=new SequenceRunner([]);
  const executor=new ResticRestorePreviewExecutor(config(),runner);
  await assert.rejects(()=>executor.execute(job("restic-restore-preview",{
    repositoryId:"repo-main",
    snapshotId:SNAPSHOT,
    targetId:"/tmp/attacker-controlled",
  }),new AbortController().signal),/Unknown restore target/);
  assert.equal(runner.calls.length,0);
});
