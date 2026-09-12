import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const indexPath=new URL("../web/index.html",import.meta.url);

test("dashboard inline modules remain syntactically valid",async()=>{
  const html=await readFile(indexPath,"utf8");
  const modules=[...html.matchAll(/<script\s+type="module"\s*>([\s\S]*?)<\/script>/g)].map(match=>match[1]);
  assert.ok(modules.length>=2,"expected device and transfer enhancement inline modules");
  modules.forEach((source,index)=>{
    assert.doesNotThrow(()=>new Function(source),`inline module ${index+1} should parse`);
  });
});
