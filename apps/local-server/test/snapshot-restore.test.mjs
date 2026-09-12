import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { loadSanitizedAgentConfig } from "../lib/dashboard-data.mjs";
import { normalizeRuntimeEvents } from "../lib/runtime-telemetry.mjs";
import {
  getSnapshotBrowse,
  persistSnapshotBrowse,
  queueRestorePreview,
  queueSnapshotBrowse,
} from "../lib/snapshot-restore.mjs";
import { openSqliteD1 } from "../lib/sqlite-d1.mjs";

const migrationsDir=fileURLToPath(new URL("../../../migrations/",import.meta.url));
const SNAPSHOT="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

async function seed(db){
  await db.prepare(`INSERT INTO repository_inventory(repository_id,job_id,attempt,agent_id,scanned_at,stats_json,snapshot_limit,returned_snapshots,truncated) VALUES('repo-main',NULL,1,'agent','2026-09-12T10:00:00.000Z','{}',250,1,0)`).run();
  await db.prepare(`INSERT INTO repository_snapshots(repository_id,snapshot_id,short_id,snapshot_time,paths_json,tags_json) VALUES(?,?,?,?,?,?)`).bind("repo-main",SNAPSHOT,"aaaaaaaa","2026-09-12T10:00:00.000Z",JSON.stringify(["/data"]),JSON.stringify(["nightly"])).run();
}

function browseEvent(path="/"){
  return {
    type:"snapshot-browse",tool:"restic",repositoryId:"repo-main",snapshotId:SNAPSHOT,path,
    entries:path==="/"?[
      {path:"/data",name:"data",nodeType:"dir",size:null,mtime:"2026-09-12T10:00:00Z",permissions:"drwxr-xr-x"},
    ]:[
      {path:"/data/alpha",name:"alpha",nodeType:"dir",size:null,mtime:"2026-09-12T10:00:00Z",permissions:"drwxr-xr-x"},
      {path:"/data/file.txt",name:"file.txt",nodeType:"file",size:42,mtime:"2026-09-12T10:00:00Z",permissions:"-rw-r--r--"},
    ],
    entryLimit:1000,truncated:false,
  };
}

test("snapshot browse cache is repository/snapshot/path bound and replaces atomically",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"nexus-snapshot-restore-"));
  const db=await openSqliteD1({filename:join(dir,"backup.sqlite"),migrationsDir});
  try{
    await seed(db);
    await persistSnapshotBrowse(db,{jobId:null,attempt:1,agentId:"agent",expectedRepositoryId:"repo-main",expectedSnapshotId:SNAPSHOT,expectedPath:"/",event:browseEvent("/")});
    let result=await getSnapshotBrowse(db,{repositoryId:"repo-main",snapshotId:SNAPSHOT,path:"/"});
    assert.equal(result.browse.entries.length,1);
    assert.equal(result.browse.entries[0].path,"/data");

    await assert.rejects(()=>persistSnapshotBrowse(db,{jobId:null,attempt:1,agentId:"agent",expectedRepositoryId:"other",expectedSnapshotId:SNAPSHOT,expectedPath:"/",event:browseEvent("/")}),/repositoryId does not match/);

    const replacement=browseEvent("/");
    replacement.entries=[{path:"/new-root",name:"new-root",nodeType:"dir",size:null,mtime:null,permissions:null}];
    await persistSnapshotBrowse(db,{jobId:null,attempt:2,agentId:"agent",expectedRepositoryId:"repo-main",expectedSnapshotId:SNAPSHOT,expectedPath:"/",event:replacement});
    result=await getSnapshotBrowse(db,{repositoryId:"repo-main",snapshotId:SNAPSHOT,path:"/"});
    assert.deepEqual(result.browse.entries.map(entry=>entry.path),["/new-root"]);
  }finally{db.close();await rm(dir,{recursive:true,force:true});}
});

test("browser only descends through previously discovered directories",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"nexus-snapshot-browse-"));
  const db=await openSqliteD1({filename:join(dir,"backup.sqlite"),migrationsDir});
  const calls=[];
  let seq=0;
  const enqueueJob=async input=>{
    calls.push(input);const id=`job-${++seq}`;const at="2026-09-12T10:00:00.000Z";
    await db.prepare(`INSERT INTO backup_jobs(id,operation_key,type,state,attempt,revision,payload_json,created_at,updated_at,last_mutation_id) VALUES(?,?,?,'queued',0,0,?,?,?,?)`)
      .bind(id,input.operationKey,input.type,JSON.stringify(input.payload),at,at,`mutation-${id}`).run();
    return {id,state:"queued"};
  };
  try{
    await seed(db);
    const repositories=[{id:"repo-main"}];
    const root=await queueSnapshotBrowse(db,{repositoryId:"repo-main",snapshotId:SNAPSHOT,path:"/",repositories,enqueueJob,now:()=>new Date("2026-09-12T10:00:00Z"),id:()=>"root"});
    assert.equal(root.alreadyRunning,false);
    assert.equal(calls[0].type,"restic-browse");

    await db.prepare("UPDATE backup_jobs SET state='completed' WHERE id=?").bind(root.job.id).run();
    await persistSnapshotBrowse(db,{jobId:root.job.id,attempt:1,agentId:"agent",expectedRepositoryId:"repo-main",expectedSnapshotId:SNAPSHOT,expectedPath:"/",event:browseEvent("/")});
    const child=await queueSnapshotBrowse(db,{repositoryId:"repo-main",snapshotId:SNAPSHOT,path:"/data",repositories,enqueueJob,now:()=>new Date("2026-09-12T10:01:00Z"),id:()=>"child"});
    assert.equal(child.alreadyRunning,false);
    assert.equal(calls.at(-1).payload.path,"/data");
    await assert.rejects(()=>queueSnapshotBrowse(db,{repositoryId:"repo-main",snapshotId:SNAPSHOT,path:"/not-discovered",repositories,enqueueJob}),/has not been discovered/);
  }finally{db.close();await rm(dir,{recursive:true,force:true});}
});

test("restore preview accepts only configured target ids and discovered snapshot paths",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"nexus-restore-preview-"));
  const db=await openSqliteD1({filename:join(dir,"backup.sqlite"),migrationsDir});
  const calls=[];
  const enqueueJob=async input=>{calls.push(input);return{id:`preview-${calls.length}`,state:"queued"};};
  try{
    await seed(db);
    await persistSnapshotBrowse(db,{jobId:null,attempt:1,agentId:"agent",expectedRepositoryId:"repo-main",expectedSnapshotId:SNAPSHOT,expectedPath:"/data",event:browseEvent("/data")});
    const common={repositoryId:"repo-main",snapshotId:SNAPSHOT,repositories:[{id:"repo-main"}],restoreTargets:[{id:"restore-staging",label:"Restore staging",overwrite:"never"}],enqueueJob,now:()=>new Date("2026-09-12T10:00:00Z"),id:()=>"preview"};
    const result=await queueRestorePreview(db,{...common,targetId:"restore-staging",path:"/data/file.txt"});
    assert.equal(result.alreadyRunning,false);
    assert.equal(calls[0].type,"restic-restore-preview");
    assert.deepEqual(calls[0].payload,{repositoryId:"repo-main",snapshotId:SNAPSHOT,targetId:"restore-staging",path:"/data/file.txt"});
    assert.equal(JSON.stringify(calls[0]).includes("/restore"),false);

    await assert.rejects(()=>queueRestorePreview(db,{...common,targetId:"/tmp/raw-path",path:"/data/file.txt"}),/Restore target not found/);
    await assert.rejects(()=>queueRestorePreview(db,{...common,targetId:"restore-staging",path:"/data/not-seen.txt"}),/has not been discovered/);
  }finally{db.close();await rm(dir,{recursive:true,force:true});}
});

test("special runtime events are accepted only for their matching job kind",()=>{
  const inventory={type:"inventory",tool:"restic",repositoryId:"repo-main",stats:{},snapshots:[],snapshotLimit:250,truncated:false};
  const browse=browseEvent("/");
  assert.throws(()=>normalizeRuntimeEvents([inventory],new Date(),{runtimeKind:"snapshot-browse",expectedRepositoryId:"repo-main"}),/only accepted from restic-inventory/);
  assert.throws(()=>normalizeRuntimeEvents([browse],new Date(),{runtimeKind:"inventory",expectedRepositoryId:"repo-main",expectedSnapshotId:SNAPSHOT,expectedPath:"/"}),/only accepted from restic-browse/);
  assert.doesNotThrow(()=>normalizeRuntimeEvents([browse],new Date(),{runtimeKind:"snapshot-browse",expectedRepositoryId:"repo-main",expectedSnapshotId:SNAPSHOT,expectedPath:"/"}));
});

test("sanitized restore targets expose policy but never the local target path",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"nexus-restore-config-"));
  try{
    const configPath=join(dir,"agent.json");
    await writeFile(configPath,JSON.stringify({
      restoreTargets:[{id:"safe",label:"Safe staging",path:"/super/secret/restore",overwrite:"never"}],
    }));
    const config=await loadSanitizedAgentConfig(configPath);
    assert.deepEqual(config.restoreTargets,[{id:"safe",label:"Safe staging",overwrite:"never"}]);
    assert.equal(JSON.stringify(config).includes("/super/secret/restore"),false);
  }finally{await rm(dir,{recursive:true,force:true});}
});
