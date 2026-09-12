import assert from "node:assert/strict";
import test from "node:test";
import { ManagedTransferExecutor, RcloneDiscoveryExecutor, StaticAgentRuntimeConfig } from "../dist/index.js";

function job(type,payload,id=`job-${type}`){return{id,operationKey:`op-${id}`,type,state:"running",attempt:1,revision:1,payload,lease:null,createdAt:"2026-09-12T10:00:00.000Z",updatedAt:"2026-09-12T10:00:00.000Z",startedAt:"2026-09-12T10:00:00.000Z",finishedAt:null,lastError:null};}
function config({allowMove=true}={}){return new StaticAgentRuntimeConfig({rcloneEndpoints:[{id:"seedbox",fs:"seedbox:",allowMove},{id:"downloads",fs:"/downloads"}],tools:{rcloneBinary:"/usr/bin/rclone",rcloneConfigPath:"/config/rclone.conf"}});}
class Runner{constructor(steps){this.steps=[...steps];this.calls=[];}async run(spec,_signal,handlers={}){this.calls.push(spec);const step=this.steps.shift();if(!step)throw new Error(`unexpected command: ${spec.args.join(" ")}`);for(const line of step.stdout??[])handlers.stdout?.(line);for(const line of step.stderr??[])handlers.stderr?.(line);return step.result??{exitCode:0,signal:null,durationMs:5,stdoutTail:step.stdoutTail??"",stderrTail:""};}}
const ITEM={relPath:"show/episode.mkv",size:42,modTime:"2026-09-12T09:00:00.000Z",objectKey:"a".repeat(64)};

test("rclone discovery mirrors Copyarr filters and emits a bounded manifest",async()=>{
  const listing=JSON.stringify([
    {Path:"show/episode.mkv",Name:"episode.mkv",Size:42,ModTime:"2026-09-12T09:00:00Z",IsDir:false},
    {Path:"show/sample.mkv",Name:"sample.mkv",Size:9,ModTime:"2026-09-12T09:00:00Z",IsDir:false},
    {Path:"notes.txt",Name:"notes.txt",Size:2,ModTime:"2026-09-12T09:00:00Z",IsDir:false},
  ]);
  const runner=new Runner([{stdout:[listing]}]);const events=[];
  const executor=new RcloneDiscoveryExecutor(config(),runner,{emit:event=>events.push(event)});
  const result=await executor.execute(job("rclone-discovery",{ruleId:"seedbox-rule",sourceEndpointId:"seedbox",sourcePath:"rtorrent/complete",includes:["*.mkv"],excludes:["**/sample.*"]}),new AbortController().signal);
  assert.equal(result.status,"completed");
  assert.deepEqual(runner.calls[0].args.slice(0,4),["lsjson","seedbox:rtorrent/complete","--recursive","--files-only"]);
  const event=events.find(item=>item.type==="transfer-discovery");assert.ok(event);
  // Includes deliberately win over excludes, matching Copyarr semantics.
  assert.deepEqual(event.entries.map(item=>item.relPath),["show/episode.mkv","show/sample.mkv"]);
  assert.equal(event.entries[0].size,42);
});

test("copy transfer stages, verifies, commits and verifies final without deleting source",async()=>{
  const runner=new Runner([
    {},
    {stdoutTail:JSON.stringify({Size:42})},
    {},
    {stdoutTail:JSON.stringify({Size:42})},
    {},
  ]);const events=[];
  const executor=new ManagedTransferExecutor(config(),runner,{emit:event=>events.push(event)});
  const result=await executor.execute(job("managed-transfer",{ruleId:"rule",sourceEndpointId:"seedbox",sourcePath:"complete",destinationEndpointId:"downloads",destinationPath:"incoming",mode:"copy",verification:"size",transferAttempt:1,items:[ITEM]},"job-copy"),new AbortController().signal);
  assert.equal(result.status,"completed");
  assert.deepEqual(runner.calls.map(call=>call.args[0]),["copyto","lsjson","moveto","lsjson","purge"]);
  assert.equal(runner.calls.some(call=>call.args[0]==="deletefile"),false);
  assert.match(runner.calls[0].args[1],/^seedbox:complete\/show\/episode\.mkv$/);
  assert.match(runner.calls[0].args[2],/^\/downloads\/incoming\/\.nexus-backup-staging\/job-copy\/show\/episode\.mkv$/);
  assert.equal(runner.calls[2].args[2],"/downloads/incoming/show/episode.mkv");
  assert.equal(events.find(event=>event.type==="summary").data.verified,true);
});

test("move deletes the exact source file only after final verification",async()=>{
  const runner=new Runner([
    {},
    {stdoutTail:JSON.stringify({Size:42})},
    {},
    {stdoutTail:JSON.stringify({Size:42})},
    {},
    {},
  ]);
  const executor=new ManagedTransferExecutor(config(),runner);
  await executor.execute(job("managed-transfer",{ruleId:"rule",sourceEndpointId:"seedbox",sourcePath:"complete",destinationEndpointId:"downloads",destinationPath:"incoming",mode:"move",verification:"size",transferAttempt:1,items:[ITEM]},"job-move"),new AbortController().signal);
  assert.deepEqual(runner.calls.map(call=>call.args[0]),["copyto","lsjson","moveto","lsjson","deletefile","purge"]);
  assert.equal(runner.calls[4].args[1],"seedbox:complete/show/episode.mkv");
});

test("failed final verification never deletes move source",async()=>{
  const runner=new Runner([
    {},
    {stdoutTail:JSON.stringify({Size:42})},
    {},
    {stdoutTail:JSON.stringify({Size:41})},
  ]);
  const executor=new ManagedTransferExecutor(config(),runner);
  await assert.rejects(()=>executor.execute(job("managed-transfer",{ruleId:"rule",sourceEndpointId:"seedbox",sourcePath:"complete",destinationEndpointId:"downloads",destinationPath:"incoming",mode:"move",verification:"size",transferAttempt:1,items:[ITEM]},"job-bad"),new AbortController().signal),/size verification failed/);
  assert.equal(runner.calls.some(call=>call.args[0]==="deletefile"),false);
});

test("move still requires explicit local allowMove opt-in",async()=>{
  const runner=new Runner([]);const executor=new ManagedTransferExecutor(config({allowMove:false}),runner);
  await assert.rejects(()=>executor.execute(job("managed-transfer",{ruleId:"rule",sourceEndpointId:"seedbox",sourcePath:"",destinationEndpointId:"downloads",destinationPath:"",mode:"move",verification:"size",transferAttempt:1,items:[ITEM]}),new AbortController().signal),/move is not allowed/);
  assert.equal(runner.calls.length,0);
});
