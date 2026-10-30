'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { extractExecutableIcon } = require('../src/executable-icon.cjs');

function chunk(type, data) {
  const name = Buffer.from(type), checksumInput = Buffer.concat([name, data]);
  let crc = 0xffffffff;
  for (const byte of checksumInput) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  const output = Buffer.alloc(data.length + 12);
  output.writeUInt32BE(data.length); name.copy(output, 4); data.copy(output, 8);
  output.writeUInt32BE((crc ^ 0xffffffff) >>> 0, data.length + 8);
  return output;
}
function png(width, height, padding = 0) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    ...(padding ? [chunk('tEXt', Buffer.alloc(padding, 97))] : []),
    chunk('IDAT', zlib.deflateSync(Buffer.alloc((width * 4 + 1) * height))), chunk('IEND', Buffer.alloc(0))]);
}
function dib(width, height, storedBgra, mask = Buffer.alloc(Math.ceil(width / 32) * 4 * height)) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40); header.writeInt32LE(width, 4); header.writeInt32LE(height * 2, 8);
  header.writeUInt16LE(1, 12); header.writeUInt16LE(32, 14);
  return Buffer.concat([header, Buffer.from(storedBgra), mask]);
}
function decodedRgba(dataUrl) {
  const bytes = Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64');
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20), image = [];
  for (let offset = 8; offset < bytes.length;) {
    const size = bytes.readUInt32BE(offset);
    if (bytes.toString('ascii', offset + 4, offset + 8) === 'IDAT') image.push(bytes.subarray(offset + 8, offset + 8 + size));
    offset += 12 + size;
  }
  const raw = zlib.inflateSync(Buffer.concat(image)), pixels = [];
  for (let row = 0; row < height; row++) pixels.push(...raw.subarray(row * (width * 4 + 1) + 1, (row + 1) * (width * 4 + 1)));
  return { width, height, pixels };
}
function pe(images, pe32 = false) {
  const directoryEnd = 48 + images.length * 8;
  const dataEntries = directoryEnd + images.length * 24;
  const payloadStart = dataEntries + images.length * 16;
  const resources = Buffer.alloc(payloadStart + images.reduce((sum, image) => sum + image.length, 0));
  resources.writeUInt16LE(1, 14); resources.writeUInt32LE(3, 16); resources.writeUInt32LE(0x80000020, 20);
  resources.writeUInt16LE(images.length, 32 + 14);
  let payload = payloadStart;
  images.forEach((image, index) => {
    const language = directoryEnd + index * 24, data = dataEntries + index * 16;
    resources.writeUInt32LE(index + 1, 48 + index * 8); resources.writeUInt32LE((0x80000000 + language) >>> 0, 52 + index * 8);
    resources.writeUInt16LE(1, language + 14); resources.writeUInt32LE(0x409, language + 16); resources.writeUInt32LE(data, language + 20);
    resources.writeUInt32LE(0x1000 + payload, data); resources.writeUInt32LE(image.length, data + 4);
    image.copy(resources, payload); payload += image.length;
  });
  const output = Buffer.alloc(0x200 + resources.length), optional = 0x98, optionalSize = pe32 ? 0xe0 : 0xf0;
  output.writeUInt16LE(0x5a4d); output.writeUInt32LE(0x80, 0x3c); output.writeUInt32LE(0x4550, 0x80);
  output.writeUInt16LE(pe32 ? 0x14c : 0x8664, 0x84); output.writeUInt16LE(1, 0x86); output.writeUInt16LE(optionalSize, 0x94);
  output.writeUInt16LE(pe32 ? 0x10b : 0x20b, optional); output.writeUInt32LE(0x200, optional + 60);
  const directories = optional + (pe32 ? 96 : 112);
  output.writeUInt32LE(16, directories - 4); output.writeUInt32LE(0x1000, directories + 16); output.writeUInt32LE(resources.length, directories + 20);
  const section = optional + optionalSize;
  output.write('.rsrc', section); output.writeUInt32LE(resources.length, section + 8); output.writeUInt32LE(0x1000, section + 12);
  output.writeUInt32LE(resources.length, section + 16); output.writeUInt32LE(0x200, section + 20); resources.copy(output, 0x200);
  return { bytes: output, dataEntries: 0x200 + dataEntries, payloadStart: 0x200 + payloadStart };
}
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'appbridge-icon-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return (bytes) => { const file = path.join(directory, 'Example 应用.exe'); fs.writeFileSync(file, bytes); return file; };
}

test('PE32 and PE32+ use the largest PNG dimensions rather than the largest resource bytes', (t) => {
  const write = fixture(t), small = png(32, 32, 20000), large = png(256, 256), dib = Buffer.alloc(30000);
  for (const pe32 of [false, true]) {
    assert.equal(extractExecutableIcon(write(pe([small, large, dib], pe32).bytes)), `data:image/png;base64,${large.toString('base64')}`);
  }
});

test('unsupported DIB, missing, non-PE and truncated files safely return the fallback', (t) => {
  const write = fixture(t);
  assert.equal(extractExecutableIcon('/does/not/exist/App.exe'), null);
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(128), pe([Buffer.alloc(40)]).bytes, pe([png(32, 32)]).bytes.subarray(0, 0x210)]) {
    assert.equal(extractExecutableIcon(write(bytes)), null);
  }
});

test('32bpp BI_RGB DIBs preserve straight alpha, ignore the legacy mask with alpha and flip bottom-up rows', (t) => {
  const write = fixture(t);
  // Stored bottom row is blue/white; stored top row is red/transparent green.
  const image = dib(2, 2, [255, 0, 0, 128, 255, 255, 255, 255, 0, 0, 255, 255, 0, 255, 0, 0], Buffer.alloc(8, 255));
  assert.deepEqual(decodedRgba(extractExecutableIcon(write(pe([image]).bytes))), {
    width: 2, height: 2,
    pixels: [255, 0, 0, 255, 0, 255, 0, 0, 0, 0, 255, 128, 255, 255, 255, 255],
  });
});

test('all-zero alpha uses the DWORD-aligned AND mask instead of making the entire icon invisible', (t) => {
  const write = fixture(t);
  const image = dib(3, 1, [0, 0, 255, 0, 0, 0, 0, 0, 255, 0, 0, 0], Buffer.from([0x40, 0, 0, 0]));
  assert.deepEqual(decodedRgba(extractExecutableIcon(write(pe([image]).bytes))).pixels,
    [255, 0, 0, 255, 0, 0, 0, 0, 0, 0, 255, 255]);
});

test('DIB compression, depth, doubled height and complete XOR/AND bounds are validated', (t) => {
  const write = fixture(t), original = dib(2, 2, Buffer.alloc(16, 255));
  const invalid = [];
  for (const [offset, value] of [[16, 3], [8, 3], [4, 2048], [20, 1]]) {
    const bytes = Buffer.from(original); bytes.writeUInt32LE(value, offset); invalid.push(bytes);
  }
  const depth = Buffer.from(original); depth.writeUInt16LE(24, 14); invalid.push(depth);
  invalid.push(original.subarray(0, original.length - 1));
  invalid.push(original.subarray(0, 40 + 15));
  for (const bytes of invalid) assert.equal(extractExecutableIcon(write(pe([bytes]).bytes)), null);
});

test('a larger supported DIB is selected over a smaller PNG', (t) => {
  const write = fixture(t), image = dib(4, 4, Buffer.alloc(4 * 4 * 4, 255));
  const decoded = decodedRgba(extractExecutableIcon(write(pe([png(2, 2), image]).bytes)));
  assert.equal(decoded.width, 4); assert.equal(decoded.height, 4);
});

test('out-of-range resource data, resource cycles and unsupported optional headers are refused', (t) => {
  const write = fixture(t), image = png(64, 64);
  const outside = pe([image]); outside.bytes.writeUInt32LE(0x7fffffff, outside.dataEntries);
  const cycle = pe([image]); cycle.bytes.writeUInt32LE(0x80000020, 0x200 + 52);
  const invalidHeader = pe([image]); invalidHeader.bytes.writeUInt16LE(0x999, 0x98);
  for (const data of [outside, cycle, invalidHeader]) assert.equal(extractExecutableIcon(write(data.bytes)), null);
});

test('a damaged largest PNG falls back to a smaller intact icon and damaged-only icons return null', (t) => {
  const write = fixture(t), small = png(32, 32), damaged = png(256, 256);
  damaged[29] ^= 1;
  assert.equal(extractExecutableIcon(write(pe([damaged, small]).bytes)), `data:image/png;base64,${small.toString('base64')}`);
  assert.equal(extractExecutableIcon(write(pe([damaged]).bytes)), null);
  const corruptStream = Buffer.concat([small.subarray(0, 33), chunk('IDAT', Buffer.from([0, 0, 0, 0])), chunk('IEND', Buffer.alloc(0))]);
  assert.equal(extractExecutableIcon(write(pe([corruptStream]).bytes)), null, 'valid chunk checksums must not conceal damaged compressed pixels');
  const indexedHeader = Buffer.from(small.subarray(16, 29)); indexedHeader[9] = 3;
  const missingPalette = Buffer.concat([small.subarray(0, 8), chunk('IHDR', indexedHeader), chunk('IDAT', zlib.deflateSync(Buffer.alloc(33 * 32))), chunk('IEND', Buffer.alloc(0))]);
  assert.equal(extractExecutableIcon(write(pe([missingPalette]).bytes)), null, 'indexed pixels need an actual palette');
});

test('file and resource byte limits are enforced before returning image data', (t) => {
  const write = fixture(t), small = png(32, 32);
  const hugeFile = write(pe([small]).bytes); fs.truncateSync(hugeFile, 16 * 1024 * 1024 + 1);
  assert.equal(extractExecutableIcon(hugeFile), null);
  assert.equal(extractExecutableIcon(write(pe([png(32, 32, 2 * 1024 * 1024)]).bytes)), null);
});
