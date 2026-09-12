import assert from "node:assert/strict";
import test from "node:test";
import { RtorrentClient, parseRtorrentResponse } from "../dist/index.js";

const XML=`<?xml version="1.0"?>
<methodResponse><params><param><value><array><data>
  <value><array><data>
    <value><string>ABC123</string></value>
    <value><string>Show &amp; Tell</string></value>
    <value><i8>1</i8></value>
    <value><string>/srv/rtorrent/complete/Show.Complete</string></value>
  </data></array></value>
  <value><array><data>
    <value><string>DEF456</string></value>
    <value><string>Still Downloading</string></value>
    <value><int>0</int></value>
    <value><string>/srv/rtorrent/complete/Show.Downloading</string></value>
  </data></array></value>
</data></array></value></param></params></methodResponse>`;

test("rtorrent parser reads multicall rows and XML entities",()=>{
  assert.deepEqual(parseRtorrentResponse(XML),[
    {hash:"ABC123",name:"Show & Tell",complete:true,basePath:"/srv/rtorrent/complete/Show.Complete"},
    {hash:"DEF456",name:"Still Downloading",complete:false,basePath:"/srv/rtorrent/complete/Show.Downloading"},
  ]);
});

test("rtorrent client sends multicall2 with basic auth without exposing credentials in results",async()=>{
  let request=null;
  const client=new RtorrentClient({
    id:"seedbox-rtorrent",
    url:"https://seedbox.example/RPC2",
    username:"martin",
    password:"secret",
    view:"main",
    sourceBasePath:"/srv/rtorrent/complete",
    required:true,
  },async(url,init)=>{
    request={url:String(url),init};
    return new Response(XML,{status:200,headers:{"content-type":"text/xml"}});
  });
  const torrents=await client.torrents(new AbortController().signal);
  assert.equal(torrents.length,2);
  assert.equal(request.url,"https://seedbox.example/RPC2");
  assert.equal(request.init.method,"POST");
  assert.equal(request.init.headers.get("authorization"),`Basic ${Buffer.from("martin:secret").toString("base64")}`);
  assert.match(request.init.body,/d\.multicall2/);
  assert.match(request.init.body,/d\.complete=/);
  assert.equal(JSON.stringify(torrents).includes("secret"),false);
});

test("rtorrent parser rejects XML-RPC faults",()=>{
  assert.throws(()=>parseRtorrentResponse(`<?xml version="1.0"?><methodResponse><fault><value><string>denied</string></value></fault></methodResponse>`),/XML-RPC fault/);
});
