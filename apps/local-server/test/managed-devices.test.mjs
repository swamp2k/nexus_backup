import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createManagedDeviceService, normalizeDeviceReport } from "../lib/managed-devices.mjs";
import { openSqliteD1 } from "../lib/sqlite-d1.mjs";

const migrationsDir=new URL("../../../migrations/",import.meta.url).pathname;

async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),"nexus-devices-"));
  const db=await openSqliteD1({filename:join(dir,"backup.sqlite"),migrationsDir});
  let now=new Date("2026-09-12T19:00:00.000Z");
  let tokenNumber=0;
  const service=createManagedDeviceService({
    db,
    now:()=>new Date(now),
    id:()=>"device-pcwatch-1",
    token:()=>`nxbdev_${String(++tokenNumber).padStart(48,"x")}`,
  });
  return{dir,db,service,setNow:value=>{now=new Date(value)},async close(){db.close();await rm(dir,{recursive:true,force:true});}};
}

test("device tokens are returned once and stored only as hashes",async()=>{
  const f=await fixture();
  try{
    const created=await f.service.create({name:"Balder PC",kind:"pcwatch"});
    assert.match(created.token,/^nxbdev_/);
    assert.equal(created.tokenKind,"device");
    assert.equal(created.device.online,false);
    const row=await f.db.prepare("SELECT token_hash FROM managed_devices WHERE id=?").bind(created.device.id).first();
    assert.equal(typeof row.token_hash,"string");
    assert.equal(row.token_hash.length,64);
    assert.notEqual(row.token_hash,created.token);
    assert.doesNotMatch(JSON.stringify(await f.service.list()),/nxbdev_/);
  }finally{await f.close();}
});

test("workstation enrollment credential is one-shot and rotates before normal auth",async()=>{
  const f=await fixture();
  try{
    const created=await f.service.create({name:"Balder PC",kind:"workstation"});
    assert.equal(created.tokenKind,"install");
    assert.ok(created.expiresAt);
    await assert.rejects(()=>f.service.authenticate(created.token),/unbootstrapped/i);

    f.setNow("2026-09-12T19:05:00Z");
    const bootstrap=await f.service.report(created.token,{
      version:"installer",
      hostname:"balder-pc",
      platform:"windows/amd64",
      capabilities:["workstation.bootstrap.v1"],
    });
    assert.match(bootstrap.deviceToken,/^nxbdev_/);
    assert.notEqual(bootstrap.deviceToken,created.token);
    assert.equal(bootstrap.device.hostname,"balder-pc");
    await assert.rejects(()=>f.service.report(created.token,{version:"installer"}),/Invalid or disabled device token/);

    const normal=await f.service.report(bootstrap.deviceToken,{version:"1.0.0",hostname:"balder-pc",platform:"windows/amd64"});
    assert.equal(normal.device.version,"1.0.0");
    assert.equal(normal.deviceToken,undefined);
  }finally{await f.close();}
});

test("workstation enrollment credential expires after fifteen minutes",async()=>{
  const f=await fixture();
  try{
    const created=await f.service.create({name:"Old installer",kind:"workstation"});
    f.setNow("2026-09-12T19:15:01Z");
    await assert.rejects(()=>f.service.report(created.token,{version:"installer"}),/expired/i);
  }finally{await f.close();}
});

test("pcwatch-shaped report updates bounded capability metadata and online state",async()=>{
  const f=await fixture();
  try{
    const created=await f.service.create({name:"PCWatch backup","kind":"pcwatch"});
    f.setNow("2026-09-12T19:01:00Z");
    const result=await f.service.report(created.token,{
      version:"0.2.2",
      capabilities:["rclone.v1","rclone-mount.v1","gdocs-export.v1","restic-local.v1"],
      remotes:["gdrive:","seedbox:"],
      runtime_settings:{rclone:{tpslimit:8,max_transfer:"850G",password:"ignored-not-persisted"}},
    });
    assert.equal(result.device.online,true);
    assert.equal(result.device.version,"0.2.2");
    assert.deepEqual(result.device.capabilities,["rclone.v1","rclone-mount.v1","gdocs-export.v1","restic-local.v1"]);
    assert.deepEqual(result.device.remotes,["gdrive:","seedbox:"]);
    const raw=JSON.stringify((await f.db.prepare("SELECT * FROM managed_devices WHERE id=?").bind(created.device.id).first()));
    assert.doesNotMatch(raw,/ignored-not-persisted/);
    assert.equal(result.nextReportSeconds,60);

    f.setNow("2026-09-12T19:04:01Z");
    const listed=(await f.service.list())[0];
    assert.equal(listed.online,false);
  }finally{await f.close();}
});

test("disable and token rotation invalidate previous device credentials",async()=>{
  const f=await fixture();
  try{
    const created=await f.service.create({name:"Martin PC"});
    await f.service.update(created.device.id,{enabled:false});
    await assert.rejects(()=>f.service.report(created.token,{version:"1.0.0"}),/Invalid.*device token/);

    await f.service.update(created.device.id,{enabled:true});
    const rotated=await f.service.rotateToken(created.device.id);
    assert.notEqual(rotated.token,created.token);
    await assert.rejects(()=>f.service.report(created.token,{version:"1.0.0"}),/Invalid.*device token/);
    const report=await f.service.report(rotated.token,{version:"1.0.1",hostname:"martin-pc",platform:"windows"});
    assert.equal(report.device.hostname,"martin-pc");
    assert.equal(report.device.platform,"windows");
  }finally{await f.close();}
});

test("device reports reject oversized and malformed metadata",()=>{
  assert.throws(()=>normalizeDeviceReport({capabilities:Array.from({length:33},(_,i)=>`cap-${i}`)}),/at most 32/);
  assert.throws(()=>normalizeDeviceReport({remotes:["x".repeat(129)]}),/1-128/);
  assert.throws(()=>normalizeDeviceReport({runtime_settings:"secret"}),/small object/);
  assert.throws(()=>normalizeDeviceReport({version:"v".repeat(65)}),/1-64/);
});
