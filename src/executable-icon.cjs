'use strict';

const fs = require('node:fs');
const zlib = require('node:zlib');

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_ICON_BYTES = 2 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 4096;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function pngSize(bytes) {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE) ||
      bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') return null;
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  // Icons are displayed as small UI images; refuse oversized decoded bitmaps.
  if (!width || !height || width > 1024 || height > 1024) return null;
  return { width, height };
}

function validPng(bytes) {
  const dimensions = pngSize(bytes);
  if (!dimensions) return false;
  const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
  if (!depths[bytes[25]]?.includes(bytes[24]) || bytes[26] || bytes[27] || bytes[28] > 1) return false;
  let offset = 8, chunks = 0, hasPalette = false;
  const imageChunks = [];
  while (offset <= bytes.length - 12 && ++chunks <= MAX_DIRECTORY_ENTRIES) {
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12) return false;
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type) || (offset !== 8 && type === 'IHDR')) return false;
    if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== bytes.readUInt32BE(offset + 8 + length)) return false;
    if (type === 'PLTE') {
      if (hasPalette || imageChunks.length || !length || length % 3 || length > 768 || (bytes[25] === 3 && length / 3 > 2 ** bytes[24])) return false;
      hasPalette = true;
    }
    if (type === 'IDAT' && length) imageChunks.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
    if (type === 'IEND') {
      if (length || !imageChunks.length || offset !== bytes.length || (bytes[25] === 3 && !hasPalette)) return false;
      // Bound decompression by the claimed dimensions, including Adam7 passes.
      const passes = bytes[28] ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] : [[0, 0, 1, 1]];
      const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[bytes[25]];
      const rows = passes.map(([x, y, dx, dy]) => ({
        width: Math.max(0, Math.ceil((dimensions.width - x) / dx)),
        height: Math.max(0, Math.ceil((dimensions.height - y) / dy)),
      })).filter((pass) => pass.width && pass.height).map((pass) => ({
        bytes: Math.ceil(pass.width * channels * bytes[24] / 8) + 1, height: pass.height,
      }));
      const expected = rows.reduce((sum, pass) => sum + pass.bytes * pass.height, 0);
      let pixels;
      try { pixels = zlib.inflateSync(Buffer.concat(imageChunks), { maxOutputLength: expected }); }
      catch { return false; }
      if (pixels.length !== expected) return false;
      let position = 0;
      for (const pass of rows) for (let row = 0; row < pass.height; row++, position += pass.bytes) if (pixels[position] > 4) return false;
      return true;
    }
  }
  return false;
}

function dibSize(bytes) {
  if (bytes.length < 40 || bytes.readUInt32LE(0) !== 40 || bytes.readUInt16LE(12) !== 1 ||
      bytes.readUInt16LE(14) !== 32 || bytes.readUInt32LE(16) !== 0 || bytes.readUInt32LE(32) !== 0) return null;
  const width = bytes.readInt32LE(4), doubledHeight = bytes.readInt32LE(8);
  if (width < 1 || width > 1024 || doubledHeight < 2 || doubledHeight > 2048 || doubledHeight % 2) return null;
  const height = doubledHeight / 2, xorBytes = width * height * 4, maskStride = Math.ceil(width / 32) * 4;
  const pixelBytes = xorBytes + maskStride * height, declaredBytes = bytes.readUInt32LE(20);
  if (bytes.length !== 40 + pixelBytes || (declaredBytes !== 0 && declaredBytes !== xorBytes && declaredBytes !== pixelBytes)) return null;
  return { width, height, xorBytes, maskStride };
}

function pngChunk(type, data) {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length); chunk.write(type, 4, 4, 'ascii'); data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, data.length + 8)), data.length + 8);
  return chunk;
}

function dibToPng(bytes) {
  const info = dibSize(bytes);
  if (!info) return null;
  const { width, height, xorBytes, maskStride } = info;
  let hasAlpha = false;
  for (let offset = 43; offset < 40 + xorBytes; offset += 4) if (bytes[offset]) { hasAlpha = true; break; }
  const stride = width * 4 + 1, pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const sourceY = height - y - 1;
    for (let x = 0; x < width; x++) {
      const source = 40 + (sourceY * width + x) * 4, target = y * stride + 1 + x * 4;
      pixels[target] = bytes[source + 2]; pixels[target + 1] = bytes[source + 1]; pixels[target + 2] = bytes[source];
      // With real 32-bit alpha Windows ignores the AND mask. All-zero alpha
      // is the legacy format: the DWORD-aligned, bottom-up AND mask applies.
      const mask = bytes[40 + xorBytes + sourceY * maskStride + (x >>> 3)] & (0x80 >>> (x & 7));
      pixels[target + 3] = hasAlpha ? bytes[source + 3] : mask ? 0 : 255;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([PNG_SIGNATURE, pngChunk('IHDR', header), pngChunk('IDAT', zlib.deflateSync(pixels)), pngChunk('IEND', Buffer.alloc(0))]);
}

function readIcons(bytes) {
  const range = (offset, length, limit = bytes.length) => {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset > limit - length) throw new Error('Invalid PE range');
  };
  range(0, 64);
  if (bytes.readUInt16LE(0) !== 0x5a4d) return [];
  const pe = bytes.readUInt32LE(0x3c);
  range(pe, 24);
  if (pe < 64 || bytes.readUInt32LE(pe) !== 0x00004550) return [];
  const sectionCount = bytes.readUInt16LE(pe + 6);
  const optionalSize = bytes.readUInt16LE(pe + 20);
  const optional = pe + 24;
  range(optional, optionalSize);
  if (!sectionCount || sectionCount > 96 || optionalSize < 64) return [];
  const magic = bytes.readUInt16LE(optional);
  const directoryStart = magic === 0x20b ? 112 : magic === 0x10b ? 96 : 0;
  if (!directoryStart || optionalSize < directoryStart + 24 || bytes.readUInt32LE(optional + directoryStart - 4) < 3) return [];
  const resourceRva = bytes.readUInt32LE(optional + directoryStart + 16);
  const resourceSize = bytes.readUInt32LE(optional + directoryStart + 20);
  if (!resourceRva || resourceSize < 24 || resourceSize > MAX_FILE_BYTES || resourceRva + resourceSize > 0x100000000) return [];
  const sectionTable = optional + optionalSize;
  range(sectionTable, sectionCount * 40);
  const sections = [];
  for (let index = 0; index < sectionCount; index++) {
    const section = sectionTable + index * 40;
    const rva = bytes.readUInt32LE(section + 12);
    const rawSize = bytes.readUInt32LE(section + 16);
    const rawOffset = bytes.readUInt32LE(section + 20);
    range(rawOffset, rawSize);
    if (rva + rawSize > 0x100000000) return [];
    sections.push({ rva, rawOffset, rawSize });
  }
  const headers = bytes.readUInt32LE(optional + 60);
  const mapRva = (rva, length) => {
    const candidates = [];
    if (rva < headers && rva + length <= headers && rva + length <= bytes.length) candidates.push(rva);
    for (const section of sections) {
      const delta = rva - section.rva;
      if (delta >= 0 && delta <= section.rawSize - length) candidates.push(section.rawOffset + delta);
    }
    if (candidates.length !== 1) throw new Error('Unmapped or ambiguous PE resource');
    return candidates[0];
  };
  const root = mapRva(resourceRva, resourceSize);
  const resourceRange = (relative, length) => { range(relative, length, resourceSize); return root + relative; };
  let remaining = MAX_DIRECTORY_ENTRIES;
  const entries = (relative) => {
    const directory = resourceRange(relative, 16);
    const count = bytes.readUInt16LE(directory + 12) + bytes.readUInt16LE(directory + 14);
    if (count > remaining) throw new Error('Too many resource entries');
    remaining -= count;
    const table = resourceRange(relative + 16, count * 8);
    return Array.from({ length: count }, (_, index) => ({
      name: bytes.readUInt32LE(table + index * 8),
      offset: bytes.readUInt32LE(table + index * 8 + 4),
    }));
  };
  const icons = [];
  const seenDirectories = new Set(), seenData = new Set();
  const visit = (relative, depth) => {
    if (depth > 2 || seenDirectories.has(relative)) throw new Error('Invalid resource tree');
    seenDirectories.add(relative);
    for (const entry of entries(relative)) {
      const target = entry.offset & 0x7fffffff;
      if (entry.offset & 0x80000000) { visit(target, depth + 1); continue; }
      const data = resourceRange(target, 16);
      const rva = bytes.readUInt32LE(data), size = bytes.readUInt32LE(data + 4);
      if (!size || size > MAX_ICON_BYTES) continue;
      if (rva < resourceRva || rva + size > resourceRva + resourceSize) throw new Error('Icon outside resource bounds');
      const offset = mapRva(rva, size), key = `${offset}:${size}`;
      if (seenData.has(key)) continue;
      seenData.add(key);
      const dataBytes = bytes.subarray(offset, offset + size), pngDimensions = pngSize(dataBytes);
      if (pngDimensions) icons.push({ bytes: dataBytes, format: 'png', ...pngDimensions });
      else {
        const dibDimensions = dibSize(dataBytes);
        if (dibDimensions) icons.push({ bytes: dataBytes, format: 'dib', ...dibDimensions });
      }
    }
  };
  for (const entry of entries(0)) {
    if (entry.name === 3 && (entry.offset & 0x80000000)) visit(entry.offset & 0x7fffffff, 0);
  }
  return icons;
}

// Reads bytes only. Supports PNG and 40-byte BI_RGB/32bpp icon DIBs. Other
// executables/images safely fall back; no executable code is loaded or run.
function extractExecutableIcon(exePath) {
  let descriptor;
  try {
    descriptor = fs.openSync(exePath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size < 64 || stat.size > MAX_FILE_BYTES) return null;
    const bytes = Buffer.alloc(stat.size);
    let read = 0;
    while (read < bytes.length) {
      const count = fs.readSync(descriptor, bytes, read, bytes.length - read, read);
      if (!count) return null;
      read += count;
    }
    const candidates = readIcons(bytes).sort((a, b) => b.width * b.height - a.width * a.height ||
      (a.format === b.format ? b.bytes.length - a.bytes.length : a.format === 'png' ? -1 : 1));
    let budget = MAX_FILE_BYTES;
    for (const candidate of candidates) {
      budget -= candidate.bytes.length;
      if (budget < 0) return null;
      const png = candidate.format === 'png' ? (validPng(candidate.bytes) ? candidate.bytes : null) : dibToPng(candidate.bytes);
      if (png) return `data:image/png;base64,${png.toString('base64')}`;
    }
    return null;
  } catch { return null; }
  finally { if (descriptor !== undefined) { try { fs.closeSync(descriptor); } catch {} } }
}

module.exports = { extractExecutableIcon };
