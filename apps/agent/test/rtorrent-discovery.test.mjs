import assert from "node:assert/strict";
import test from "node:test";
import { RcloneDiscoveryExecutor, StaticAgentRuntimeConfig } from "../dist/index.js";

const XML=`<?xml version="1.0"?><methodResponse><params><param><value><array><data>
<value><array><data><value><string>A</string></value><value><string>Complete</string></value><value><i8>1</i8></value><value><string>/srv/rtorrent/complete/Show.Complete</string></value></data></array></value>
<value><array><data><value><string>B</string></value><value><string>Downloading</string></value><value><i8>0</i8></value><value><string>/srv/rtorrent/complete/Show.Downloading</string></value></data></array></value>
</data></array></value></param></params></methodResponse>`;
const LISTING=JSON.stringify([
  {Path:"Show.Complete/episode.mkv",Name:"episode.mkv",Size:42,ModTime:"2026-09-12T09:00:00Z",IsDir:false},
  {Path:"Show.Downloading/episode.mkv",Name:"episode.mkv",Size:41,ModTime:"2026-09-12T09:00:00Z",IsDir:false},
  {Path:"manual.txt",Name:"manual.txt",Size:2,ModTime:"2026-09-12T09:00:00Z",IsDir:false},
]);
function config(required=true){return new StaticAgentRuntimeConfig({
  rcloneEndpoints:[{id:"seedbox",fs:"seedbox:"}],
  rtorrentGates:[{id:"rtorrent",url:"https://seedbox.example/RPC2",sourceBasePath:"/srv/rtorrent/complete",required}],
});}
function job(){return{id:"scan",operationKey:"scan",type:"rclone-discovery",state:"running",attempt:1,revision:1,payload:{ruleId:"rule",sourceEndpointId:"seedbox",sourcePath:"complete",includes:[],excludes:[],rtorrentGateId:"rtorrent"},lease:null,createdAt:"2026-09-12T10:00:00Z",updatedAt:"2026-09-12T10:00:00Z",startedAt:"2026-09-12T10:00:00Z",finishedAt:null,lastError:null};}
class Runner{async run(_spec,_signal,handlers={}){handlers.stdout?.(LISTING);return{exitCode:0,signal:null,durationMs:1,stdoutTail:LISTING,stderrTail:""};}}

test("known incomplete torrent paths are held back while complete and unknown files pass",async()=>{
  const original=globalThis.fetch;const events=[];
  globalThis.fetch=async()=>new Response(XML,{status:200});
  try{
    const executor=new RcloneDiscoveryExecutor(config(true),new Runner(),{emit:event=>events.push(event)});
    await executor.execute(job(),new AbortController().signal);
    const discovery=events.find(event=>event.type==="transfer-discovery");
    assert.deepEqual(discovery.entries.map(entry=>entry.relPath),["Show.Complete/episode.mkv","manual.txt"]);
    const summary=events.find(event=>event.type==="summary");
    assert.equal(summary.data.rtorrent.blockedIncompleteFiles,1);
    assert.equal(summary.data.rtorrent.complete,1);
  }finally{globalThis.fetch=original;}
});

test("required rtorrent outage fails the scan",async()=>{
  const original=globalThis.fetch;globalThis.fetch=async()=>{throw new Error("offline")};
  try{
    const executor=new RcloneDiscoveryExecutor(config(true),new Runner());
    await assert.rejects(()=>executor.execute(job(),new AbortController().signal),/rtorrent required: offline/);
  }finally{globalThis.fetch=original;}
});

test("optional rtorrent outage falls back to the stability listing",async()=>{
  const original=globalThis.fetch;const events=[];globalThis.fetch=async()=>{throw new Error("offline")};
  try{
    const executor=new RcloneDiscoveryExecutor(config(false),new Runner(),{emit:event=>events.push(event)});
    await executor.execute(job(),new AbortController().signal);
    const discovery=events.find(event=>event.type==="transfer-discovery");
    assert.equal(discovery.entries.length,3);
    assert.ok(events.some(event=>event.type==="log"&&/stability fallback/.test(event.message)));
  }finally{globalThis.fetch=original;}
});
