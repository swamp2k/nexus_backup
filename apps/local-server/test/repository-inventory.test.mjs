import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { listRepositoryInventories, queueRepositoryInventory } from "../lib/repository-inventory.mjs";
import { recordRuntimeEvents } from "../lib/runtime-telemetry.mjs";
import { openSqliteD1 } from "../lib/sqlite-d1.mjs";

const migrationsDir=fileURLToPath(new URL("../../../migrations/",import.meta.url));
const repositories=[{id:"repo-main",repository:"/backup/restic/main",passwordProtected:true,cacheConfigured:true}];

async function insertJob(db,{id,state="running",repositoryId="repo-main",createdAt="2026-09-12T10:00:00.000Z",error=null}){
  await db.prepare(`
    INSERT INTO backup_jobs (
      id, operation_key, type, state, attempt, revision, payload_json,
      created_at, updated_at, last_error, last_mutation_id
    ) VALUES (?, ?, 'restic-inventory', ?, 1, 1, ?, ?, ?, ?, ?)
  `).bind(id,`inventory-${id}`,state,JSON.stringify({repositoryId}),createdAt,createdAt,error,`mutation-${id}`).run();
}

function inventoryEvent(snapshotId="aaaaaaaaaaaaaaaa",at="2026-09-12T10:01:00.000Z"){
  return {
    type:"inventory",tool:"restic",repositoryId:"repo-main",at,
    stats:{totalSize:4096,totalFileCount:100,totalBlobCount:20,snapshotsCount:1,totalUncompressedSize:8192,compressionRatio:2,compressionProgress:100,compressionSpaceSaving:0.5},
    snapshotLimit:250,truncated:false,
    snapshots:[{id:snapshotId,shortId:snapshotId.slice(0,8),time:at,parent:null,hostname:"tower",username:"root",paths:["/data/appdata"],tags:["nexus-plan:plan-1"],programVersion:"restic 0.19.1",totalFilesProcessed:100,totalBytesProcessed:8192,dataAdded:512,dataAddedPacked:400}],
  };
}

test("inventory telemetry is repository-bound and atomically replaces the catalog",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"nexus-repo-inventory-"));
  const db=await openSqliteD1({filename:join(dir,"backup.sqlite"),migrationsDir});
  try{
    await insertJob(db,{id:"scan-1"});
    await recordRuntimeEvents(db,{jobId:"scan-1",attempt:1,agentId:"local-agent",events:[inventoryEvent()],expectedRepositoryId:"repo-main"});
    let listed=await listRepositoryInventories(db,repositories);
    assert.equal(listed[0].inventory.stats.totalSize,4096);
    assert.equal(listed[0].inventory.snapshots.length,1);
    assert.equal(listed[0].inventory.snapshots[0].id,"aaaaaaaaaaaaaaaa");

    await assert.rejects(()=>recordRuntimeEvents(db,{jobId:"scan-1",attempt:1,agentId:"local-agent",events:[{...inventoryEvent(),repositoryId:"other"}],expectedRepositoryId:"repo-main"}),/does not match/);
    listed=await listRepositoryInventories(db,repositories);
    assert.equal(listed[0].inventory.snapshots[0].id,"aaaaaaaaaaaaaaaa");

    await recordRuntimeEvents(db,{jobId:"scan-1",attempt:1,agentId:"local-agent",events:[inventoryEvent("bbbbbbbbbbbbbbbb","2026-09-12T11:00:00.000Z")],expectedRepositoryId:"repo-main"});
    listed=await listRepositoryInventories(db,repositories);
    assert.equal(listed[0].inventory.snapshots.length,1);
    assert.equal(listed[0].inventory.snapshots[0].id,"bbbbbbbbbbbbbbbb");
  }finally{db.close();await rm(dir,{recursive:true,force:true});}
});

test("duplicate scan requests reuse active work and failed rescans keep the last good inventory",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"nexus-repo-queue-"));
  const db=await openSqliteD1({filename:join(dir,"backup.sqlite"),migrationsDir});
  const enqueued=[];
  let sequence=0;
  async function enqueueJob(input){
    enqueued.push(input);const id=`scan-new-${++sequence}`;
    await db.prepare(`
      INSERT INTO backup_jobs (
        id, operation_key, type, state, attempt, revision, payload_json,
        created_at, updated_at, last_mutation_id
      ) VALUES (?, ?, ?, 'queued', 0, 0, ?, ?, ?, ?)
    `).bind(id,input.operationKey,input.type,JSON.stringify(input.payload),"2026-09-12T12:00:00.000Z","2026-09-12T12:00:00.000Z",`mutation-${id}`).run();
    return{id,state:"queued"};
  }
  try{
    await insertJob(db,{id:"scan-good",state:"completed"});
    await recordRuntimeEvents(db,{jobId:"scan-good",attempt:1,agentId:"local-agent",events:[inventoryEvent()],expectedRepositoryId:"repo-main"});
    await insertJob(db,{id:"scan-failed",state:"failed",createdAt:"2026-09-12T11:00:00.000Z",error:"repository offline"});

    let listed=await listRepositoryInventories(db,repositories);
    assert.equal(listed[0].inventory.jobId,"scan-good");
    assert.equal(listed[0].lastScan.id,"scan-failed");
    assert.equal(listed[0].lastScan.state,"failed");
    assert.equal(listed[0].lastScan.error,"repository offline");

    const first=await queueRepositoryInventory(db,{repositoryId:"repo-main",repositories,enqueueJob,now:()=>new Date("2026-09-12T12:00:00Z"),id:()=>"request-1"});
    assert.equal(first.alreadyRunning,false);
    assert.equal(enqueued[0].type,"restic-inventory");
    assert.deepEqual(enqueued[0].payload,{repositoryId:"repo-main"});

    const duplicate=await queueRepositoryInventory(db,{repositoryId:"repo-main",repositories,enqueueJob,now:()=>new Date("2026-09-12T12:00:01Z"),id:()=>"request-2"});
    assert.equal(duplicate.alreadyRunning,true);
    assert.equal(duplicate.job.id,"scan-new-1");
    assert.equal(enqueued.length,1);

    await assert.rejects(()=>queueRepositoryInventory(db,{repositoryId:"missing",repositories,enqueueJob}),/Repository not found/);
  }finally{db.close();await rm(dir,{recursive:true,force:true});}
});
