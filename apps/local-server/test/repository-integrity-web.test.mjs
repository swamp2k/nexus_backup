import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import test from "node:test";

const telemetryPath=fileURLToPath(new URL("../web/telemetry.js",import.meta.url));

test("repository integrity UI parses and keeps inventory separate from restic check health",async()=>{
  const source=await readFile(telemetryPath,"utf8");
  assert.doesNotThrow(()=>new vm.Script(source,{filename:"telemetry.js"}));
  assert.match(source,/type:\s*"restic-check"/);
  assert.match(source,/\/v1\/local\/jobs\?limit=500/);
  assert.match(source,/Run integrity check/);
  assert.match(source,/Integrity not checked/);
  assert.match(source,/Integrity OK/);
  assert.match(source,/Integrity failed/);
  assert.match(source,/Repository integrity is intentionally separate from inventory/i);
  assert.match(source,/inventory proves that snapshot metadata can be read/i);
  assert.match(source,/only a completed[\s\S]*restic-check is presented as integrity OK/i);
});
