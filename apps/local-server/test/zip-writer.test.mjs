import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import test from "node:test";
import { collectZipEntries, createStoreZipStream } from "../lib/zip-writer.mjs";

async function readAll(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// Minimal reader for the archive Nexus itself just wrote: walks the central
// directory (which always carries the real sizes/CRCs) and slices each
// entry's stored bytes straight out of the buffer using its local header.
function readZipEntries(buffer) {
  const endSig = buffer.readUInt32LE(buffer.length - 22);
  assert.equal(endSig, 0x06054b50);
  const centralCount = buffer.readUInt16LE(buffer.length - 22 + 10);
  const centralOffset = buffer.readUInt32LE(buffer.length - 22 + 16);
  const entries = [];
  let cursor = centralOffset;
  for (let i = 0; i < centralCount; i++) {
    assert.equal(buffer.readUInt32LE(cursor), 0x02014b50);
    const crc = buffer.readUInt32LE(cursor + 16);
    const size = buffer.readUInt32LE(cursor + 20);
    const nameLen = buffer.readUInt16LE(cursor + 28);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString("utf8", cursor + 46, cursor + 46 + nameLen);
    cursor += 46 + nameLen;

    assert.equal(buffer.readUInt32LE(localHeaderOffset), 0x04034b50);
    const localNameLen = buffer.readUInt16LE(localHeaderOffset + 26);
    const dataStart = localHeaderOffset + 30 + localNameLen;
    const data = buffer.subarray(dataStart, dataStart + size);
    assert.equal(crc32(data) >>> 0, crc, `crc mismatch for ${name}`);
    entries.push({ name, data });
  }
  return entries;
}

test("collectZipEntries recurses into directories with sorted, stable arcnames", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nexus-zip-"));
  try {
    await mkdir(join(dir, "sub"), { recursive: true });
    await writeFile(join(dir, "root.txt"), "root file");
    await writeFile(join(dir, "sub", "nested.txt"), "nested file");

    const entries = await collectZipEntries([{ absolute: dir, arcname: "selection" }]);
    const names = entries.map((entry) => entry.arcname).sort();
    assert.deepEqual(names, ["selection/root.txt", "selection/sub/nested.txt"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("createStoreZipStream produces an archive with unmodified, uncompressed file bytes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nexus-zip-"));
  try {
    await writeFile(join(dir, "a.txt"), "hello nexus");
    await writeFile(join(dir, "b.txt"), "second file content");
    const entries = await collectZipEntries([
      { absolute: join(dir, "a.txt"), arcname: "a.txt" },
      { absolute: join(dir, "b.txt"), arcname: "b.txt" },
    ]);
    const buffer = await readAll(createStoreZipStream(entries));
    const zipEntries = readZipEntries(buffer);
    assert.deepEqual(zipEntries.map((entry) => entry.name).sort(), ["a.txt", "b.txt"]);
    assert.equal(zipEntries.find((entry) => entry.name === "a.txt").data.toString("utf8"), "hello nexus");
    assert.equal(zipEntries.find((entry) => entry.name === "b.txt").data.toString("utf8"), "second file content");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("collectZipEntries rejects an empty selection", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nexus-zip-"));
  try {
    await mkdir(join(dir, "empty"), { recursive: true });
    await assert.rejects(() => collectZipEntries([{ absolute: join(dir, "empty"), arcname: "empty" }]), /No files were found/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
