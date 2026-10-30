'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function fallbackValue(fallback) {
  return structuredClone(typeof fallback === 'function' ? fallback() : fallback);
}

// Reserve a unique name before rename: an existing recovery copy is never replaced.
function reserveBackup(file) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = `${file}.corrupt-${timestamp}-${randomUUID()}.bak`;
    let fd;
    try {
      fd = fs.openSync(backupPath, 'wx', 0o600);
    } catch (error) {
      if (error.code === 'EEXIST') continue;
      throw error;
    }
    try {
      fs.closeSync(fd);
    } catch (error) {
      try { fs.unlinkSync(backupPath); } catch {}
      throw error;
    }
    return backupPath;
  }
  throw new Error('无法为损坏的数据文件创建独立备份。');
}

function readJsonRecoverable(file, { fallback, validate, onRecovery } = {}) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return fallbackValue(fallback);
    // Access and I/O failures do not mean that the contents are corrupt.
    throw error;
  }

  let value;
  let corruption;
  try {
    value = JSON.parse(text);
    if (validate && !validate(value)) throw new TypeError('数据文件格式无效。');
  } catch (error) {
    corruption = error;
  }
  if (!corruption) return value;

  // Prepare the replacement before moving the original, so an invalid fallback
  // cannot leave the caller without either a usable value or its original file.
  const replacement = fallbackValue(fallback);
  const backupPath = reserveBackup(file);
  try {
    fs.renameSync(file, backupPath);
  } catch (error) {
    try { fs.unlinkSync(backupPath); } catch {}
    throw error;
  }
  if (onRecovery) onRecovery({ file, backupPath, error: corruption });
  return replacement;
}

function writeJsonAtomic(file, value) {
  const json = JSON.stringify(value, null, 2);
  if (json === undefined) throw new TypeError('数据不能保存为 JSON。');
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, `${json}\n`, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, file);
  } catch (error) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

module.exports = { readJsonRecoverable, writeJsonAtomic };
