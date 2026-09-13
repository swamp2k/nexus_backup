import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { listRepositoryChecks, queueRepositoryCheck } from "../lib/repository-checks.mjs";
import { openSqliteD1 } from "../lib/sqlite-d1.mjs";

const migrationsDir=fileURLToPath(new URL("../../../migrations/",import.meta.url));
const repositories=[{id:"repo-main",repository:"/backup/restic/main"},{id:"repo-secondary",repository:"/backup/restic/secondary"}];

async function insertCheck(db,{id,state="completed",repositoryId="repo-main",createdAt="2026-09-13T10:00:00.000Z",error=null}){
  await db.prepare(`
    INSERT INTO backup_jobs (
      id,operation_key,type,state,attempt,revision,payload_json,created_at,updated_at,started_at,finished_at,last_error,last_mutation_id
    ) VALUES (?,?,'restic-check',?,1,1,?,?,?,?,?,?,?)
  `).bind(
    id,`check-${id}`,state,JSON.stringify({repositoryId}),createdAt,createdAt,
    state==="queued"?null:createdAt,
    state==="completed"||state==="failed"?createdAt:null,
    error,`mutation-${id}`,
  ).run();
}

test("repository integrity is unknown until a check succeeds and failures remain explicit",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"nexus-repo-checks-"));
  const db=await openSqliteD1({filename:join(dir,"backup.sqlite"),migrationsDir});
  try{
    let listed=await listRepositoryChecks(db,repositories);
    assert.equal(listed[0].integrity.status,"unknown");
    assert.equal(listed[0].integrity.lastCheck,null);

    await insertCheck(db,{id:"check-ok",state:"completed",createdAt:"2026-09-13T10:00:00Z"});
    listed=await listRepositoryChecks(db,repositories);
    assert.equal(listed[0].integrity.status,"ok");
    assert.equal(listed[0].integrity.lastCheck.id,"check-ok");

    await insertCheck(db,{id:"check-failed",state:"failed",createdAt:"2026-09-13T11:00:00Z",error:"repository contains errors"});
    listed=await listRepositoryChecks(db,repositories);
    assert.equal(listed[0].integrity.status,"failed");
    assert.equal(listed[0].integrity.lastCheck.error,"repository contains errors");

    await insertCheck(db,{id:"check-active",state:"running",createdAt:"2026-09-13T12:00:00Z"});
    listed=await listRepositoryChecks(db,repositories);
    assert.equal(listed[0].integrity.status,"checking");
    assert.equal(listed[0].integrity.activeCheck.id,"check-active");
    assert.equal(listed[1].integrity.status,"unknown");
  }finally{db.close();await rm(dir,{recursive:true,force:true});}
});

test("duplicate repository checks reuse active work and unknown repositories are rejected",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"nexus-repo-check-queue-"));
  const db=await openSqliteD1({filename:join(dir,"backup.sqlite"),migrationsDir});
  const enqueued=[];
  let sequence=0;
  async function enqueueJob(input){
    enqueued.push(input);const id=`check-new-${++sequence}`;
    await db.prepare(`
      INSERT INTO backup_jobs (id,operation_key,type,state,attempt,revision,payload_json,created_at,updated_at,last_mutation_id)
      VALUES (?,?,?,'queued',0,0,?,?,?,?)
    `).bind(id,input.operationKey,input.type,JSON.stringify(input.payload),"2026-09-13T12:00:00Z","2026-09-13T12:00:00Z",`mutation-${id}`).run();
    return{id,state:"queued"};
  }
  try{
    const first=await queueRepositoryCheck(db,{repositoryId:"repo-main",repositories,enqueueJob,now:()=>new Date("2026-09-13T12:00:00Z"),id:()=>"request-1"});
    assert.equal(first.alreadyRunning,false);
    assert.equal(enqueued[0].type,"restic-check");
    assert.deepEqual(enqueued[0].payload,{repositoryId:"repo-main"});

    const duplicate=await queueRepositoryCheck(db,{repositoryId:"repo-main",repositories,enqueueJob,now:()=>new Date("2026-09-13T12:00:01Z"),id:()=>"request-2"});
    assert.equal(duplicate.alreadyRunning,true);
    assert.equal(duplicate.job.id,"check-new-1");
    assert.equal(enqueued.length,1);

    await assert.rejects(()=>queueRepositoryCheck(db,{repositoryId:"missing",repositories,enqueueJob}),/Repository not found/);
  }finally{db.close();await rm(dir,{recursive:true,force:true});}
});
