import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareRestoreStagingTarget, restoreStagingTarget } from "../dist/index.js";

test("write restore staging is fresh, private and attempt-specific",async()=>{
  const root=await mkdtemp(join(tmpdir(),"nexus-restore-staging-"));
  try{
    const first=await prepareRestoreStagingTarget(root,"restore-job",1);
    assert.equal(first,`${root}/.nexus-backup-write-restore-job-a1`);
    const info=await stat(first);
    assert.equal(info.isDirectory(),true);
    assert.equal(info.mode&0o777,0o700);
    await assert.rejects(()=>prepareRestoreStagingTarget(root,"restore-job",1),/refusing to reuse/);
    const retry=await prepareRestoreStagingTarget(root,"restore-job",2);
    assert.notEqual(retry,first);
  }finally{
    await rm(root,{recursive:true,force:true});
  }
});

test("restore staging rejects unsafe roots and job identifiers",()=>{
  assert.throws(()=>restoreStagingTarget("relative/path","job",1,"preview"),/absolute local path/);
  assert.throws(()=>restoreStagingTarget("/restore/../escape","job",1,"preview"),/dot segments/);
  assert.throws(()=>restoreStagingTarget("/restore","../../job",1,"write"),/job id/);
});
