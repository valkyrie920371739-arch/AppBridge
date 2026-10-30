'use strict';

// Electron otherwise presents app.asar as a virtual directory. Data moves must
// copy its original archive bytes, including native Tyrano application data.
const fs = process.versions.electron ? require('original-fs') : require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const fsp = fs.promises;
const MANAGED_FOLDER = 'AppBridge 数据';

function absoluteDirectory(value, label) {
  if (typeof value !== 'string' || !value || value.includes('\0') || !path.isAbsolute(value) ||
      value.split(path.sep).some((part) => part === '.' || part === '..')) {
    throw new Error(`${label}必须是明确的绝对路径，不能包含父目录跳转。`);
  }
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root) throw new Error(`${label}不能是磁盘根目录。`);
  return resolved;
}

function within(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function statOrNull(file) {
  try { return await fsp.lstat(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function identity(stat) { return { dev: stat.dev, ino: stat.ino }; }
function sameIdentity(stat, expected) { return stat.dev === expected.dev && stat.ino === expected.ino; }

async function ordinaryDirectory(directory, label, expected) {
  const stat = await fsp.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await fsp.realpath(directory) !== directory) {
    throw new Error(`${label}必须是普通文件夹，路径不能经过符号链接：${directory}`);
  }
  if (expected && !sameIdentity(stat, expected)) throw new Error(`${label}在整理期间发生了变化：${directory}`);
  return stat;
}

function snapshotStat(stat) {
  return { dev: stat.dev, ino: stat.ino, mode: stat.mode & 0o777, size: stat.size,
    mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
}

function unchanged(stat, expected) {
  return sameIdentity(stat, expected) && (stat.mode & 0o777) === expected.mode &&
    stat.size === expected.size && stat.mtimeMs === expected.mtimeMs && stat.ctimeMs === expected.ctimeMs;
}

async function inventory(directory, expectedRoot) {
  const rootStat = await ordinaryDirectory(directory, '原数据目录', expectedRoot);
  const entries = [];
  let files = 0, directories = 0, links = 0, sizeBytes = 0;
  async function visit(current, relative) {
    const before = await ordinaryDirectory(current, '数据子目录');
    const names = (await fsp.readdir(current)).sort();
    for (const name of names) {
      const file = path.join(current, name), relativePath = path.join(relative, name);
      const stat = await fsp.lstat(file), common = { name: relativePath, ...snapshotStat(stat) };
      if (stat.isSymbolicLink()) {
        entries.push({ ...common, type: 'link', target: await fsp.readlink(file) }); links++;
      } else if (stat.isDirectory()) {
        entries.push({ ...common, type: 'directory' }); directories++;
        await visit(file, relativePath);
      } else if (stat.isFile()) {
        if (!Number.isSafeInteger(stat.size) || !Number.isSafeInteger(sizeBytes + stat.size)) throw new Error('应用数据体积超出此版本支持范围。');
        entries.push({ ...common, type: 'file' }); files++; sizeBytes += stat.size;
      } else throw new Error(`数据目录包含仍在使用的套接字或特殊文件，请先关闭应用后重试：${relativePath}`);
    }
    if (!unchanged(await fsp.lstat(current), snapshotStat(before))) throw new Error(`数据子目录在检查期间发生了变化：${relative || '.'}`);
  }
  await visit(directory, '');
  const rootAfter = await ordinaryDirectory(directory, '原数据目录', identity(rootStat));
  if (!unchanged(rootAfter, snapshotStat(rootStat))) throw new Error('原数据目录在检查期间发生了变化。');
  const root = snapshotStat(rootStat);
  const fingerprint = createHash('sha256').update(JSON.stringify({ root, entries })).digest('hex');
  return { root, entries, files, directories, links, sizeBytes, fingerprint };
}

async function inspectDataDirectory(sourceDirectory) {
  const directory = absoluteDirectory(sourceDirectory, '原数据目录');
  const result = await inventory(directory);
  return { sourceDirectory: directory, files: result.files, directories: result.directories,
    links: result.links, sizeBytes: result.sizeBytes, fingerprint: result.fingerprint };
}

function relocatedLink(target, sourceDirectory, destination) {
  // Keep relative Wine mappings, Z: -> / and unrelated external links intact.
  // Only replace a literal source prefix, preserving any symlink/.. semantics
  // in the remaining path instead of normalizing the stored link text.
  if (path.isAbsolute(target) && (target === sourceDirectory || target.startsWith(`${sourceDirectory}${path.sep}`)) &&
      within(sourceDirectory, path.resolve(target))) {
    return `${destination}${target.slice(sourceDirectory.length)}`;
  }
  return target;
}

async function assertSourceItem(sourceDirectory, item, directories) {
  await ordinaryDirectory(sourceDirectory, '原数据目录', directories.get(''));
  const parents = [];
  let parent = path.dirname(item.name);
  while (parent !== '.') { parents.unshift(parent); parent = path.dirname(parent); }
  for (const relative of parents) await ordinaryDirectory(path.join(sourceDirectory, relative), '数据子目录', directories.get(relative));
  const source = path.join(sourceDirectory, item.name), stat = await fsp.lstat(source);
  if (!unchanged(stat, item) || (item.type === 'link' && (!stat.isSymbolicLink() || await fsp.readlink(source) !== item.target))) {
    throw new Error(`应用数据在整理期间发生了变化：${item.name}`);
  }
  return source;
}

async function copyFile(source, target, item) {
  let input, output;
  try {
    input = await fsp.open(source, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (fs.constants.O_NOFOLLOW || 0));
    const before = await input.stat();
    if (!before.isFile() || !unchanged(before, item)) throw new Error(`数据文件在复制前发生了变化：${item.name}`);
    output = await fsp.open(target, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0), 0o600);
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let copied = 0;
    while (copied < before.size) {
      const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, before.size - copied), copied);
      if (!bytesRead) throw new Error(`数据文件在复制期间被截断：${item.name}`);
      let written = 0;
      while (written < bytesRead) {
        const { bytesWritten } = await output.write(buffer, written, bytesRead - written, copied + written);
        if (!bytesWritten) throw new Error(`无法继续写入数据文件：${item.name}`);
        written += bytesWritten;
      }
      copied += bytesRead;
    }
    if (!unchanged(await input.stat(), item)) throw new Error(`数据文件在复制期间发生了变化：${item.name}`);
    await output.chmod(item.mode);
    await output.utimes(before.atime, before.mtime);
    await output.sync();
  } finally {
    if (output) await output.close();
    if (input) await input.close();
  }
}

// The caller must first stop this application's private Wine environment and
// prevent new launches until commit finishes. This module never stops software.
async function relocateAppData({ sourceDirectory, targetParent, appId, commit } = {}) {
  sourceDirectory = absoluteDirectory(sourceDirectory, '原数据目录');
  targetParent = absoluteDirectory(targetParent, '所选文件夹');
  if (typeof appId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(appId)) throw new Error('应用标识无效，无法建立独立数据目录。');
  if (typeof commit !== 'function') throw new Error('缺少数据位置保存接口。');
  const sourceStat = await ordinaryDirectory(sourceDirectory, '原数据目录');
  const parentStat = await ordinaryDirectory(targetParent, '所选文件夹');
  const storageRoot = path.join(targetParent, MANAGED_FOLDER), destination = path.join(storageRoot, appId);
  if (destination === sourceDirectory) return { changed: false, saveDirectory: sourceDirectory, storageRoot,
    previousDirectory: sourceDirectory, sourcePreserved: true };
  if (within(sourceDirectory, storageRoot) || within(destination, sourceDirectory)) throw new Error('新旧数据目录相互包含，不能递归复制。请选择独立文件夹。');
  const initialRoot = await statOrNull(storageRoot);
  if (initialRoot) await ordinaryDirectory(storageRoot, 'AppBridge 数据目录');
  if (await statOrNull(destination)) throw new Error('目标应用数据目录已经存在，已停止以避免覆盖。请选择其他文件夹。');
  const planned = await inventory(sourceDirectory, identity(sourceStat));
  const directoryIdentities = new Map([['', identity(sourceStat)], ...planned.entries.filter((entry) => entry.type === 'directory').map((entry) => [entry.name, identity(entry)])]);
  let createdRoot = false, stage = null, stageIdentity = null, reservationIdentity = null, promoted = false;
  let rootIdentity = null;
  async function checkDestination() {
    await ordinaryDirectory(targetParent, '所选文件夹', identity(parentStat));
    await ordinaryDirectory(storageRoot, 'AppBridge 数据目录', rootIdentity);
  }
  async function removeOwned(directory, expected, recursive) {
    await checkDestination();
    const stat = await statOrNull(directory);
    if (!stat) return;
    if (!stat.isDirectory() || stat.isSymbolicLink() || !sameIdentity(stat, expected)) throw new Error(`本次整理目录已被替换，已保留现场：${directory}`);
    if (recursive) await fsp.rm(directory, { recursive: true });
    else await fsp.rmdir(directory);
  }
  try {
    await ordinaryDirectory(targetParent, '所选文件夹', identity(parentStat));
    if (!initialRoot) {
      await fsp.mkdir(storageRoot, { mode: 0o700 }); createdRoot = true;
    }
    rootIdentity = identity(await ordinaryDirectory(storageRoot, 'AppBridge 数据目录', initialRoot ? identity(initialRoot) : null));
    stage = path.join(storageRoot, `.moving-${appId}-${randomUUID()}`);
    await fsp.mkdir(stage, { mode: 0o700 });
    stageIdentity = identity(await ordinaryDirectory(stage, '本次整理目录'));
    const stageDirectories = new Map([['', stageIdentity]]);
    for (const item of planned.entries) {
      await checkDestination();
      await ordinaryDirectory(stage, '本次整理目录', stageIdentity);
      let parent = path.dirname(item.name);
      const parents = [];
      while (parent !== '.') { parents.unshift(parent); parent = path.dirname(parent); }
      for (const relative of parents) await ordinaryDirectory(path.join(stage, relative), '本次整理子目录', stageDirectories.get(relative));
      const source = await assertSourceItem(sourceDirectory, item, directoryIdentities);
      const target = path.join(stage, item.name);
      if (item.type === 'directory') {
        await fsp.mkdir(target, { mode: 0o700 });
        stageDirectories.set(item.name, identity(await ordinaryDirectory(target, '本次整理子目录')));
      }
      else if (item.type === 'link') await fsp.symlink(relocatedLink(item.target, sourceDirectory, destination), target);
      else await copyFile(source, target, item);
    }
    for (const item of [...planned.entries].reverse()) if (item.type === 'directory') {
      const target = path.join(stage, item.name);
      await fsp.chmod(target, item.mode);
      await fsp.utimes(target, item.mtimeMs / 1000, item.mtimeMs / 1000);
    }
    await fsp.chmod(stage, sourceStat.mode & 0o777);
    await fsp.utimes(stage, sourceStat.atime, sourceStat.mtime);
    if ((await inventory(sourceDirectory, identity(sourceStat))).fingerprint !== planned.fingerprint) throw new Error('应用数据在整理期间发生了变化，原位置已保留，请关闭应用后重试。');
    await checkDestination();
    // mkdir reserves a previously absent name without replacing another file.
    // rename then atomically replaces only our still-empty reservation.
    await fsp.mkdir(destination, { mode: 0o700 });
    reservationIdentity = identity(await ordinaryDirectory(destination, '本次目标目录'));
    await checkDestination();
    await ordinaryDirectory(destination, '本次目标目录', reservationIdentity);
    await fsp.rename(stage, destination);
    promoted = true;
    const result = { changed: true, saveDirectory: destination, storageRoot, previousDirectory: sourceDirectory,
      sourcePreserved: true, files: planned.files, directories: planned.directories, links: planned.links,
      sizeBytes: planned.sizeBytes, sourceFingerprint: planned.fingerprint };
    await commit(result);
    return result;
  } catch (error) {
    if (!(error instanceof Error)) error = new Error(String(error));
    const cleanupErrors = [];
    try {
      if (promoted) await removeOwned(destination, stageIdentity, true);
      else {
        if (stageIdentity) await removeOwned(stage, stageIdentity, true);
        if (reservationIdentity) await removeOwned(destination, reservationIdentity, false);
      }
    } catch (cleanupError) { cleanupErrors.push(cleanupError.message); }
    if (createdRoot) {
      try {
        await ordinaryDirectory(targetParent, '所选文件夹', identity(parentStat));
        const stat = await statOrNull(storageRoot);
        if (stat && rootIdentity && sameIdentity(stat, rootIdentity) && !stat.isSymbolicLink()) await fsp.rmdir(storageRoot);
      } catch (cleanupError) { if (!['ENOTEMPTY', 'ENOENT', 'EEXIST'].includes(cleanupError.code)) cleanupErrors.push(cleanupError.message); }
    }
    error.previousDirectory = sourceDirectory;
    error.sourcePreserved = true;
    if (cleanupErrors.length) {
      error.cleanupErrors = cleanupErrors;
      error.recoveryDirectory = promoted ? destination : stage;
      error.message += `\n原数据仍在：${sourceDirectory}\n本次副本未完全清理，已保留：${error.recoveryDirectory}\n${cleanupErrors.join('\n')}`;
    }
    throw error;
  }
}

module.exports = { inspectDataDirectory, relocateAppData };
