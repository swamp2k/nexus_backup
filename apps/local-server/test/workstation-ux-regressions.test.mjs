import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const webDir=fileURLToPath(new URL("../web/",import.meta.url));

test("workstation UI uses policy repository assignment and exposes deletion",async()=>{
  const source=await readFile(new URL("../web/session.js",import.meta.url),"utf8");
  assert.match(source,/const repositoryAssigned = Boolean\(ws\.policy\?\.repositoryId\)/);
  assert.match(source,/data-ws-action="delete"/);
  assert.match(source,/\/v1\/local\/workstations\/\$\{encodeURIComponent\(ws\.id\)\}.*method: "DELETE"/s);
  assert.match(source,/Existing backup files will be left untouched/);
  assert.doesNotMatch(source,/!status\.repositoryConfigured \|\| !ws\.policy/);
});

test("workstation cards have compact scoped layout",async()=>{
  const styles=await readFile(new URL("../web/styles.css",import.meta.url),"utf8");
  assert.match(styles,/\.workstation-grid\{display:grid;gap:8px\}/);
  assert.match(styles,/\.workstation-card \.transfer-fact\{padding:6px 11px\}/);
  assert.match(styles,/\.workstation-card \.button\.compact\{min-height:24px/);
});

test("gateway exposes workstation-specific delete endpoint",async()=>{
  const gateway=await readFile(new URL("../bin/gateway.mjs",import.meta.url),"utf8");
  assert.match(gateway,/workstationMatch.*\/v1\\\/local\\\/workstations/s);
  assert.match(gateway,/request\.method === "DELETE"/);
  assert.match(gateway,/workstationService\.remove/);
});
