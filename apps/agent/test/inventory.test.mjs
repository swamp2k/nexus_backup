import assert from "node:assert/strict";
import test from "node:test";
import {
  ResticInventoryExecutor,
  StaticAgentRuntimeConfig,
  ToolExitError,
} from "../dist/index.js";

function job(payload={ repositoryId:"repo-main" }){
  return {id:"job-inventory",operationKey:"repo-inventory",type:"restic-inventory",state:"running",attempt:1,revision:1,payload,lease:null,createdAt:"2026-09-12T10:00:00.000Z",updatedAt:"2026-09-12T10:00:00.000Z",startedAt:"2026-09-12T10:00:00.000Z",finishedAt:null,lastError:null};
}

function config(){
  return new StaticAgentRuntimeConfig({
    resticRepositories:[{id:"repo-main",repository:"/backup/restic/main",passwordFile:"/run/secrets/restic",environment:{RESTIC_CACHE_DIR:"/state/cache"}}],
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

test("restic inventory is read-only and emits compact snapshots plus stats",async()=>{
  const snapshots=[
    {id:"aaaaaaaaaaaaaaaa",short_id:"aaaaaaaa",time:"2026-09-12T10:00:00Z",paths:["/data/appdata"],hostname:"tower",username:"root",tags:["nexus-plan:plan-1","nightly"],program_version:"restic 0.19.1",summary:{total_files_processed:100,total_bytes_processed:4096,data_added:512,data_added_packed:400}},
    {id:"bbbbbbbbbbbbbbbb",short_id:"bbbbbbbb",time:"2026-09-11T10:00:00Z",paths:["/data/appdata"],hostname:"tower",tags:["nexus-plan:plan-1"],summary:{total_files_processed:90,total_bytes_processed:3072,data_added:256}},
  ];
  const stats={total_size:12345,total_file_count:190,total_blob_count:42,snapshots_count:2,total_uncompressed_size:15000,compression_ratio:1.2,compression_progress:100,compression_space_saving:0.18};
  const runner=new SequenceRunner([{stdout:[JSON.stringify(snapshots)]},{stdout:[JSON.stringify(stats)]}]);
  const events=[];
  const executor=new ResticInventoryExecutor(config(),runner,{emit:event=>events.push(event)});

  const result=await executor.execute(job(),new AbortController().signal);
  assert.equal(result.status,"completed");
  assert.equal(runner.calls.length,2);
  assert.deepEqual(runner.calls[0].args,["snapshots","--json","--latest","250","--group-by",""]);
  assert.deepEqual(runner.calls[1].args,["stats","--json","--mode","raw-data"]);
  assert.equal(runner.calls[0].env.RESTIC_REPOSITORY,"/backup/restic/main");
  assert.equal(runner.calls[0].env.RESTIC_PASSWORD_FILE,"/run/secrets/restic");
  const inventory=events.find(event=>event.type==="inventory");
  assert.ok(inventory);
  assert.equal(inventory.repositoryId,"repo-main");
  assert.equal(inventory.snapshots.length,2);
  assert.equal(inventory.snapshots[0].shortId,"aaaaaaaa");
  assert.equal(inventory.stats.totalSize,12345);
  assert.equal(inventory.truncated,false);
  assert.ok(runner.calls.every(call=>!["forget","prune","restore","backup"].includes(call.args[0])));
});

test("inventory failure never emits a replace event",async()=>{
  const runner=new SequenceRunner([
    {stdout:["[]"]},
    {result:{exitCode:1,signal:null,durationMs:5,stdoutTail:"",stderrTail:"repository unavailable"}},
  ]);
  const events=[];
  const executor=new ResticInventoryExecutor(config(),runner,{emit:event=>events.push(event)});
  await assert.rejects(()=>executor.execute(job(),new AbortController().signal),error=>error instanceof ToolExitError&&error.exitCode===1);
  assert.equal(events.some(event=>event.type==="inventory"),false);
});

test("inventory resolves repository only through local configuration",async()=>{
  const runner=new SequenceRunner([]);
  const executor=new ResticInventoryExecutor(config(),runner);
  await assert.rejects(()=>executor.execute(job({repositoryId:"s3:attacker"}),new AbortController().signal),/Unknown restic repository/);
  assert.equal(runner.calls.length,0);
});
