import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildRcloneConnectionString, getRcloneProviders, obscureRcloneValue, testRcloneFs } from "../lib/rclone-providers.mjs";

// CI has no real rclone binary, and this project has zero npm dependencies
// to fetch one with, so these tests drive the module against a tiny fake
// rclone script instead. It exercises the same spawn/parse/error-handling
// code paths as the real binary without requiring it to be installed.
async function fakeRclone(script) {
  const dir = await mkdtemp(join(tmpdir(), "fake-rclone-"));
  const path = join(dir, "rclone");
  await writeFile(path, `#!/bin/sh\n${script}\n`);
  await chmod(path, 0o755);
  return { path, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("getRcloneProviders parses and caches the provider list per binary call", async () => {
  const fake = await fakeRclone(`
    if [ "$1" = "config" ] && [ "$2" = "providers" ]; then
      echo '[{"Name":"sftp","Options":[{"Name":"host","IsPassword":false},{"Name":"pass","IsPassword":true}]}]'
      exit 0
    fi
    exit 1
  `);
  try {
    const providers = await getRcloneProviders({ binary: fake.path, refresh: true });
    assert.equal(providers.length, 1);
    assert.equal(providers[0].Name, "sftp");
    assert.ok(providers[0].Options.some((option) => option.Name === "pass" && option.IsPassword));
  } finally { await fake.cleanup(); }
});

test("getRcloneProviders surfaces a clear error when rclone fails", async () => {
  const fake = await fakeRclone(`echo "boom" >&2; exit 1`);
  try {
    await assert.rejects(() => getRcloneProviders({ binary: fake.path, refresh: true }), /rclone config providers failed.*boom/s);
  } finally { await fake.cleanup(); }
});

test("buildRcloneConnectionString produces rclone's inline config-less syntax", () => {
  const fs = buildRcloneConnectionString("sftp", { host: "example.com", user: "swamp", port: "22" });
  assert.equal(fs, ":sftp,host=example.com,user=swamp,port=22:");
});

test("buildRcloneConnectionString quotes values containing separators", () => {
  const fs = buildRcloneConnectionString("local", { note: 'a,b:c"d' });
  assert.equal(fs, ':local,note="a,b:c""d":');
});

test("buildRcloneConnectionString omits empty parameters", () => {
  const fs = buildRcloneConnectionString("sftp", { host: "example.com", pass: "" });
  assert.equal(fs, ":sftp,host=example.com:");
});

test("buildRcloneConnectionString rejects a type or key with unsafe characters", () => {
  assert.throws(() => buildRcloneConnectionString("s ftp", {}), /whitespace|colons|commas/);
  assert.throws(() => buildRcloneConnectionString("sftp", { "ba:d": "x" }), /whitespace|colons|commas/);
});

test("obscureRcloneValue returns whatever rclone prints, trimmed", async () => {
  const fake = await fakeRclone(`
    if [ "$1" = "obscure" ]; then echo "  obscured-form  "; exit 0; fi
    exit 1
  `);
  try {
    assert.equal(await obscureRcloneValue("hunter2", { binary: fake.path }), "obscured-form");
  } finally { await fake.cleanup(); }
});

test("obscureRcloneValue throws with rclone's stderr on failure", async () => {
  const fake = await fakeRclone(`echo "bad input" >&2; exit 1`);
  try {
    await assert.rejects(() => obscureRcloneValue("x", { binary: fake.path }), /rclone obscure failed.*bad input/s);
  } finally { await fake.cleanup(); }
});

test("testRcloneFs reports success when rclone exits 0", async () => {
  const fake = await fakeRclone(`exit 0`);
  try {
    assert.deepEqual(await testRcloneFs(":sftp,host=x:", { binary: fake.path }), { ok: true });
  } finally { await fake.cleanup(); }
});

test("testRcloneFs reports failure without leaking the fs string into the message", async () => {
  const fake = await fakeRclone(`echo "could not connect to :sftp,host=x,pass=secret:" >&2; exit 1`);
  try {
    const fsSpec = ":sftp,host=x,pass=secret:";
    const result = await testRcloneFs(fsSpec, { binary: fake.path });
    assert.equal(result.ok, false);
    assert.ok(!result.message.includes(fsSpec), "error message should not echo the raw fs string back");
    assert.ok(result.message.includes("<remote>"));
  } finally { await fake.cleanup(); }
});

test("testRcloneFs times out against a hanging rclone process", async () => {
  // exec replaces the shell with sleep in-place (no forked grandchild), so
  // SIGTERM to this one process closes its stdio immediately instead of
  // leaving an orphaned sleep holding the pipe open until it exits on its own.
  const fake = await fakeRclone(`exec sleep 5`);
  try {
    const started = Date.now();
    const result = await testRcloneFs(":sftp,host=x:", { binary: fake.path, timeoutMs: 200 });
    assert.equal(result.ok, false);
    assert.match(result.message, /timed out/);
    assert.ok(Date.now() - started < 4000, "should not wait for the full hang once aborted");
  } finally { await fake.cleanup(); }
});
