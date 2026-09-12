import assert from "node:assert/strict";
import test from "node:test";
import { ResticRestoreExecutor, StaticAgentRuntimeConfig } from "../dist/index.js";

const SNAPSHOT="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
function job(targetId="restore-staging"){return{id:"job-restore",operationKey:"op-restore",type:"restic-restore",state:"running",attempt:1,revision:1,payload:{repositoryId:"repo-main",snapshotId:SNAPSHOT,targetId,path:"/data"},lease:null,createdAt:"2026-09-12T10:00:00Z",updatedAt:"2026-09-12T10:00:00Z",startedAt:"2026-09-12T10:00:00Z",finishedAt:null,lastError:null}}
function config(allowWrite=true){return new StaticAgentRuntimeConfig({resticRepositories:[{id:"repo-main",repository:"/backup/main",passwordFile:"/config/pw"}],restoreTargets:[{id:"restore-staging",path:"/restore",overwrite:"never",allowWrite}],tools:{resticBinary:"restic"}})}
class Runner{constructor(){this.calls=[]}async run(spec,_signal,handlers={}){this.calls.push(spec);for(const line of["restored /data/a.txt","updated /data/b.txt","unchanged /data/c.txt"])handlers.stdout?.(line);return{exitCode:0,signal:null,durationMs:5,stdoutTail:"",stderrTail:""}}}

test("write restore resolves the target locally and never adds dry-run or delete",async()=>{
  const runner=new Runner(),events=[];
  const result=await new ResticRestoreExecutor(config(true),runner,{emit:event=>events.push(event)}).execute(job(),new AbortController().signal);
  assert.equal(result.status,"completed");
  const args=runner.calls[0].args;
  assert.equal(args[0],"restore");
  assert.deepEqual(args.slice(args.indexOf("--target"),args.indexOf("--target")+2),["--target","/restore"]);
  assert.deepEqual(args.slice(args.indexOf("--include"),args.indexOf("--include")+2),["--include","/data"]);
  assert.equal(args.includes("--dry-run"),false);
  assert.equal(args.includes("--delete"),false);
  const summary=events.find(event=>event.type==="summary");
  assert.equal(summary.data.dryRun,false);
  assert.deepEqual([summary.data.restored,summary.data.updated,summary.data.unchanged],[1,1,1]);
  assert.equal(JSON.stringify(summary.data).includes("/restore"),false);
});

test("write restore is rejected unless the local target explicitly opts in",async()=>{
  const runner=new Runner();
  await assert.rejects(()=>new ResticRestoreExecutor(config(false),runner).execute(job(),new AbortController().signal),/not write-enabled/);
  assert.equal(runner.calls.length,0);
});

test("write restore cannot use a raw target path as a target id",async()=>{
  const runner=new Runner();
  await assert.rejects(()=>new ResticRestoreExecutor(config(true),runner).execute(job("/tmp/raw"),new AbortController().signal),/Unknown restore target/);
  assert.equal(runner.calls.length,0);
});
