import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTransferGroupService, persistTransferGroups } from "../lib/transfer-groups.mjs";
import { createTransferRuleService, persistTransferDiscovery } from "../lib/transfer-rules.mjs";
import { openSqliteD1 } from "../lib/sqlite-d1.mjs";

const migrationsDir=new URL("../../../migrations/",import.meta.url).pathname;
const TORRENT_HASH="a".repeat(40);
const config={
  available:true,
  endpoints:[{id:"seedbox",fs:"seedbox:",allowMove:true},{id:"downloads",fs:"/downloads",allowMove:false}],
  rtorrentGates:[{id:"seedbox-rtorrent",required:false}],
};

async function fixture({stabilitySeconds=600,retryCount=1,retryWaitSeconds=60}={}){
  const dir=await mkdtemp(join(tmpdir(),"nexus-transfer-groups-"));
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
  const rules=createTransferRuleService({db,enqueueJob,loadAgentConfig:async()=>config,now:()=>new Date(now),id:()=>"rule-1"});
  const groups=createTransferGroupService({db,enqueueJob,now:()=>new Date(now)});
  await rules.create({
    name:"Seedbox → downloads",sourceEndpointId:"seedbox",sourcePath:"complete",
    destinationEndpointId:"downloads",destinationPath:"incoming",mode:"copy",
    initialBehavior:"process_existing",stabilitySeconds,scanIntervalSeconds:3600,cleanupDays:14,
    verification:"size",retryCount,retryWaitSeconds,multiThreadStreams:4,multiThreadCutoff:"256M",
    rcloneArgs:[],includes:[],excludes:[],rtorrentGateId:"seedbox-rtorrent",
  });
  return{dir,db,rules,groups,queued,setNow(value){now=new Date(value)},async close(){db.close();await rm(dir,{recursive:true,force:true});}};
}
function discovery(entries,at){return{type:"transfer-discovery",tool:"rclone",ruleId:"rule-1",at,entries};}
function groupEvent(groups,at){return{type:"transfer-groups",tool:"rclone",ruleId:"rule-1",at,groups};}
async function finish(db,id,state,at,error=null){await db.prepare("UPDATE backup_jobs SET state=?,updated_at=?,finished_at=?,last_error=? WHERE id=?").bind(state,at,at,error,id).run();}
async function scan(f,{groups=[{kind:"torrent",key:TORRENT_HASH,name:"Show Complete",root:"Show.Complete"}],at="2026-09-12T10:00:01Z"}={}){
  const result=await f.rules.scanNow("rule-1");
  await persistTransferDiscovery(f.db,{jobId:result.job.id,expectedRuleId:"rule-1",event:discovery([
    {relPath:"Show.Complete/episode-1.mkv",size:40,modTime:"2026-09-12T09:00:00Z"},
    {relPath:"Show.Complete/episode-2.mkv",size:60,modTime:"2026-09-12T09:00:00Z"},
    {relPath:"manual.txt",size:2,modTime:"2026-09-12T09:00:00Z"},
  ],at)});
  await persistTransferGroups(f.db,{jobId:result.job.id,expectedRuleId:"rule-1",event:groupEvent(groups,new Date(Date.parse(at)+1).toISOString())});
  await finish(f.db,result.job.id,"completed",new Date(Date.parse(at)+2).toISOString());
  return result.job;
}

test("completed torrent queues one multi-file manifest immediately while unknown files keep stability",async()=>{
  const f=await fixture({stabilitySeconds:600});
  try{
    await scan(f);
    f.setNow("2026-09-12T10:00:04Z");
    const grouped=await f.groups.runDue();
    assert.equal(grouped.queued,1);
    assert.deepEqual(grouped.failures,[]);
    const transfer=f.queued.find(item=>item.type==="managed-transfer");
    assert.ok(transfer);
    assert.equal(transfer.payload.group.key,TORRENT_HASH);
    assert.equal(transfer.payload.group.root,"Show.Complete");
    assert.deepEqual(transfer.payload.items.map(item=>item.relPath),[
      "Show.Complete/episode-1.mkv",
      "Show.Complete/episode-2.mkv",
    ]);
    assert.equal((await f.rules.runDue()).transfers,0);
    const rows=(await f.db.prepare("SELECT rel_path,state,group_key,stable_since FROM transfer_objects ORDER BY rel_path").all()).results;
    assert.equal(rows.find(row=>row.rel_path==="manual.txt").group_key,null);
    assert.equal(rows.find(row=>row.rel_path==="manual.txt").state,"discovered");
    assert.ok(rows.filter(row=>row.group_key===TORRENT_HASH).every(row=>row.state==="queued"));
  }finally{await f.close();}
});

test("empty group event clears the hold so optional rtorrent fallback returns to stability scheduling",async()=>{
  const f=await fixture({stabilitySeconds:60});
  try{
    await scan(f);
    f.setNow("2026-09-12T10:02:00Z");
    const second=await f.rules.scanNow("rule-1");
    const at="2026-09-12T10:02:01Z";
    await persistTransferDiscovery(f.db,{jobId:second.job.id,expectedRuleId:"rule-1",event:discovery([
      {relPath:"Show.Complete/episode-1.mkv",size:40,modTime:"2026-09-12T09:00:00Z"},
      {relPath:"Show.Complete/episode-2.mkv",size:60,modTime:"2026-09-12T09:00:00Z"},
      {relPath:"manual.txt",size:2,modTime:"2026-09-12T09:00:00Z"},
    ],at)});
    await persistTransferGroups(f.db,{jobId:second.job.id,expectedRuleId:"rule-1",event:groupEvent([],"2026-09-12T10:02:01.001Z")});
    await finish(f.db,second.job.id,"completed","2026-09-12T10:02:02Z");
    const groupedRows=(await f.db.prepare("SELECT group_key,stable_since FROM transfer_objects WHERE rel_path LIKE 'Show.Complete/%'").all()).results;
    assert.ok(groupedRows.every(row=>row.group_key===null));
    assert.ok(groupedRows.every(row=>row.stable_since===at));
    f.setNow("2026-09-12T10:03:02Z");
    const due=await f.rules.runDue();
    assert.equal(due.transfers,3);
  }finally{await f.close();}
});

test("failed torrent manifest retries as one group instead of individual files",async()=>{
  const f=await fixture({stabilitySeconds:600,retryCount:1,retryWaitSeconds:60});
  try{
    await scan(f);
    f.setNow("2026-09-12T10:00:04Z");
    assert.equal((await f.groups.runDue()).queued,1);
    const first=f.queued.find(item=>item.type==="managed-transfer");
    await finish(f.db,first.id,"failed","2026-09-12T10:00:10Z","network lost");
    f.setNow("2026-09-12T10:00:11Z");
    await f.rules.runDue();
    const retryRows=(await f.db.prepare("SELECT state,attempt_count,next_retry_at FROM transfer_objects WHERE group_key=? ORDER BY rel_path").bind(TORRENT_HASH).all()).results;
    assert.ok(retryRows.every(row=>row.state==="retry_wait"&&Number(row.attempt_count)===1));

    f.setNow("2026-09-12T10:01:11Z");
    const retry=await f.groups.runDue();
    assert.equal(retry.queued,1);
    const second=f.queued.filter(item=>item.type==="managed-transfer").at(-1);
    assert.equal(second.payload.items.length,2);
    assert.match(second.operationKey,/attempt:2$/);
    assert.equal((await f.rules.runDue()).transfers,0);
  }finally{await f.close();}
});
