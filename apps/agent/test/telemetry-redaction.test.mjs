import assert from "node:assert/strict";
import test from "node:test";
import {
  StaticAgentRuntimeConfig,
  createDefaultJobExecutor,
  createRedactingExecutionEventSink,
} from "../dist/index.js";

function job() {
  return {
    id:"check-redaction",
    operationKey:"op-check-redaction",
    type:"restic-check",
    state:"running",
    attempt:1,
    revision:1,
    payload:{repositoryId:"repo-main"},
    lease:null,
    createdAt:"2026-09-13T10:00:00.000Z",
    updatedAt:"2026-09-13T10:00:00.000Z",
    startedAt:"2026-09-13T10:00:00.000Z",
    finishedAt:null,
    lastError:null,
  };
}

class FakeRunner {
  constructor(lines=[]) { this.lines=lines; }
  async run(_spec,_signal,handlers={}) {
    for(const line of this.lines) handlers.stderr?.(line);
    return {exitCode:0,signal:null,durationMs:1,stdoutTail:"",stderrTail:this.lines.join("\n")};
  }
}

test("runtime config derives redaction values from local repository and secret environment settings",()=>{
  const config=new StaticAgentRuntimeConfig({
    resticRepositories:[{
      id:"repo-main",
      repository:"rest:https://backup-user:repo-password@backup.example/private/repo",
      passwordFile:"/config/secrets/restic-password",
      environment:{
        AWS_SECRET_ACCESS_KEY:"aws-super-secret",
        RESTIC_CACHE_DIR:"/state/restic-cache",
      },
    }],
    rtorrentGates:[{
      id:"seedbox",
      url:"https://seed.example/RPC2",
      username:"user",
      password:"torrent-secret",
      sourceBasePath:"/complete",
    }],
  });
  const values=config.telemetryRedactionValues;
  assert.ok(values.includes("rest:https://backup-user:repo-password@backup.example/private/repo"));
  assert.ok(values.includes("https://backup-user:repo-password@backup.example/private/repo"));
  assert.ok(values.includes("repo-password"));
  assert.ok(values.includes("/config/secrets/restic-password"));
  assert.ok(values.includes("aws-super-secret"));
  assert.ok(values.includes("torrent-secret"));
  assert.equal(values.includes("/state/restic-cache"),false);
});

test("default executor redacts repository URLs and credentials before tool logs leave the agent",async()=>{
  const repository="rest:https://backup-user:repo-password@backup.example/private/repo";
  const passwordFile="/config/secrets/restic-password";
  const envSecret="aws-super-secret";
  const config=new StaticAgentRuntimeConfig({
    resticRepositories:[{
      id:"repo-main",
      repository,
      passwordFile,
      environment:{AWS_SECRET_ACCESS_KEY:envSecret},
    }],
  });
  const events=[];
  const runner=new FakeRunner([
    `Fatal: unable to open ${repository}`,
    `backend https://backup-user:repo-password@backup.example/private/repo rejected password repo-password`,
    `password file ${passwordFile}; key=${envSecret}`,
  ]);
  const executor=createDefaultJobExecutor(config,{emit:event=>events.push(event)},runner);
  const result=await executor.execute(job(),new AbortController().signal);
  assert.equal(result.status,"completed");
  const encoded=JSON.stringify(events);
  for(const secret of [repository,"backup-user","repo-password",passwordFile,envSecret]) {
    assert.equal(encoded.includes(secret),false,`telemetry leaked ${secret}`);
  }
  assert.match(encoded,/\[REDACTED\]/);
});

test("redacting sink sanitizes summary strings but preserves structured inventory protocol data",()=>{
  const events=[];
  const sink=createRedactingExecutionEventSink({emit:event=>events.push(event)},["super-secret"]);
  sink.emit({type:"summary",tool:"restic",data:{message:"token=super-secret",nested:["super-secret"]}});
  sink.emit({
    type:"inventory",tool:"restic",repositoryId:"repo-main",
    stats:{totalSize:null,totalFileCount:null,totalBlobCount:null,snapshotsCount:null,totalUncompressedSize:null,compressionRatio:null,compressionProgress:null,compressionSpaceSaving:null},
    snapshots:[{id:"abcdef12",shortId:"abcdef12",time:"2026-09-13T10:00:00Z",parent:null,hostname:null,username:null,paths:["/super-secret/path"],tags:[],programVersion:null,totalFilesProcessed:null,totalBytesProcessed:null,dataAdded:null,dataAddedPacked:null}],
    snapshotLimit:250,truncated:false,
  });
  assert.equal(events[0].data.message,"token=[REDACTED]");
  assert.equal(events[0].data.nested[0],"[REDACTED]");
  assert.equal(events[1].snapshots[0].paths[0],"/super-secret/path");
});
