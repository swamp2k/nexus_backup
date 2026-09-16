import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const maintenanceUrl = new URL("../web/maintenance.js", import.meta.url);

test("workstation cards expose a tokenless update and repair command", async () => {
  const source = await readFile(maintenanceUrl, "utf8");
  assert.match(source, /data-ws-repair/);
  assert.match(source, /Update \/ repair/);
  assert.match(source, /NEXUS_BACKUP_URL/);
  assert.match(source, /\/install\.ps1/);
  assert.doesNotMatch(source, /NEXUS_BACKUP_TOKEN='\$\{/);
});

test("workstation repair copy works on plain-LAN HTTP browsers", async () => {
  const source = await readFile(maintenanceUrl, "utf8");
  assert.match(source, /navigator\.clipboard\?\.writeText&&window\.isSecureContext/);
  assert.match(source, /document\.execCommand\("copy"\)/);
});
