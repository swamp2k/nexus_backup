import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTransferRuleService, persistTransferDiscovery } from "../lib/transfer-rules.mjs";
import { openSqliteD1 } from "../lib/sqlite-d1.mjs";

const migrationsDir=new URL("../../../migrations/",import.meta.url).pathname;
const config={available:true,endpoints:[{id:"seedbox",fs:"seedbox:",allowMove:true},{id:"downloads",fs:"/downloads",allowMove:false}]};

async function fixture({initialBehavior="ignore_existing",stabilitySeconds=600,retryCount=3,retryWaitSeconds=300}={}){
  const dir=await mkdtemp(join(tmpdir(),"nexus-transfer-"));
  const db=await openSqliteD1({filename:join(dir,"backup.sqlite"),migrationsDir});
  let now=new Date("2026-09-12T10:00:00.000Z");let seq=0;const queued=[];
  async function enqueueJob(input){
    const existing=await db.prepare("SELECT id,state FROM backup_jobs WHERE operation_key=?").bind(input.operationKey).first();
    if(existing)return{id:String(existing.id),state:String(existing.state)};
    const id=`job-${++seq}`,at=now.toISOString();queued.push({...input,id});
    await db.prepare(`INSERT INTO backup_jobs(id,operation_key,type,state,attempt,revision,payload_json,created_at,updated_at,last_mutation_id) VALUES(?,?,?,'queued',0,0,?,?,?,?)`)
      .bind(id,input.operationKey,input.type,JSON.stringify(input.payload),at,at,`mutation-${id}`).run();
    return{id,state:"queued"};
  }
  const service=createTransferRuleService({db,enqueueJob,loadAgentConfig:async()=>config,now:()=>new Date(now),id:()=>"rule-1"});
  await service.create({name:"Seedbox → downloads",sourceEndpointId:"seedbox",sourcePath:"complete",destinationEndpointId:"downloads",destinationPath:"incoming",mode:"copy",initialBehavior,stabilitySeconds,scanIntervalSeconds:300,cleanupDays:14,verification:"size",retryCount,retryWaitSeconds,includes:[],excludes:[]});
  return{dir,db,service,queued,get now(){return now},setNow(value){now=new Date(value)},async close(){db.close();await rm(dir,{recursive:true,force:true});}};
}
function discovery(ruleId,entries,at){return{type:"transfer-discovery",tool:"rclone",ruleId,at,entries};}
async function finish(db,id,state,at,error=null){await db.prepare("UPDATE backup_jobs SET state=?,updated_at=?,finished_at=?,last_error=? WHERE id=?").bind(state,at,at,error,id).run();}

test("ignore-existing bootstrap tracks generations and queues only stable new objects",async()=>{
  const f=await fixture();
  try{
    const first=await f.service.scanNow("rule-1");
    await persistTransferDiscovery(f.db,{jobId:first.job.id,expectedRuleId:"rule-1",event:discovery("rule-1",[{relPath:"old.mkv",size:100,modTime:"2026-09-12T09:00:00Z"}],"2026-09-12T10:00:01Z")});
    await finish(f.db,first.job.id,"completed","2026-09-12T10:00:02Z");
    let objects=await f.service.objects("rule-1");
    assert.equal(objects.length,1);assert.equal(objects[0].state,"ignored");

    f.setNow("2026-09-12T10:05:00Z");
    const second=await f.service.scanNow("rule-1");
    await persistTransferDiscovery(f.db,{jobId:second.job.id,expectedRuleId:"rule-1",event:discovery("rule-1",[
      {relPath:"old.mkv",size:100,modTime:"2026-09-12T09:00:00Z"},
      {relPath:"new.mkv",size:200,modTime:"2026-09-12T10:04:00Z"},
    ],"2026-09-12T10:05:01Z")});
    await finish(f.db,second.job.id,"completed","2026-09-12T10:05:02Z");
    objects=await f.service.objects("rule-1");
    assert.equal(objects.find(item=>item.path==="old.mkv").state,"ignored");
    assert.equal(objects.find(item=>item.path==="new.mkv").state,"discovered");

    f.setNow("2026-09-12T10:14:59Z");
    assert.equal((await f.service.runDue()).transfers,0);
    f.setNow("2026-09-12T10:15:02Z");
    const due=await f.service.runDue();
    assert.equal(due.transfers,1);
    const transfer=f.queued.find(item=>item.type==="managed-transfer");assert.ok(transfer);
    assert.equal(transfer.payload.items[0].relPath,"new.mkv");
    assert.equal(transfer.payload.items[0].size,200);
  }finally{await f.close();}
});

test("a changed path becomes a new generation without resurrecting the bootstrap object",async()=>{
  const f=await fixture({stabilitySeconds:0});
  try{
    const first=await f.service.scanNow("rule-1");
    await persistTransferDiscovery(f.db,{jobId:first.job.id,expectedRuleId:"rule-1",event:discovery("rule-1",[{relPath:"movie.mkv",size:100,modTime:"2026-09-12T09:00:00Z"}],"2026-09-12T10:00:01Z")});
    await finish(f.db,first.job.id,"completed","2026-09-12T10:00:02Z");
    f.setNow("2026-09-12T10:05:00Z");
    const second=await f.service.scanNow("rule-1");
    await persistTransferDiscovery(f.db,{jobId:second.job.id,expectedRuleId:"rule-1",event:discovery("rule-1",[{relPath:"movie.mkv",size:101,modTime:"2026-09-12T10:04:00Z"}],"2026-09-12T10:05:01Z")});
    const objects=await f.service.objects("rule-1");
    assert.equal(objects.filter(item=>item.path==="movie.mkv").length,2);
    assert.equal(objects.find(item=>item.size===100).state,"ignored");
    assert.equal(objects.find(item=>item.size===101).state,"discovered");
  }finally{await f.close();}
});

test("failed transfers retry with a bounded attempt budget",async()=>{
  const f=await fixture({initialBehavior:"process_existing",stabilitySeconds:0,retryCount:1,retryWaitSeconds:60});
  try{
    const scan=await f.service.scanNow("rule-1");
    await persistTransferDiscovery(f.db,{jobId:scan.job.id,expectedRuleId:"rule-1",event:discovery("rule-1",[{relPath:"episode.mkv",size:42,modTime:"2026-09-12T09:00:00Z"}],"2026-09-12T10:00:01Z")});
    await finish(f.db,scan.job.id,"completed","2026-09-12T10:00:02Z");
    f.setNow("2026-09-12T10:00:03Z");
    assert.equal((await f.service.runDue()).transfers,1);
    const first=f.queued.find(item=>item.type==="managed-transfer");
    await finish(f.db,first.id,"failed","2026-09-12T10:00:10Z","network lost");
    f.setNow("2026-09-12T10:00:11Z");
    await f.service.runDue();
    let object=(await f.service.objects("rule-1"))[0];assert.equal(object.state,"retry_wait");assert.equal(object.attemptCount,1);

    f.setNow("2026-09-12T10:01:11Z");
    assert.equal((await f.service.runDue()).transfers,1);
    const second=f.queued.filter(item=>item.type==="managed-transfer").at(-1);assert.match(second.operationKey,/attempt:2$/);
    await finish(f.db,second.id,"failed","2026-09-12T10:01:20Z","still offline");
    f.setNow("2026-09-12T10:01:21Z");
    await f.service.runDue();
    object=(await f.service.objects("rule-1"))[0];assert.equal(object.state,"failed");assert.equal(object.attemptCount,2);
  }finally{await f.close();}
});

test("move rules require local allowMove on their source endpoint",async()=>{
  const f=await fixture();
  try{
    await assert.rejects(()=>f.service.create({id:"bad",name:"Bad move",sourceEndpointId:"downloads",destinationEndpointId:"seedbox",mode:"move",scanIntervalSeconds:300,stabilitySeconds:0,cleanupDays:0,retryCount:0,retryWaitSeconds:0}),/does not allow move/);
  }finally{await f.close();}
});
