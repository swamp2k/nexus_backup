import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createTransferRuleService } from "../lib/transfer-rules.mjs";
import { openSqliteD1 } from "../lib/sqlite-d1.mjs";

const migrationsDir=fileURLToPath(new URL("../../../migrations/",import.meta.url));
const config={
  available:true,
  endpoints:[{id:"seedbox",fs:"seedbox:",allowMove:false},{id:"downloads",fs:"/downloads",allowMove:false}],
  rtorrentGates:[{id:"seedbox-rtorrent",required:false}],
};

async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),"nexus-rtorrent-rule-"));
  const db=await openSqliteD1({filename:join(dir,"backup.sqlite"),migrationsDir});
  const queued=[];let seq=0;
  const service=createTransferRuleService({
    db,
    enqueueJob:async input=>{
      const id=`job-${++seq}`,at="2026-09-12T10:00:00.000Z";
      queued.push(input);
      await db.prepare(`INSERT INTO backup_jobs(id,operation_key,type,state,attempt,revision,payload_json,created_at,updated_at,last_mutation_id) VALUES(?,?,?,'queued',0,0,?,?,?,?)`)
        .bind(id,input.operationKey,input.type,JSON.stringify(input.payload),at,at,`mutation-${id}`).run();
      return{id,state:"queued"};
    },
    loadAgentConfig:async()=>config,
    now:()=>new Date("2026-09-12T10:00:00.000Z"),
    id:()=>"rule-1",
  });
  return{dir,db,service,queued,async close(){db.close();await rm(dir,{recursive:true,force:true});}};
}

const input={
  name:"Seedbox → downloads",sourceEndpointId:"seedbox",sourcePath:"complete",
  destinationEndpointId:"downloads",destinationPath:"incoming",mode:"copy",
  initialBehavior:"ignore_existing",stabilitySeconds:600,scanIntervalSeconds:300,
  cleanupDays:14,verification:"size",retryCount:3,retryWaitSeconds:300,
  multiThreadStreams:4,multiThreadCutoff:"256M",rcloneArgs:[],includes:[],excludes:[],
  rtorrentGateId:"seedbox-rtorrent",
};

test("transfer rule persists the sanitized rtorrent gate id and passes it only to discovery jobs",async()=>{
  const f=await fixture();try{
    const rule=await f.service.create(input);
    assert.equal(rule.rtorrentGateId,"seedbox-rtorrent");
    await f.service.scanNow(rule.id);
    const job=f.queued.at(-1);
    assert.equal(job.type,"rclone-discovery");
    assert.equal(job.payload.rtorrentGateId,"seedbox-rtorrent");
    assert.equal(JSON.stringify(job.payload).includes("RPC2"),false);
    assert.equal(JSON.stringify(job.payload).includes("password"),false);
  }finally{await f.close();}
});

test("unknown rtorrent gate ids are rejected against sanitized agent config",async()=>{
  const f=await fixture();try{
    await assert.rejects(()=>f.service.create({...input,rtorrentGateId:"missing"}),/unknown rtorrentGateId/);
  }finally{await f.close();}
});

test("removing the readiness gate is a structural reset",async()=>{
  const f=await fixture();try{
    await f.service.create(input);
    await f.db.prepare(`INSERT INTO transfer_objects(rule_id,object_key,rel_path,size,mod_time,first_seen_at,last_seen_at,stable_since,state) VALUES('rule-1',?,'old.mkv',1,'2026-09-12T09:00:00Z','2026-09-12T10:00:00Z','2026-09-12T10:00:00Z','2026-09-12T10:00:00Z','ignored')`).bind("a".repeat(64)).run();
    const updated=await f.service.update("rule-1",{...input,rtorrentGateId:null});
    assert.equal(updated.rtorrentGateId,null);
    const count=await f.db.prepare("SELECT COUNT(*) AS count FROM transfer_objects WHERE rule_id='rule-1'").first();
    assert.equal(Number(count.count),0);
    assert.equal(updated.initializedAt,null);
  }finally{await f.close();}
});
