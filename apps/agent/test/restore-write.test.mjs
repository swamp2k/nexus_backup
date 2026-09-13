import assert from "node:assert/strict";
import test from "node:test";
import { ResticRestoreExecutor, StaticAgentRuntimeConfig } from "../dist/index.js";

const SNAPSHOT="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
function job(targetId="restore-staging",attempt=1){return{id:"job-restore",operationKey:"op-restore",type:"restic-restore",state:"running",attempt,revision:1,payload:{repositoryId:"repo-main",snapshotId:SNAPSHOT,targetId,path:"/data"},lease:null,createdAt:"2026-09-12T10:00:00Z",updatedAt:"2026-09-12T10:00:00Z",startedAt:"2026-09-12T10:00:00Z",finishedAt:null,lastError:null}}
function config(allowWrite=true){return new StaticAgentRuntimeConfig({resticRepositories:[{id:"repo-main",repository:"/backup/main",passwordFile:"/config/pw"}],restoreTargets:[{id:"restore-staging",path:"/restore",overwrite:"never",allowWrite}],tools:{resticBinary:"restic"}})}
class Runner{constructor(){this.calls=[]}async run(spec,_signal,handlers={}){this.calls.push(spec);for(const line of["restored /data/a.txt","updated /data/b.txt","unchanged /data/c.txt"])handlers.stdout?.(line);return{exitCode:0,signal:null,durationMs:5,stdoutTail:"",stderrTail:""}}}
function stagingAllocator(calls=[]){return async(root,id,attempt)=>{calls.push({root,id,attempt});return`${root}/.nexus-backup-write-${id}-a${attempt}`;}}

test("write restore allocates a fresh local staging target and never overwrites or deletes",async()=>{
  const runner=new Runner(),events=[],allocations=[];
  const result=await new ResticRestoreExecutor(config(true),runner,{emit:event=>events.push(event)},stagingAllocator(allocations)).execute(job(),new AbortController().signal);
  assert.equal(result.status,"completed");
  assert.deepEqual(allocations,[{root:"/restore",id:"job-restore",attempt:1}]);
  const args=runner.calls[0].args;
  assert.equal(args[0],"restore");
  assert.deepEqual(args.slice(args.indexOf("--target"),args.indexOf("--target")+2),["--target","/restore/.nexus-backup-write-job-restore-a1"]);
  assert.deepEqual(args.slice(args.indexOf("--overwrite"),args.indexOf("--overwrite")+2),["--overwrite","never"]);
  assert.deepEqual(args.slice(args.indexOf("--include"),args.indexOf("--include")+2),["--include","/data"]);
  assert.equal(args.includes("--dry-run"),false);
  assert.equal(args.includes("--delete"),false);
  const summary=events.find(event=>event.type==="summary");
  assert.equal(summary.data.dryRun,false);
  assert.equal(summary.data.overwrite,"never");
  assert.equal(summary.data.staging,true);
  assert.deepEqual([summary.data.restored,summary.data.updated,summary.data.unchanged],[1,1,1]);
  assert.equal(JSON.stringify(summary.data).includes("/restore"),false);
});

test("write restore is rejected unless the local target explicitly opts in",async()=>{
  const runner=new Runner(),allocations=[];
  await assert.rejects(()=>new ResticRestoreExecutor(config(false),runner,undefined,stagingAllocator(allocations)).execute(job(),new AbortController().signal),/not write-enabled/);
  assert.equal(runner.calls.length,0);
  assert.equal(allocations.length,0);
});

test("write restore cannot use a raw target path as a target id",async()=>{
  const runner=new Runner(),allocations=[];
  await assert.rejects(()=>new ResticRestoreExecutor(config(true),runner,undefined,stagingAllocator(allocations)).execute(job("/tmp/raw"),new AbortController().signal),/Unknown restore target/);
  assert.equal(runner.calls.length,0);
  assert.equal(allocations.length,0);
});

test("restore target config rejects overwrite modes other than never",()=>{
  assert.throws(()=>new StaticAgentRuntimeConfig({restoreTargets:[{id:"unsafe",path:"/restore",overwrite:"always",allowWrite:true}]}),/overwrite=never/);
});
