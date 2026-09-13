import assert from "node:assert/strict";
import test from "node:test";
import {
  ResticCheckExecutor,
  StaticAgentRuntimeConfig,
  ToolExitError,
  createDefaultJobExecutor,
} from "../dist/index.js";

function job(id="check-1", payload={repositoryId:"repo-main"}) {
  return {
    id,
    operationKey:`op-${id}`,
    type:"restic-check",
    state:"running",
    attempt:1,
    revision:1,
    payload,
    lease:null,
    createdAt:"2026-09-13T10:00:00.000Z",
    updatedAt:"2026-09-13T10:00:00.000Z",
    startedAt:"2026-09-13T10:00:00.000Z",
    finishedAt:null,
    lastError:null,
  };
}

class FakeRunner {
  constructor(result, lines={}) { this.result=result; this.lines=lines; this.calls=[]; }
  async run(spec,_signal,handlers={}) {
    this.calls.push(spec);
    for(const line of this.lines.stdout??[]) handlers.stdout?.(line);
    for(const line of this.lines.stderr??[]) handlers.stderr?.(line);
    return this.result;
  }
}

function config() {
  return new StaticAgentRuntimeConfig({
    resticRepositories:[{
      id:"repo-main",
      repository:"/backup/restic/main",
      passwordFile:"/config/secrets/restic-password",
      environment:{RESTIC_CACHE_DIR:"/state/restic-cache"},
    }],
    tools:{resticBinary:"/usr/bin/restic"},
  });
}

test("restic integrity check runs read-only check with repository-local credentials",async()=>{
  const events=[];
  const runner=new FakeRunner(
    {exitCode:0,signal:null,durationMs:15,stdoutTail:"no errors were found",stderrTail:""},
    {stdout:["using temporary cache","no errors were found"]},
  );
  const executor=new ResticCheckExecutor(config(),runner,{emit:event=>events.push(event)});
  const result=await executor.execute(job(),new AbortController().signal);

  assert.equal(result.status,"completed");
  assert.equal(runner.calls.length,1);
  assert.equal(runner.calls[0].executable,"/usr/bin/restic");
  assert.deepEqual(runner.calls[0].args,["check"]);
  assert.equal(runner.calls[0].env.RESTIC_REPOSITORY,"/backup/restic/main");
  assert.equal(runner.calls[0].env.RESTIC_PASSWORD_FILE,"/config/secrets/restic-password");
  assert.equal(runner.calls[0].env.RESTIC_CACHE_DIR,"/state/restic-cache");
  assert.ok(events.some(event=>event.type==="log"&&/no errors/i.test(event.message)));
  assert.deepEqual(events.at(-1).data,{operation:"repository-check",repositoryId:"repo-main",integrity:"ok"});
});

test("restic integrity check reports nonzero exit as failure",async()=>{
  const runner=new FakeRunner({exitCode:1,signal:null,durationMs:4,stdoutTail:"",stderrTail:"repository contains errors"});
  const executor=new ResticCheckExecutor(config(),runner);
  await assert.rejects(
    ()=>executor.execute(job(),new AbortController().signal),
    error=>error instanceof ToolExitError&&error.exitCode===1,
  );
});

test("default executor registers integrity checks under the shared restic repository gate",async()=>{
  const runner=new FakeRunner({exitCode:0,signal:null,durationMs:2,stdoutTail:"",stderrTail:""});
  const executor=createDefaultJobExecutor(config(),undefined,runner);
  const result=await executor.execute(job("check-default"),new AbortController().signal);
  assert.equal(result.status,"completed");
  assert.deepEqual(runner.calls[0].args,["check"]);
});

test("restic integrity check rejects missing repository identity before running tools",async()=>{
  const runner=new FakeRunner({exitCode:0,signal:null,durationMs:1,stdoutTail:"",stderrTail:""});
  const executor=new ResticCheckExecutor(config(),runner);
  await assert.rejects(()=>executor.execute(job("bad",{}),new AbortController().signal),/repositoryId/);
  assert.equal(runner.calls.length,0);
});
