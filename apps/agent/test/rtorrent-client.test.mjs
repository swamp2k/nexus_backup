import assert from "node:assert/strict";
import test from "node:test";
import { RtorrentClient, parseMulticallResponse, torrentForPath, torrentRelativeRoot } from "../dist/index.js";

const RESPONSE=`<?xml version="1.0"?><methodResponse><params><param><value><array><data>
<value><array><data><value><string>AAA&amp;1</string></value><value><string>Show &lt;One&gt;</string></value><value><i8>1</i8></value><value><string>/srv/rtorrent/complete/Show One</string></value></data></array></value>
<value><array><data><value><string>BBB</string></value><value><string>Busy</string></value><value><i4>0</i4></value><value><string>/srv/rtorrent/complete/Busy</string></value></data></array></value>
</data></array></value></param></params></methodResponse>`;

test("rTorrent XML-RPC parser reads multicall rows and entities",()=>{
  assert.deepEqual(parseMulticallResponse(RESPONSE),[
    {hash:"AAA&1",name:"Show <One>",complete:true,basePath:"/srv/rtorrent/complete/Show One"},
    {hash:"BBB",name:"Busy",complete:false,basePath:"/srv/rtorrent/complete/Busy"},
  ]);
});

test("rTorrent client uses Copyarr d.multicall2 contract and agent-only Basic Auth secret",async()=>{
  let seen=null;let secretPath=null;
  const fetch=async(url,init)=>{seen={url,init};return new Response(RESPONSE,{status:200,headers:{"content-type":"text/xml"}})};
  const client=new RtorrentClient({id:"rt",url:"https://seedbox.example/RPC2",username:"martin",passwordFile:"/state/secrets/rtorrent-password",view:"main",sourceBasePath:"/srv/rtorrent/complete"},{fetch,timeoutMs:5000,loadSecret:async path=>{secretPath=path;return"secret"}});
  const torrents=await client.torrents(new AbortController().signal);
  assert.equal(torrents.length,2);
  assert.equal(secretPath,"/state/secrets/rtorrent-password");
  assert.equal(seen.url,"https://seedbox.example/RPC2");
  assert.match(seen.init.body,/<methodName>d\.multicall2<\/methodName>/);
  assert.match(seen.init.body,/d\.hash=/);
  assert.match(seen.init.body,/d\.base_path=/);
  assert.equal(seen.init.headers.authorization,`Basic ${Buffer.from("martin:secret").toString("base64")}`);
});

test("torrent path mapping strips the private absolute source base and prefers the most specific root",()=>{
  const torrents=[
    {hash:"A",name:"Outer",complete:true,basePath:"/srv/rtorrent/complete/shows"},
    {hash:"B",name:"Specific",complete:false,basePath:"/srv/rtorrent/complete/shows/season"},
  ];
  assert.equal(torrentRelativeRoot("/srv/rtorrent/complete","/srv/rtorrent/complete/shows/season"),"shows/season");
  const match=torrentForPath("shows/season/episode.mkv","/srv/rtorrent/complete",torrents);
  assert.equal(match.root,"shows/season");
  assert.equal(match.torrent.hash,"B");
  assert.equal(torrentForPath("manual/file.txt","/srv/rtorrent/complete",torrents),null);
});

test("rTorrent faults and HTTP failures are surfaced without credential bytes",async()=>{
  assert.throws(()=>parseMulticallResponse(`<methodResponse><fault><value><string>method failed</string></value></fault></methodResponse>`),/method failed/);
  const client=new RtorrentClient({id:"rt",url:"https://seedbox.example/RPC2",username:"user",passwordFile:"/state/secrets/rtorrent-password",sourceBasePath:"/srv/complete"},{fetch:async()=>new Response("nope",{status:502}),loadSecret:async()=>"super-secret"});
  await assert.rejects(()=>client.torrents(new AbortController().signal),error=>{
    assert.match(error.message,/HTTP 502/);
    assert.doesNotMatch(error.message,/super-secret/);
    return true;
  });
});
