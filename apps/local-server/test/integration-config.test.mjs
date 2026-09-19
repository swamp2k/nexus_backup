import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createIntegrationConfigService } from "../lib/integration-config.mjs";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "nexus-integrations-"));
  const configPath = join(dir, "integrations.json");
  const rclonePath = join(dir, "rclone");
  await writeFile(rclonePath, `#!/bin/sh
if [ "$1" = "config" ] && [ "$2" = "providers" ]; then
  echo '[{"Name":"sftp","Options":[{"Name":"host"},{"Name":"user"},{"Name":"pass","IsPassword":true}]},{"Name":"local","Options":[]}]'
  exit 0
fi
if [ "$1" = "obscure" ]; then echo "obscured:$2"; exit 0; fi
if [ "$1" = "lsjson" ]; then
  case "$2" in
    *'pass=hunter2'*|*'pass="hunter2"'*) echo "plaintext password reached rclone" >&2; exit 9 ;;
    *) exit 0 ;;
  esac
fi
exit 0
`);
  await chmod(rclonePath, 0o755);
  const service = createIntegrationConfigService({ path: configPath, id: () => "fixed-id", rcloneBinary: rclonePath });
  return { dir, configPath, service, async close() { await rm(dir, { recursive: true, force: true }); } };
}

test("sources: create, update, delete round-trip through the JSON file", async () => {
  const f = await fixture();
  try {
    const created = await f.service.createSource({ id: "documents", paths: ["C:\\Users\\swamp\\Documents", "C:\\Users\\swamp\\Documents"] });
    assert.equal(created.id, "documents");
    assert.deepEqual(created.paths, ["C:\\Users\\swamp\\Documents"]); // deduped

    const onDisk = JSON.parse(await readFile(f.configPath, "utf8"));
    assert.equal(onDisk.sources.length, 1);

    await assert.rejects(() => f.service.createSource({ id: "documents", paths: ["x"] }), /already exists/);

    const updated = await f.service.updateSource("documents", { paths: ["D:\\Docs"] });
    assert.deepEqual(updated.paths, ["D:\\Docs"]);

    assert.deepEqual((await f.service.listSources()).map((s) => s.id), ["documents"]);

    await f.service.deleteSource("documents");
    assert.deepEqual(await f.service.listSources(), []);
    await assert.rejects(() => f.service.deleteSource("documents"), /not found/);
  } finally { await f.close(); }
});

test("sources: rejects unsafe ids and empty path lists", async () => {
  const f = await fixture();
  try {
    await assert.rejects(() => f.service.createSource({ id: "../etc", paths: ["x"] }), /1-64 characters/);
    await assert.rejects(() => f.service.createSource({ id: "ok", paths: [] }), /1-50 entries/);
  } finally { await f.close(); }
});

test("destinations: builds an obscured connection string and never returns it", async () => {
  const f = await fixture();
  try {
    const created = await f.service.createDestination({
      id: "seedbox",
      type: "sftp",
      params: { host: "example.com", user: "swamp", pass: "hunter2" },
      providerOptions: [{ Name: "host" }, { Name: "user" }, { Name: "pass", IsPassword: true }],
      allowMove: true,
    });
    assert.equal(created.id, "seedbox");
    assert.equal(created.type, "sftp");
    assert.equal(created.allowMove, true);
    assert.equal(created.summary, "sftp · example.com · swamp");
    assert.equal(created.fs, undefined, "the connection string must never be sent to the client");
    assert.equal(created.params, undefined, "raw params must never be sent to the client");

    const onDisk = JSON.parse(await readFile(f.configPath, "utf8"));
    assert.equal(onDisk.rcloneEndpoints.length, 1);
    assert.equal(onDisk.rcloneEndpoints[0].fs, ':sftp,host=example.com,user=swamp,pass="obscured:hunter2":');
  } finally { await f.close(); }
});

test("destinations: connection test obscures passwords using the server-side provider schema", async () => {
  const f = await fixture();
  try {
    const result = await f.service.testDestinationParams({
      type: "sftp",
      params: { host: "example.com", user: "swamp", pass: "hunter2" },
      // A browser must not be able to downgrade a secret field to plaintext.
      providerOptions: [{ Name: "pass", IsPassword: false }],
    });
    assert.deepEqual(result, { ok: true });
  } finally { await f.close(); }
});

test("destinations: update without params keeps the existing connection string", async () => {
  const f = await fixture();
  try {
    await f.service.createDestination({
      id: "seedbox", type: "sftp", params: { host: "example.com", pass: "hunter2" },
      providerOptions: [{ Name: "pass", IsPassword: true }],
    });
    const before = JSON.parse(await readFile(f.configPath, "utf8")).rcloneEndpoints[0].fs;

    const updated = await f.service.updateDestination("seedbox", { allowMove: true });
    assert.equal(updated.allowMove, true);

    const after = JSON.parse(await readFile(f.configPath, "utf8")).rcloneEndpoints[0].fs;
    assert.equal(after, before);
  } finally { await f.close(); }
});

test("destinations: update with new params replaces the connection string", async () => {
  const f = await fixture();
  try {
    await f.service.createDestination({ id: "seedbox", type: "sftp", params: { host: "old.example.com" } });
    await f.service.updateDestination("seedbox", { params: { host: "new.example.com" } });
    const onDisk = JSON.parse(await readFile(f.configPath, "utf8"));
    assert.equal(onDisk.rcloneEndpoints[0].fs, ":sftp,host=new.example.com:");
  } finally { await f.close(); }
});

test("destinations: delete removes it and leaves other config keys untouched", async () => {
  const f = await fixture();
  try {
    await writeFile(f.configPath, JSON.stringify({ sources: [], rcloneEndpoints: [], rtorrentGates: [{ id: "gate-1", required: true }], tools: { rcloneBinary: "rclone" } }));
    await f.service.createDestination({ id: "seedbox", type: "local", params: {} });
    await f.service.deleteDestination("seedbox");

    const onDisk = JSON.parse(await readFile(f.configPath, "utf8"));
    assert.deepEqual(onDisk.rcloneEndpoints, []);
    assert.deepEqual(onDisk.rtorrentGates, [{ id: "gate-1", required: true }]);
    assert.deepEqual(onDisk.tools, { rcloneBinary: "rclone" });
  } finally { await f.close(); }
});

test("a missing integrations.json is treated as an empty, valid config", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await f.service.listSources(), []);
    assert.deepEqual(await f.service.listDestinations(), []);
  } finally { await f.close(); }
});
