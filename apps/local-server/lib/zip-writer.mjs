import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { Readable } from "node:stream";

const LOCAL_FILE_HEADER_SIG = 0x04034b50;
const DATA_DESCRIPTOR_SIG = 0x08074b50;
const CENTRAL_DIR_SIG = 0x02014b50;
const END_OF_CENTRAL_DIR_SIG = 0x06054b50;
const FLAGS = 0x0808; // bit 3: sizes/crc follow in a data descriptor; bit 11: UTF-8 names
const MAX_STORE_SIZE = 0xfffffffe; // no Zip64 support: single files must stay under ~4 GiB

// Every entry Nexus stores is an ordinary file, so the archive uses the Store
// method (no compression) and streams file bytes straight through, computing
// the CRC-32 as they pass rather than buffering a whole file in memory.
export async function collectZipEntries(targets) {
  const files = [];
  for (const target of targets) {
    const info = await stat(target.absolute);
    if (info.isDirectory()) {
      await walkDirectory(target.absolute, target.arcname, files);
    } else if (info.isFile()) {
      if (info.size > MAX_STORE_SIZE) throw zipError(400, `File is too large to include in a zip: ${target.arcname}`);
      files.push({ absolute: target.absolute, arcname: target.arcname, size: info.size, mtime: info.mtime });
    }
  }
  if (!files.length) throw zipError(400, "No files were found to download");
  return files;
}

async function walkDirectory(absoluteDir, arcnamePrefix, out) {
  const entries = await readdir(absoluteDir, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) continue;
    const absolute = join(absoluteDir, entry.name);
    const arcname = `${arcnamePrefix}/${entry.name}`;
    if (entry.isDirectory()) { await walkDirectory(absolute, arcname, out); continue; }
    if (!entry.isFile()) continue;
    const info = await stat(absolute);
    if (info.size > MAX_STORE_SIZE) throw zipError(400, `File is too large to include in a zip: ${arcname}`);
    out.push({ absolute, arcname, size: info.size, mtime: info.mtime });
  }
}

export function createStoreZipStream(entries) {
  return Readable.from(generateZip(entries));
}

async function* generateZip(entries) {
  let offset = 0;
  const central = [];
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.arcname, "utf8");
    const { date, time } = dosDateTime(entry.mtime);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(LOCAL_FILE_HEADER_SIG, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(FLAGS, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(0, 14);
    header.writeUInt32LE(0, 18);
    header.writeUInt32LE(0, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(0, 28);
    const localHeaderOffset = offset;
    yield header; offset += header.length;
    yield nameBuf; offset += nameBuf.length;

    let crc = 0, size = 0;
    for await (const chunk of createReadStream(entry.absolute)) {
      crc = crc32(chunk, crc);
      size += chunk.length;
      offset += chunk.length;
      yield chunk;
    }

    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(DATA_DESCRIPTOR_SIG, 0);
    descriptor.writeUInt32LE(crc >>> 0, 4);
    descriptor.writeUInt32LE(size, 8);
    descriptor.writeUInt32LE(size, 12);
    yield descriptor; offset += descriptor.length;

    central.push({ nameBuf, crc: crc >>> 0, size, time, date, localHeaderOffset });
  }

  const centralStart = offset;
  for (const item of central) {
    const record = Buffer.alloc(46);
    record.writeUInt32LE(CENTRAL_DIR_SIG, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(FLAGS, 8);
    record.writeUInt16LE(0, 10);
    record.writeUInt16LE(item.time, 12);
    record.writeUInt16LE(item.date, 14);
    record.writeUInt32LE(item.crc, 16);
    record.writeUInt32LE(item.size, 20);
    record.writeUInt32LE(item.size, 24);
    record.writeUInt16LE(item.nameBuf.length, 28);
    record.writeUInt16LE(0, 30);
    record.writeUInt16LE(0, 32);
    record.writeUInt16LE(0, 34);
    record.writeUInt16LE(0, 36);
    record.writeUInt32LE(0, 38);
    record.writeUInt32LE(item.localHeaderOffset, 42);
    yield record; offset += record.length;
    yield item.nameBuf; offset += item.nameBuf.length;
  }
  const centralSize = offset - centralStart;

  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL_DIR_SIG, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralStart, 16);
  end.writeUInt16LE(0, 20);
  yield end;
}

function dosDateTime(mtime) {
  const value = mtime instanceof Date && !Number.isNaN(mtime.getTime()) ? mtime : new Date();
  const year = Math.min(2107, Math.max(1980, value.getFullYear()));
  const date = ((year - 1980) << 9) | ((value.getMonth() + 1) << 5) | value.getDate();
  const time = (value.getHours() << 11) | (value.getMinutes() << 5) | Math.floor(value.getSeconds() / 2);
  return { date, time };
}

function zipError(statusCode, message) { const error = new Error(message); error.statusCode = statusCode; return error; }
