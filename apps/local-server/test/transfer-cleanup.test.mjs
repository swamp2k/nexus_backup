import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createTransferCleanupService } from "../lib/transfer-cleanup.mjs";
import { openSqliteD1 } from "../lib/sqlite-d1.mjs";

const migrationsDir=fileURLToPath(new URL("../../../migrations/",import.meta.url));

async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),"nexus-cleanup-"));
  const db=await openSqliteD1({filename:join(dir,"backup.sqlite"),migrationsDir});
  let now=new Date("2026-09-20T10:00:00.000Z"),seq=0;const queued=[];
  await db.prepare(`INSERT INTO transfer_rules(id,name,source_endpoint_id,destination_endpoint_id,cleanup_days,created_at,updated_at) VALUES('rule','Seedbox','seedbox','downloads',7,?,?)`).bind(now.toISOString(),now.toISOString()).run();
  await db.prepare(`INSERT INTO transfer_objects(rule_id,object_key,rel_path,size,mod_time,first_seen_at,last_seen_at,stable_since,state,committed_at,destination_rel_path,cleanup_after) VALUES('rule',?,'show/episode.mkv',42,'2026-09-12T09:00:00.000Z','2026-09-12T10:00:00.000Z','2026-09-12T10:00:00.000Z','2026-09-12T10:00:00.000Z','done','2026-09-12T10:00:00.000Z','show/episode.mkv','2026-09-19T10:00:00.000Z')`).bind("a".repeat(64)).run();
  async function enqueueJob(input){const id=`cleanup-${++seq}`,at=now.toISOString();queued.push({...input,id});await db.prepare(`INSERT INTO backup_jobs(id,operation_key,type,state,attempt,revision,payload_json,created_at,updated_at,last_mutation_id) VALUES(?,?,?,'queued',0,0,?,?,?,?)`).bind(id,input.operationKey,input.type,JSON.stringify(input.payload),at,at,`mutation-${id}`).run();return{id,state:"queued"};}
  const service=createTransferCleanupService({db,enqueueJob,now:()=>new Date(now)});
  return{dir,db,service,queued,setNow:value=>{now=new Date(value)},async close(){db.close();await rm(dir,{recursive:true,force:true});}};
}
async function finish(db,id,state,error=null,at="2026-09-20T10:00:05.000Z"){await db.prepare("UPDATE backup_jobs SET state=?,updated_at=?,finished_at=?,last_error=? WHERE id=?").bind(state,at,at,error,id).run();}
async function object(db){return db.prepare("SELECT * FROM transfer_objects WHERE rule_id='rule'").first();}

test("due cleanup queues an agent job and marks object cleaned only after completion",async()=>{
  const f=await fixture();try{
    let result=await f.service.runDue();assert.equal(result.queued,1);assert.equal(f.queued[0].type,"managed-cleanup");assert.equal(f.queued[0].payload.expectedSize,42);
    let row=await object(f.db);assert.equal(row.state,"done");assert.equal(row.cleanup_job_id,"cleanup-1");
    await finish(f.db,"cleanup-1","completed");result=await f.service.runDue();assert.equal(result.reconciled,1);
    row=await object(f.db);assert.equal(row.state,"cleaned");assert.equal(row.cleanup_job_id,null);assert.equal(row.cleanup_after,null);
  }finally{await f.close();}
});

test("modified destination refusal permanently disables cleanup for that generation",async()=>{
  const f=await fixture();try{
    await f.service.runDue();await finish(f.db,"cleanup-1","failed","cleanup refused modified destination: expected 42 bytes, got 43");
    const result=await f.service.runDue();assert.equal(result.reconciled,1);assert.equal(result.queued,0);
    const row=await object(f.db);assert.equal(row.state,"done");assert.equal(row.cleanup_after,null);assert.match(row.last_error,/modified destination/);assert.equal(row.cleanup_job_id,null);
  }finally{await f.close();}
});

test("transient cleanup failure retries with the rule retry budget",async()=>{
  const f=await fixture();try{
    await f.service.runDue();await finish(f.db,"cleanup-1","failed","network lost");
    f.setNow("2026-09-20T10:00:06.000Z");let result=await f.service.runDue();assert.equal(result.reconciled,1);assert.equal(result.queued,0);
    let row=await object(f.db);assert.equal(row.cleanup_job_id,null);assert.ok(row.next_cleanup_retry_at);
    f.setNow("2026-09-20T10:05:06.000Z");result=await f.service.runDue();assert.equal(result.queued,1);assert.match(f.queued.at(-1).operationKey,/attempt:2$/);
    row=await object(f.db);assert.equal(row.cleanup_attempt_count,2);
  }finally{await f.close();}
});
