'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

function absolutePath(value, label) {
  if (typeof value !== 'string' || !value || value.includes('\0') || !path.isAbsolute(value)) {
    throw new Error(`${label}必须是明确的绝对路径。`);
  }
  return path.resolve(value);
}
function statOrNull(file) {
  try { return fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function within(root, target, includeRoot = true) {
  const relative = path.relative(root, target);
  return (includeRoot || relative !== '') && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
// Resolve an existing ancestor as well as any missing suffix, so a symlink in
// a parent directory cannot hide a recursive or external destination.
function resolvedLocation(target) {
  const suffix = [];
  let ancestor = target;
  while (!statOrNull(ancestor)) {
    suffix.unshift(path.basename(ancestor));
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error(`无法解析文件位置：${target}`);
    ancestor = parent;
  }
  return path.resolve(fs.realpathSync(ancestor), ...suffix);
}
function ordinaryDirectory(directory, label) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label}必须是普通文件夹，不能是符号链接。`);
  return stat;
}
function readableFile(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('程序入口必须是普通文件，不能是符号链接。');
  fs.accessSync(file, fs.constants.R_OK);
  return stat;
}
function enumerate(directory) {
  const entries = [];
  let files = 0;
  let sizeBytes = 0;
  function visit(current, relative) {
    for (const item of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(current, item.name);
      const name = relative ? path.join(relative, item.name) : item.name;
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error(`程序文件夹内有符号链接，无法确认完整资源范围：${name}。请使用不含链接的完整程序文件夹。`);
      if (stat.isDirectory()) {
        entries.push({ name, directory: true, mode: stat.mode });
        visit(file, name);
      } else if (stat.isFile()) {
        fs.accessSync(file, fs.constants.R_OK);
        if (!Number.isSafeInteger(stat.size) || !Number.isSafeInteger(sizeBytes + stat.size)) throw new Error('程序文件夹体积超出此版本支持范围。');
        files += 1; sizeBytes += stat.size;
        entries.push({ name, directory: false, size: stat.size, mtimeMs: stat.mtimeMs, mode: stat.mode, dev: stat.dev, ino: stat.ino });
      } else throw new Error(`程序文件夹包含不能复制的特殊文件：${name}。`);
    }
  }
  visit(directory, '');
  const fingerprint = createHash('sha256').update(JSON.stringify(entries)).digest('hex');
  return { entries, files, sizeBytes, fingerprint };
}

function inspectImportFolder(exePath, { homeDirectory, workspaceRoot, cloudRoot, sourceDirectory: requestedSourceDirectory } = {}) {
  const executable = absolutePath(exePath, '程序入口');
  const roots = {
    homeDirectory: resolvedLocation(absolutePath(homeDirectory, '用户目录')),
    workspaceRoot: resolvedLocation(absolutePath(workspaceRoot, 'AppBridge 工作区')),
    cloudRoot: resolvedLocation(absolutePath(cloudRoot, 'AppBridge 云盘目录')),
  };
  for (const root of Object.values(roots)) {
    if (root === path.parse(root).root) throw new Error('用户目录、工作区和云盘目录不能使用文件系统根目录。');
    const stat = statOrNull(root);
    if (stat && !stat.isDirectory()) throw new Error(`工作区配置不是文件夹：${root}`);
  }
  readableFile(executable);
  const sourceDirectory = requestedSourceDirectory === undefined
    ? path.dirname(executable)
    : absolutePath(requestedSourceDirectory, '程序来源目录');
  const sourceStat = ordinaryDirectory(sourceDirectory, '程序所在目录');
  const sourceRealPath = fs.realpathSync(sourceDirectory);
  if (requestedSourceDirectory !== undefined && sourceRealPath !== sourceDirectory) {
    throw new Error('指定的程序来源目录不能通过符号链接指向其他位置。');
  }
  const sourceParent = path.dirname(sourceRealPath);
  const isFilesystemRoot = sourceRealPath === path.parse(sourceRealPath).root;
  const isMountRoot = sourceParent !== sourceRealPath && fs.statSync(sourceParent).dev !== sourceStat.dev;
  const broadSources = [roots.homeDirectory, ...['Downloads', 'Desktop', 'Documents'].map((name) => resolvedLocation(path.join(roots.homeDirectory, name)))];
  if (isFilesystemRoot || isMountRoot || broadSources.includes(sourceRealPath)) {
    throw new Error('程序所在目录范围太大。请先把程序和全部配套文件放入独立文件夹，再添加其中的 EXE。');
  }
  if (!within(sourceDirectory, executable, false)) throw new Error('程序入口必须位于指定的程序来源目录内。');
  const exeRelativePath = path.relative(sourceDirectory, executable);
  // An engine may identify the package root above Binaries/Win64. Every
  // directory between that root and the selected entry must remain ordinary;
  // a linked child must never widen the package scope or escape its root.
  let entryDirectory = sourceDirectory;
  for (const name of exeRelativePath.split(path.sep).slice(0, -1)) {
    entryDirectory = path.join(entryDirectory, name);
    ordinaryDirectory(entryDirectory, '程序入口所在目录');
  }
  if (!within(sourceRealPath, fs.realpathSync(executable), false)) throw new Error('程序入口通过链接指向程序来源目录之外。');
  const plan = { exePath: executable, exeName: path.basename(executable), exeRelativePath, sourceDirectory, sourceRealPath, ...roots };
  if (within(roots.workspaceRoot, sourceRealPath) || within(roots.cloudRoot, sourceRealPath)) {
    return { ...plan, alreadyManaged: true };
  }
  if (within(sourceRealPath, roots.workspaceRoot) || within(roots.workspaceRoot, sourceRealPath)) {
    throw new Error('程序来源与 AppBridge 工作区相互包含，不能递归复制。请使用独立的程序文件夹。');
  }
  const inventory = enumerate(sourceDirectory);
  return { ...plan, alreadyManaged: false, files: inventory.files, sizeBytes: inventory.sizeBytes, inventoryFingerprint: inventory.fingerprint };
}

function copyImportFolder(plan, saveDirectory) {
  if (!plan || typeof plan !== 'object') throw new Error('导入计划无效，请重新选择程序。');
  const current = inspectImportFolder(plan.exePath, plan);
  if (current.sourceDirectory !== plan.sourceDirectory || current.sourceRealPath !== plan.sourceRealPath ||
      current.exeRelativePath !== plan.exeRelativePath || current.exeName !== plan.exeName ||
      ['homeDirectory', 'workspaceRoot', 'cloudRoot'].some((key) => current[key] !== plan[key])) {
    throw new Error('程序来源或 AppBridge 工作区位置发生了变化，请重新添加。');
  }
  if (current.alreadyManaged && plan.alreadyManaged === true) return current.exePath;
  if (current.alreadyManaged || plan.alreadyManaged !== false ||
      current.files !== plan.files || current.sizeBytes !== plan.sizeBytes || current.inventoryFingerprint !== plan.inventoryFingerprint) {
    throw new Error('程序文件夹在确认期间发生了变化，请重新添加后再复制。');
  }
  const selectedSave = absolutePath(saveDirectory, '应用数据目录');
  const saveStat = statOrNull(selectedSave);
  if (saveStat && (!saveStat.isDirectory() || saveStat.isSymbolicLink())) throw new Error('应用数据目录必须是普通文件夹，不能是符号链接。');
  const save = resolvedLocation(selectedSave);
  if (!within(current.workspaceRoot, save, false)) throw new Error('应用数据目录必须位于 AppBridge 工作区内。');
  const destination = path.join(save, 'program');
  if (within(current.sourceRealPath, destination) || within(destination, current.sourceRealPath)) {
    throw new Error('程序来源与复制目标相互包含，已停止以避免递归复制。');
  }
  if (statOrNull(destination)) throw new Error('应用运行文件夹已存在，已停止以避免覆盖。');
  fs.mkdirSync(save, { recursive: true, mode: 0o700 });
  ordinaryDirectory(save, '应用数据目录');
  if (!within(current.workspaceRoot, fs.realpathSync(save), false)) throw new Error('应用数据目录通过链接指向工作区之外。');
  const stage = path.join(save, `.program-${randomUUID()}`);
  fs.mkdirSync(stage, { mode: 0o700 });
  let promoted = false;
  try {
    // Copy ordinary files through no-follow descriptors. Sources are never
    // opened for writing; no iCloud or Finder metadata is carried into code.
    const inventory = enumerate(current.sourceDirectory);
    if (inventory.fingerprint !== current.inventoryFingerprint) throw new Error('程序文件夹在复制前发生了变化，请重新添加。');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (const item of inventory.entries) {
      const source = path.join(current.sourceDirectory, item.name);
      const target = path.join(stage, item.name);
      if (item.directory) {
        ordinaryDirectory(source, '程序资源目录');
        fs.mkdirSync(target, { mode: 0o700 });
        continue;
      }
      let sourceFd; let targetFd;
      try {
        sourceFd = fs.openSync(source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        const before = fs.fstatSync(sourceFd);
        if (!before.isFile() || before.dev !== item.dev || before.ino !== item.ino || before.size !== item.size || before.mtimeMs !== item.mtimeMs) {
          throw new Error(`程序资源在复制期间发生了变化：${item.name}`);
        }
        targetFd = fs.openSync(target, 'wx', 0o600);
        let copied = 0;
        while (copied < before.size) {
          const count = fs.readSync(sourceFd, buffer, 0, Math.min(buffer.length, before.size - copied), copied);
          if (count === 0) throw new Error(`程序资源在复制期间被截断：${item.name}`);
          let written = 0;
          while (written < count) {
            const countWritten = fs.writeSync(targetFd, buffer, written, count - written, copied + written);
            if (countWritten <= 0) throw new Error(`无法继续写入程序资源：${item.name}`);
            written += countWritten;
          }
          copied += count;
        }
        const after = fs.fstatSync(sourceFd);
        if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error(`程序资源在复制期间发生了变化：${item.name}`);
        fs.fchmodSync(targetFd, before.mode & 0o777);
        fs.futimesSync(targetFd, before.atime, before.mtime);
      } finally {
        if (targetFd !== undefined) fs.closeSync(targetFd);
        if (sourceFd !== undefined) fs.closeSync(sourceFd);
      }
    }
    if (enumerate(current.sourceDirectory).fingerprint !== current.inventoryFingerprint) throw new Error('程序文件夹在复制期间发生了变化，请重新添加。');
    if (statOrNull(destination)) throw new Error('应用运行文件夹已出现其他内容，已停止以避免覆盖。');
    fs.renameSync(stage, destination);
    promoted = true;
    return path.join(destination, current.exeRelativePath);
  } finally {
    if (!promoted) fs.rmSync(stage, { recursive: true, force: true });
  }
}

module.exports = { inspectImportFolder, copyImportFolder };
