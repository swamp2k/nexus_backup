import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { assertRecentRestorePreview, queueRestoreExecution } from "../lib/restore-execution.mjs";
import { openSqliteD1 } from "../lib/sqlite-d1.mjs";

const migrationsDir=fileURLToPath(new URL("../../../migrations/",import.meta.url));
const SNAPSHOT="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

async function seed(db,{previewFinishedAt="2026-09-12T10:10:00.000Z",previewState="completed"}={}){
  await db.prepare(`INSERT INTO repository_inventory(repository_id,job_id,attempt,agent_id,scanned_at,stats_json,snapshot_limit,returned_snapshots,truncated) VALUES('repo-main',NULL,1,'agent','2026-09-12T10:00:00.000Z','{}',250,1,0)`).run();
  await db.prepare(`INSERT INTO repository_snapshots(repository_id,snapshot_id,short_id,snapshot_time,paths_json,tags_json) VALUES(?,?,?,?,?,?)`).bind("repo-main",SNAPSHOT,"aaaaaaaa","2026-09-12T10:00:00.000Z",JSON.stringify(["/data"]),"[]").run();
  await db.prepare(`INSERT INTO repository_snapshot_browse(repository_id,snapshot_id,browse_path,job_id,attempt,agent_id,scanned_at,entries_json,entry_limit,returned_entries,truncated) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    .bind("repo-main",SNAPSHOT,"/data",null,1,"agent","2026-09-12T10:01:00.000Z",JSON.stringify([{path:"/data/file.txt",name:"file.txt",nodeType:"file",size:1,mtime:null,permissions:null}]),1000,1,0).run();
  await db.prepare(`INSERT INTO backup_jobs(id,operation_key,type,state,attempt,revision,payload_json,created_at,updated_at,finished_at,last_mutation_id) VALUES(?,?,?,?,1,1,?,?,?,?,?)`)
    .bind("preview-job","preview-op","restic-restore-preview",previewState,JSON.stringify({repositoryId:"repo-main",snapshotId:SNAPSHOT,targetId:"restore-staging",path:"/data/file.txt"}),"2026-09-12T10:00:00.000Z",previewFinishedAt,previewFinishedAt,"mutation-preview").run();
}

const repositories=[{id:"repo-main"}];
const targets=[{id:"restore-staging",label:"Restore staging",overwrite:"never",writeEnabled:true}];

test("write restore requires an exact recent completed preview",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"nexus-restore-exec-"));const db=await openSqliteD1({filename:join(dir,"db.sqlite"),migrationsDir});
  try{
    await seed(db);
    const result=await assertRecentRestorePreview(db,{repositoryId:"repo-main",snapshotId:SNAPSHOT,targetId:"restore-staging",path:"/data/file.txt",now:()=>new Date("2026-09-12T10:20:00Z")});
    assert.equal(result.id,"preview-job");
    await assert.rejects(()=>assertRecentRestorePreview(db,{repositoryId:"repo-main",snapshotId:SNAPSHOT,targetId:"restore-staging",path:"/other",now:()=>new Date("2026-09-12T10:20:00Z")}),/successful restore preview/);
    await assert.rejects(()=>assertRecentRestorePreview(db,{repositoryId:"repo-main",snapshotId:SNAPSHOT,targetId:"restore-staging",path:"/data/file.txt",now:()=>new Date("2026-09-12T10:41:00Z")}),/successful restore preview/);
  }finally{db.close();await rm(dir,{recursive:true,force:true})}
});

test("queue restore only accepts staging-safe write targets and known snapshot paths",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"nexus-restore-queue-"));const db=await openSqliteD1({filename:join(dir,"db.sqlite"),migrationsDir});const calls=[];
  try{
    await seed(db);
    const common={repositoryId:"repo-main",snapshotId:SNAPSHOT,targetId:"restore-staging",path:"/data/file.txt",repositories,restoreTargets:targets,enqueueJob:async input=>{calls.push(input);return{id:"restore-job",state:"queued"}},now:()=>new Date("2026-09-12T10:20:00Z"),id:()=>"fixed"};
    const result=await queueRestoreExecution(db,common);
    assert.equal(result.job.id,"restore-job");
    assert.equal(result.target.overwrite,"never");
    assert.equal(calls[0].type,"restic-restore");
    assert.deepEqual(calls[0].payload,{repositoryId:"repo-main",snapshotId:SNAPSHOT,targetId:"restore-staging",path:"/data/file.txt"});
    assert.equal(JSON.stringify(calls[0]).includes("/restore"),false);
    await assert.rejects(()=>queueRestoreExecution(db,{...common,restoreTargets:[{...targets[0],writeEnabled:false}]}),/preview-only/);
    await assert.rejects(()=>queueRestoreExecution(db,{...common,restoreTargets:[{...targets[0],overwrite:"always"}]}),/overwrite must be never/);
    await assert.rejects(()=>queueRestoreExecution(db,{...common,path:"/data/not-seen"}),/has not been discovered/);
  }finally{db.close();await rm(dir,{recursive:true,force:true})}
});
