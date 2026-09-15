import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createManagedDeviceService } from "../lib/managed-devices.mjs";
import { createWorkstationService, workstationInstallCommand } from "../lib/workstations.mjs";
import { openSqliteD1 } from "../lib/sqlite-d1.mjs";

const migrationsDir=fileURLToPath(new URL("../../../migrations/",import.meta.url));

async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),"nexus-workstations-"));
  const db=await openSqliteD1({filename:join(dir,"backup.sqlite"),migrationsDir});
  let now=new Date("2026-09-12T19:00:00.000Z");
  let runNumber=0;
  let tokenNumber=0;
  const devices=createManagedDeviceService({
    db,
    now:()=>new Date(now),
    id:()=>"device-workstation-1",
    token:()=>`nxbdev_${String(++tokenNumber).padStart(48,"x")}`,
  });
  const service=createWorkstationService({
    db,
    deviceService:devices,
    now:()=>new Date(now),
    id:()=>`wsrun-${++runNumber}`,
    leaseToken:()=>"nxbws_abcdefghijklmnopqrstuvwxyz012345",
    leaseMs:60_000,
  });
  const created=await devices.create({name:"Balder PC",kind:"workstation"});
  const bootstrap=await devices.report(created.token,{version:"installer",hostname:"balder-pc",platform:"windows/amd64",capabilities:["workstation.bootstrap.v1","workstation.source-scan.v1"]});
  return{dir,db,devices,service,token:bootstrap.deviceToken,device:bootstrap.device,setNow:value=>{now=new Date(value)},async close(){db.close();await rm(dir,{recursive:true,force:true});}};
}

const policy={
  enabled:true,
  sourcePaths:["C:\\Users\\Balder\\Documents","D:\\Saves"],
  excludePatterns:["**/Cache/**","*.tmp"],
  schedule:{kind:"daily",time:"02:00"},
  timezone:"Europe/Copenhagen",
  retention:{keepDaily:7,keepWeekly:4,keepMonthly:6},
};

test("workstation policy queues, leases and completes a guarded run",async()=>{
  const f=await fixture();
  try{
    const saved=await f.service.putPolicy(f.device.id,policy);
    assert.deepEqual(saved.sourcePaths,policy.sourcePaths);
    const queued=await f.service.runNow(f.device.id);
    assert.equal(queued.state,"queued");

    const polled=await f.service.poll(f.token);
    assert.equal(polled.run.id,queued.id);
    assert.equal(polled.run.leaseToken,"nxbws_abcdefghijklmnopqrstuvwxyz012345");
    assert.deepEqual(polled.run.excludePatterns,policy.excludePatterns);

    const running=await f.service.progress(f.token,queued.id,{leaseToken:polled.run.leaseToken,progress:{phase:"backing-up",percent:42,bytesDone:420,bytesTotal:1000}});
    assert.equal(running.state,"running");
    assert.equal(running.progress.percent,42);

    const completed=await f.service.finish(f.token,queued.id,{leaseToken:polled.run.leaseToken,status:"success",result:{snapshotId:"abc123",filesNew:10}});
    assert.equal(completed.state,"completed");
    await assert.rejects(()=>f.service.finish(f.token,queued.id,{leaseToken:polled.run.leaseToken,status:"success",result:{}}),/stale or invalid/);

    const listed=(await f.service.list())[0];
    assert.equal(listed.lastRun.state,"completed");
    assert.equal(listed.status.lastSnapshotId,"abc123");
    assert.equal(listed.policy.retention.keepMonthly,6);
  }finally{await f.close();}
});

test("expired workstation lease is requeued with a new lease",async()=>{
  const f=await fixture();
  try{
    await f.service.putPolicy(f.device.id,policy);
    const queued=await f.service.runNow(f.device.id);
    const first=await f.service.poll(f.token);
    f.setNow("2026-09-12T19:02:00Z");
    const recovered=await f.service.recoverExpired();
    assert.equal(recovered,1);
    const second=await f.service.poll(f.token);
    assert.equal(second.run.id,queued.id);
    assert.equal(second.run.state,"leased");
    await assert.rejects(()=>f.service.progress(f.token,queued.id,{leaseToken:"nxbws_oldoldoldoldoldoldoldold",progress:{phase:"x"}}),/stale or invalid/);
    assert.equal(first.run.id,second.run.id);
  }finally{await f.close();}
});

test("workstation status never needs repository credentials",async()=>{
  const f=await fixture();
  try{
    await f.service.reportStatus(f.token,{repositoryConfigured:true,repositoryKind:"sftp",agentState:"idle",lastSuccessAt:"2026-09-12T18:00:00Z",lastSnapshotId:"deadbeef"});
    const row=await f.db.prepare("SELECT * FROM workstation_status WHERE device_id=?").bind(f.device.id).first();
    assert.equal(row.repository_kind,"sftp");
    assert.equal(row.last_snapshot_id,"deadbeef");
    assert.doesNotMatch(JSON.stringify(row),/password|sftp:\/\//i);
  }finally{await f.close();}
});

test("scheduled workstation runs coalesce missed schedules",async()=>{
  const f=await fixture();
  try{
    f.setNow("2026-09-12T18:00:00Z");
    const saved=await f.service.putPolicy(f.device.id,policy);
    assert.ok(saved.nextRunAt);
    f.setNow("2026-09-14T08:00:00Z");
    const due=await f.service.runDue();
    assert.equal(due.queued,1);
    const rows=(await f.db.prepare("SELECT * FROM workstation_runs WHERE device_id=?").bind(f.device.id).all()).results;
    assert.equal(rows.length,1);
    const updated=await f.service.getPolicy(f.device.id);
    assert.ok(new Date(updated.nextRunAt)>new Date("2026-09-14T08:00:00Z"));
  }finally{await f.close();}
});

test("source scan runs without repository setup and persists the latest tree",async()=>{
  const f=await fixture();
  try{
    await f.service.reportStatus(f.token,{repositoryConfigured:false,agentState:"needs-storage",localDrives:["C:\\","D:\\"]});
    const queued=await f.service.queueSourceScan(f.device.id,{drives:["C:\\"]});
    const leased=await f.service.poll(f.token);
    assert.equal(leased.run.id,queued.id);
    assert.equal(leased.run.operation,"source-scan");
    assert.deepEqual(leased.run.request.drives,["C:\\"]);
    await f.service.finish(f.token,queued.id,{leaseToken:leased.run.leaseToken,status:"success",result:{operation:"source-scan",drives:["C:\\"],nodes:[{path:"C:\\",parent:"",name:"C:\\",bytes:123,files:2,directories:1},{path:"C:\\Users",parent:"C:\\",name:"Users",bytes:100,files:1,directories:0}],truncated:false}});
    const cached=await f.service.getSourceScan(f.device.id);
    assert.equal(cached.scan.nodes.length,2);
    assert.equal(cached.scan.nodes[1].path,"C:\\Users");
    const listed=(await f.service.list())[0];
    assert.deepEqual(listed.status.localDrives,["C:\\","D:\\"]);
  }finally{await f.close();}
});

test("install command is a direct irm enrollment command",()=>{
  const command=workstationInstallCommand("http://tower:8787/","nxbdev_abcdefghijklmnopqrstuvwxyz0123456789");
  assert.match(command,/NEXUS_BACKUP_URL='http:\/\/tower:8787'/);
  assert.match(command,/NEXUS_BACKUP_TOKEN='nxbdev_/);
  assert.match(command,/irm 'http:\/\/tower:8787\/install\.ps1'\|iex$/);
});
