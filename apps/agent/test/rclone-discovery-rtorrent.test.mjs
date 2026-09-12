import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { RcloneDiscoveryExecutor, StaticAgentRuntimeConfig } from "../dist/index.js";

const RPC=`<?xml version="1.0"?><methodResponse><params><param><value><array><data>
<value><array><data><value><string>AAA</string></value><value><string>Done</string></value><value><i8>1</i8></value><value><string>/srv/complete/done</string></value></data></array></value>
<value><array><data><value><string>BBB</string></value><value><string>Busy</string></value><value><i8>0</i8></value><value><string>/srv/complete/busy</string></value></data></array></value>
</data></array></value></param></params></methodResponse>`;
const LISTING=JSON.stringify([
  {Path:"done/file.mkv",Size:100,ModTime:"2026-09-12T10:00:00Z",IsDir:false},
  {Path:"busy/file.mkv",Size:200,ModTime:"2026-09-12T10:00:00Z",IsDir:false},
  {Path:"manual/readme.txt",Size:10,ModTime:"2026-09-12T10:00:00Z",IsDir:false},
]);

class Runner {
  constructor(){this.calls=[];}
  async run(spec,_signal,handlers={}){this.calls.push(spec);handlers.stdout?.(LISTING);return{exitCode:0,signal:null,durationMs:1,stdoutTail:LISTING,stderrTail:""};}
}
function job(payload){return{id:"scan-1",operationKey:"scan",type:"rclone-discovery",state:"running",attempt:1,revision:1,payload,lease:null,createdAt:"2026-09-12T10:00:00Z",updatedAt:"2026-09-12T10:00:00Z",startedAt:"2026-09-12T10:00:00Z",finishedAt:null,lastError:null};}
async function withServer(handler,callback){
  const server=createServer(handler);await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve)});
  try{const address=server.address();return await callback(`http://127.0.0.1:${address.port}/RPC2`);}finally{await new Promise(resolve=>server.close(resolve));}
}
function config(url){return new StaticAgentRuntimeConfig({rcloneEndpoints:[{id:"seedbox",fs:"seedbox:"}],rtorrentEndpoints:[{id:"rt",url,sourceBasePath:"/srv/complete"}]});}

test("discovery marks complete/incomplete torrent paths and leaves unknown files on stability",async()=>{
  await withServer((request,response)=>{let body="";request.on("data",chunk=>body+=chunk);request.on("end",()=>{assert.match(body,/d\.multicall2/);response.writeHead(200,{"content-type":"text/xml"});response.end(RPC);});},async url=>{
    const runner=new Runner(),events=[];
    const executor=new RcloneDiscoveryExecutor(config(url),runner,{emit:event=>events.push(event)});
    await executor.execute(job({ruleId:"rule",sourceEndpointId:"seedbox",sourcePath:"complete",includes:[],excludes:[],rtorrentEndpointId:"rt",rtorrentRequired:true}),new AbortController().signal);
    const event=events.find(item=>item.type==="transfer-discovery");
    assert.deepEqual(event.rtorrent,{configured:true,available:true});
    assert.equal(event.entries.find(item=>item.relPath==="done/file.mkv").readiness,"rtorrent_complete");
    assert.equal(event.entries.find(item=>item.relPath==="busy/file.mkv").readiness,"rtorrent_incomplete");
    assert.equal(event.entries.find(item=>item.relPath==="manual/readme.txt").readiness,"stability");
    assert.equal(event.entries.find(item=>item.relPath==="done/file.mkv").torrentRoot,"done");
    assert.equal(runner.calls.length,1);
  });
});

test("optional rTorrent outage falls back to stability",async()=>{
  await withServer((_request,response)=>{response.writeHead(503);response.end("offline");},async url=>{
    const runner=new Runner(),events=[];
    const executor=new RcloneDiscoveryExecutor(config(url),runner,{emit:event=>events.push(event)});
    await executor.execute(job({ruleId:"rule",sourceEndpointId:"seedbox",sourcePath:"complete",includes:[],excludes:[],rtorrentEndpointId:"rt",rtorrentRequired:false}),new AbortController().signal);
    const event=events.find(item=>item.type==="transfer-discovery");
    assert.deepEqual(event.rtorrent,{configured:true,available:false});
    assert.ok(event.entries.every(item=>item.readiness==="stability"));
    assert.ok(events.some(item=>item.type==="log"&&/stability fallback/.test(item.message)));
  });
});

test("required rTorrent outage fails before source discovery",async()=>{
  await withServer((_request,response)=>{response.writeHead(503);response.end("offline");},async url=>{
    const runner=new Runner();
    const executor=new RcloneDiscoveryExecutor(config(url),runner);
    await assert.rejects(()=>executor.execute(job({ruleId:"rule",sourceEndpointId:"seedbox",sourcePath:"complete",includes:[],excludes:[],rtorrentEndpointId:"rt",rtorrentRequired:true}),new AbortController().signal),/required but unavailable/);
    assert.equal(runner.calls.length,0);
  });
});
