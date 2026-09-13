import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { normalizeExplicitOrigin, resolvePublicOrigin } from "../lib/public-origin.mjs";

test("direct LAN enrollment uses only the validated request Host",()=>{
  assert.equal(resolvePublicOrigin({configured:null,host:"192.168.1.20:8787",fallbackHost:"127.0.0.1:8787"}),"http://192.168.1.20:8787");
  assert.equal(resolvePublicOrigin({configured:null,host:"[2001:db8::1]:8787",fallbackHost:"127.0.0.1:8787"}),"http://[2001:db8::1]:8787");
  assert.throws(()=>resolvePublicOrigin({configured:null,host:"good.local,evil.example",fallbackHost:"127.0.0.1:8787"}),/valid public authority/);
  assert.throws(()=>resolvePublicOrigin({configured:null,host:"user@evil.example",fallbackHost:"127.0.0.1:8787"}),/valid public authority/);
});

test("reverse proxy deployments require an explicit clean http(s) origin",()=>{
  assert.equal(normalizeExplicitOrigin("https://backup.example.test:8443"),"https://backup.example.test:8443");
  assert.equal(resolvePublicOrigin({configured:"https://backup.example.test",host:"poisoned.invalid",fallbackHost:null}),"https://backup.example.test");
  assert.throws(()=>normalizeExplicitOrigin("https://user:secret@backup.example.test"),/without credentials/);
  assert.throws(()=>normalizeExplicitOrigin("https://backup.example.test/nexus"),/without credentials/);
  assert.throws(()=>normalizeExplicitOrigin("ftp://backup.example.test"),/http\(s\)/);
});

test("gateway never trusts forwarded origin headers for workstation installer commands",async()=>{
  const gateway=await readFile(fileURLToPath(new URL("../bin/gateway.mjs",import.meta.url)),"utf8");
  assert.equal(gateway.includes("x-forwarded-host"),false);
  assert.equal(gateway.includes("x-forwarded-proto"),false);
  assert.match(gateway,/NEXUS_BACKUP_PUBLIC_URL/);
  assert.match(gateway,/resolvePublicOrigin/);
});
