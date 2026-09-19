import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { createSourceScanStore } from "../lib/source-scan-store.mjs";

test("source scan store streams artifacts to a deterministic per-run path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nexus-source-scan-store-"));
  try {
    const store = createSourceScanStore({ root: dir, maxBytes: 1024 });
    const saved = await store.write("device-1", "wsrun-1", Readable.from([Buffer.from("gzip-ish")]));
    assert.equal(saved.key, "device-1/wsrun-1.ndjson.gz");
    assert.equal(saved.sizeBytes, 8);
    assert.equal(await store.exists("device-1", "wsrun-1"), true);
    const opened = await store.openArtifact(saved.key);
    const chunks = [];
    for await (const chunk of opened.stream) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString(), "gzip-ish");
    assert.equal((await readFile(join(dir, saved.key))).toString(), "gzip-ish");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("source scan store aborts oversized streamed artifacts without leaving a partial file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nexus-source-scan-store-"));
  try {
    const store = createSourceScanStore({ root: dir, maxBytes: 4 });
    await assert.rejects(
      () => store.write("device-1", "wsrun-1", Readable.from([Buffer.from("12345")])),
      /exceeds 1 MiB/,
    );
    assert.equal(await store.exists("device-1", "wsrun-1"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
