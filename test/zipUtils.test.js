import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { validateZipFile } from '../src/zipUtils.js';
import { writeZip } from '../src/zipWriter.js';

function dosTimeDate() { return { time: 0, date: 0 }; }

function makeTinyZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const { time, date } = dosTimeDate();

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const content = Buffer.from(entry.content || '', 'utf8');
    const local = Buffer.alloc(30 + name.length + content.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    content.copy(local, 30 + name.length);
    locals.push(local);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);
    offset += local.length;
  }

  const centralDir = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralDir, eocd]);
}

test('validateZipFile accepts a simple safe zip and returns a manifest', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-zip-'));
  const file = path.join(dir, 'project.zip');
  await fs.writeFile(file, makeTinyZip([{ name: 'src/index.js', content: 'console.log(1);' }]));
  const result = await validateZipFile(file);
  assert.equal(result.ok, true);
  assert.equal(result.entries, 1);
  assert.equal(result.files[0].path, 'src/index.js');
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
});

test('validateZipFile rejects path traversal entries', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-zip-'));
  const file = path.join(dir, 'bad.zip');
  await fs.writeFile(file, makeTinyZip([{ name: '../evil.js', content: 'x' }]));
  await assert.rejects(() => validateZipFile(file), /unsafe path/);
});

test('writeZip can losslessly deflate repetitive diagnostic payloads', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-zip-deflate-'));
  const file = path.join(dir, 'diagnostics.zip');
  const data = Buffer.from(`${JSON.stringify({ type: 'request.progress', answerLength: 100 })}\n`.repeat(20_000));
  const result = await writeZip(file, [{ name: 'browser-debug.ndjson', data }], { compression: 'deflate' });
  const stat = await fs.stat(file);
  const validation = await validateZipFile(file);

  assert.equal(validation.ok, true);
  assert.equal(validation.files[0].path, 'browser-debug.ndjson');
  assert.equal(result.uncompressedSize, data.length);
  assert.ok(stat.size < data.length / 10, `expected ${stat.size} to be much smaller than ${data.length}`);
});

