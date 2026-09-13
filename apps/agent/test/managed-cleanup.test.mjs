import assert from "node:assert/strict";
import test from "node:test";
import { ManagedCleanupExecutor, StaticAgentRuntimeConfig } from "../dist/index.js";

function job(payload,id="job-cleanup"){return{id,operationKey:`op-${id}`,type:"managed-cleanup",state:"running",attempt:1,revision:1,payload,lease:null,createdAt:"2026-09-12T10:00:00.000Z",updatedAt:"2026-09-12T10:00:00.000Z",startedAt:"2026-09-12T10:00:00.000Z",finishedAt:null,lastError:null};}
function config(){return new StaticAgentRuntimeConfig({rcloneEndpoints:[{id:"downloads",fs:"/downloads"}],tools:{rcloneBinary:"/usr/bin/rclone",rcloneConfigPath:"/config/rclone.conf"}});}
class Runner{constructor(steps){this.steps=[...steps];this.calls=[];}async run(spec,_signal,handlers={}){this.calls.push(spec);const step=this.steps.shift();if(!step)throw new Error(`unexpected command: ${spec.args.join(" ")}`);for(const line of step.stdout??[])handlers.stdout?.(line);for(const line of step.stderr??[])handlers.stderr?.(line);return step.result??{exitCode:0,signal:null,durationMs:5,stdoutTail:step.stdoutTail??"",stderrTail:step.stderrTail??""};}}
const expectedModTime="2026-09-12T09:00:00.000Z";
const payload={ruleId:"rule",destinationEndpointId:"downloads",destinationPath:"incoming",relPath:"show/episode.mkv",expectedSize:42,expectedModTime,objectKey:"a".repeat(64),cleanupAttempt:1};

test("cleanup deletes only a committed destination with exact size and modification time",async()=>{
  const runner=new Runner([{stdoutTail:JSON.stringify({Size:42,ModTime:expectedModTime})},{}]);const events=[];
  const executor=new ManagedCleanupExecutor(config(),runner,{emit:event=>events.push(event)});
  const result=await executor.execute(job(payload),new AbortController().signal);
  assert.equal(result.status,"completed");
  assert.deepEqual(runner.calls.map(call=>call.args[0]),["lsjson","deletefile"]);
  assert.equal(runner.calls[0].args[1],"/downloads/incoming/show/episode.mkv");
  assert.equal(runner.calls[1].args[1],"/downloads/incoming/show/episode.mkv");
  const summary=events.find(event=>event.type==="summary").data;
  assert.equal(summary.deleted,true);
  assert.equal(summary.expectedModTime,expectedModTime);
});

test("cleanup refuses a destination changed to a different size after Nexus committed it",async()=>{
  const runner=new Runner([{stdoutTail:JSON.stringify({Size:43,ModTime:expectedModTime})}]);
  const executor=new ManagedCleanupExecutor(config(),runner);
  await assert.rejects(()=>executor.execute(job(payload,"job-modified-size"),new AbortController().signal),/cleanup refused modified destination/);
  assert.deepEqual(runner.calls.map(call=>call.args[0]),["lsjson"]);
});

test("cleanup refuses same-size destination content with a changed modification time",async()=>{
  const runner=new Runner([{stdoutTail:JSON.stringify({Size:42,ModTime:"2026-09-12T09:00:01.000Z"})}]);
  const executor=new ManagedCleanupExecutor(config(),runner);
  await assert.rejects(()=>executor.execute(job(payload,"job-modified-time"),new AbortController().signal),/cleanup refused modified destination: expected modification time/);
  assert.deepEqual(runner.calls.map(call=>call.args[0]),["lsjson"]);
});

test("cleanup refuses deletion when backend cannot return a valid modification time",async()=>{
  const runner=new Runner([{stdoutTail:JSON.stringify({Size:42})}]);
  const executor=new ManagedCleanupExecutor(config(),runner);
  await assert.rejects(()=>executor.execute(job(payload,"job-no-modtime"),new AbortController().signal),/did not return a valid modification time/);
  assert.deepEqual(runner.calls.map(call=>call.args[0]),["lsjson"]);
});
