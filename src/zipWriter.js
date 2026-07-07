import fs from 'node:fs/promises';
import path from 'node:path';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosTime, dosDate };
}

function u16(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value & 0xffff, 0);
  return buffer;
}

function u32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0, 0);
  return buffer;
}

function normalizeZipPath(name) {
  return String(name || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+/g, '/')
    .split('/')
    .filter((part) => part && part !== '.' && part !== '..')
    .join('/');
}

export async function writeZip(outputPath, entries = []) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  const chunks = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = normalizeZipPath(entry.name);
    if (!name) continue;
    const data = entry.data != null ? Buffer.from(entry.data) : await fs.readFile(entry.path);
    const nameBuffer = Buffer.from(name, 'utf8');
    const modifiedAt = entry.modifiedAt instanceof Date ? entry.modifiedAt : entry.modifiedAt ? new Date(entry.modifiedAt) : new Date();
    const { dosTime, dosDate } = dosDateTime(modifiedAt);
    const crc = crc32(data);
    const size = data.length;
    const localOffset = offset;

    const localHeader = Buffer.concat([
      u32(0x04034b50), // local file header signature
      u16(20), // version needed
      u16(0x0800), // UTF-8 names
      u16(0), // store, no compression
      u16(dosTime),
      u16(dosDate),
      u32(crc),
      u32(size),
      u32(size),
      u16(nameBuffer.length),
      u16(0),
      nameBuffer,
    ]);

    chunks.push(localHeader, data);
    offset += localHeader.length + data.length;

    const centralHeader = Buffer.concat([
      u32(0x02014b50), // central dir signature
      u16(20), // version made by
      u16(20), // version needed
      u16(0x0800),
      u16(0),
      u16(dosTime),
      u16(dosDate),
      u32(crc),
      u32(size),
      u32(size),
      u16(nameBuffer.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(localOffset),
      nameBuffer,
    ]);
    central.push(centralHeader);
  }

  const centralOffset = offset;
  const centralBuffer = Buffer.concat(central);
  offset += centralBuffer.length;

  const eocd = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(central.length),
    u16(central.length),
    u32(centralBuffer.length),
    u32(centralOffset),
    u16(0),
  ]);

  await fs.writeFile(outputPath, Buffer.concat([...chunks, centralBuffer, eocd]));
  return { path: outputPath, entries: central.length, size: offset + eocd.length };
}
