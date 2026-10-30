'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { writeJsonAtomic } = require('./storage.cjs');

const USER_FOLDERS = ['Desktop', 'Documents', 'Downloads', 'Music', 'Pictures', 'Videos'];
const SPECIAL_USERS = new Set(['public', 'allusers', 'default', 'defaultuser']);

function absoluteDirectory(value, label) {
  if (typeof value !== 'string' || !value || value.includes('\0') || !path.isAbsolute(value)) {
    throw new Error(`${label}必须是明确的绝对路径。`);
  }
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root) throw new Error(`${label}不能是文件系统根目录。`);
  return resolved;
}
function statOrNull(file) {
  try { return fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function within(root, target, includeRoot = false) {
  const relative = path.relative(root, target);
  return (includeRoot || relative !== '') && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function plainDirectory(directory, label, allowMissing = false) {
  const stat = statOrNull(directory);
  if (!stat && allowMissing) return;
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label}必须是普通文件夹，不能是符号链接：${directory}`);
  }
}
// Resolve the existing ancestor as well as a possibly missing suffix. This
// catches prefixes routed outside the workspace through an ancestor symlink.
function resolvedLocation(target) {
  const suffix = [];
  let ancestor = target;
  while (!statOrNull(ancestor)) {
    suffix.unshift(path.basename(ancestor));
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error(`无法解析文件夹位置：${target}`);
    ancestor = parent;
  }
  try { return path.resolve(fs.realpathSync.native(ancestor), ...suffix); }
  catch (error) {
    if (error.code !== 'ENOENT' || !fs.lstatSync(ancestor).isSymbolicLink()) throw error;
    // A dangling standard folder still has an unambiguous intended location.
    const link = fs.readlinkSync(ancestor);
    const target = path.isAbsolute(link) ? link : `${path.dirname(ancestor)}${path.sep}${link}`;
    return path.resolve(resolvedLocation(target), ...suffix);
  }
}
function containedDirectory(directory, realRoot) {
  const location = resolvedLocation(directory);
  if (!within(realRoot, location, true)) throw new Error(`运行目录指向 AppBridge 工作区之外：${directory}`);
  const stat = statOrNull(directory);
  if (!stat) return false;
  if (!fs.statSync(directory).isDirectory()) throw new Error(`运行目录不是文件夹：${directory}`);
  return true;
}

function workspaceLayout(profileRoot) {
  const root = absoluteDirectory(profileRoot, 'AppBridge 工作区');
  return {
    profileRoot: root,
    runtimeRoot: path.join(root, 'runtime'),
    cacheRoot: path.join(root, 'cache'),
    logsRoot: path.join(root, 'logs'),
    exportsRoot: path.join(root, 'exports'),
    appsRoot: path.join(root, 'windows-apps'),
    homeRoot: path.join(root, 'home'),
  };
}

function initializeWorkspace(profileRoot) {
  const layout = workspaceLayout(profileRoot);
  plainDirectory(layout.profileRoot, 'AppBridge 工作区', true);
  // Check everything that exists before creating new entries, so a redirected
  // component does not leave a partially initialized workspace.
  for (const [name, directory] of Object.entries(layout)) {
    if (name !== 'profileRoot') plainDirectory(directory, '工作区组件', true);
  }
  fs.mkdirSync(layout.profileRoot, { recursive: true, mode: 0o700 });
  plainDirectory(layout.profileRoot, 'AppBridge 工作区');
  const realRoot = fs.realpathSync(layout.profileRoot);
  for (const [name, directory] of Object.entries(layout)) {
    if (name === 'profileRoot') continue;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    plainDirectory(directory, '工作区组件');
    if (!within(realRoot, fs.realpathSync(directory))) throw new Error(`工作区组件越界：${directory}`);
  }
  return layout;
}

function metadataAt(file) {
  const stat = statOrNull(file);
  if (!stat) return { version: 1, entries: [] };
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`文件夹迁移记录不是普通文件：${file}`);
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!value || value.version !== 1 || !Array.isArray(value.entries)) {
    throw new Error(`文件夹迁移记录格式无效，已保留原件：${file}`);
  }
  return value;
}

function prepareManagedPrefix(prefixPath, workspaceRoot) {
  const root = absoluteDirectory(workspaceRoot, 'AppBridge 工作区');
  const prefix = absoluteDirectory(prefixPath, '软件运行目录');
  if (!within(root, prefix)) throw new Error('软件运行目录必须位于 AppBridge 工作区内。');
  plainDirectory(root, 'AppBridge 工作区');
  const realRoot = fs.realpathSync(root);
  if (!within(realRoot, resolvedLocation(prefix))) throw new Error('软件运行目录通过符号链接指向工作区之外。');
  const emptyResult = { prefixPath: prefix, initialized: false, changed: [], warnings: [], metadataPath: null };
  if (!containedDirectory(prefix, realRoot)) return emptyResult;
  const drive = path.join(prefix, 'drive_c');
  if (!containedDirectory(drive, realRoot)) return emptyResult;
  const users = path.join(drive, 'users');
  if (!containedDirectory(users, realRoot)) return emptyResult;

  const plans = [];
  const visited = new Set();
  for (const user of fs.readdirSync(users, { withFileTypes: true })) {
    const normalized = user.name.replace(/\s/g, '').toLowerCase();
    if (SPECIAL_USERS.has(normalized) || user.name.startsWith('.')) continue;
    if (!user.isDirectory() && !user.isSymbolicLink()) continue;
    const userDirectory = path.join(users, user.name);
    if (!containedDirectory(userDirectory, realRoot)) continue;
    const realUser = fs.realpathSync(userDirectory);
    if (visited.has(realUser)) continue;
    visited.add(realUser);
    for (const folder of USER_FOLDERS) {
      const file = path.join(userDirectory, folder);
      const stat = statOrNull(file);
      if (!stat || !stat.isSymbolicLink()) continue;
      const originalTarget = fs.readlinkSync(file);
      // Preserve symlink/.. semantics until native realpath has resolved them;
      // lexical normalization first could incorrectly classify an external link.
      const target = path.isAbsolute(originalTarget) ? originalTarget : `${path.dirname(file)}${path.sep}${originalTarget}`;
      const resolvedTarget = resolvedLocation(target);
      if (within(realRoot, resolvedTarget, true)) continue;
      plans.push({ file, user: user.name, folder, originalTarget, resolvedTarget,
        relativePath: path.relative(prefix, file), backup: null, stage: null, installed: false });
    }
  }
  const result = { ...emptyResult, initialized: true };
  if (!plans.length) return result;
  const metadataPath = path.join(prefix, '.appbridge-folder-links.json');
  const metadata = metadataAt(metadataPath);
  const convertedAt = new Date().toISOString();
  const entries = [...metadata.entries];
  for (const plan of plans) {
    if (!entries.some((entry) => entry.relativePath === plan.relativePath && entry.originalTarget === plan.originalTarget)) {
      entries.push({ user: plan.user, folder: plan.folder, relativePath: plan.relativePath,
        originalTarget: plan.originalTarget, resolvedTarget: plan.resolvedTarget, convertedAt });
    }
  }

  try {
    for (const plan of plans) {
      // Keep the original link until the entire operation and journal commit
      // succeed. Neither rename nor unlink follows it to the user's Mac files.
      plan.stage = path.join(path.dirname(plan.file), `.appbridge-folder-${randomUUID()}`);
      fs.mkdirSync(plan.stage, { mode: 0o700 });
      const current = statOrNull(plan.file);
      if (!current?.isSymbolicLink() || fs.readlinkSync(plan.file) !== plan.originalTarget) {
        throw new Error(`文件夹在准备期间已改变，已停止：${plan.file}`);
      }
      plan.backup = path.join(path.dirname(plan.file), `.appbridge-link-${randomUUID()}`);
      fs.renameSync(plan.file, plan.backup);
      fs.renameSync(plan.stage, plan.file);
      plan.stage = null;
      plan.installed = true;
    }
    writeJsonAtomic(metadataPath, { ...metadata, version: 1, entries });
  } catch (error) {
    const rollbackErrors = [];
    for (const plan of [...plans].reverse()) {
      try {
        if (plan.installed) {
          // Normal rollback removes an empty directory only. If another process
          // wrote there meanwhile, keep that data in a visible recovery folder.
          try { fs.rmdirSync(plan.file); }
          catch (removeError) {
            if (!['ENOTEMPTY', 'EEXIST'].includes(removeError.code)) throw removeError;
            const recovery = path.join(path.dirname(plan.file), `AppBridge recovery ${plan.folder} ${randomUUID()}`);
            fs.renameSync(plan.file, recovery);
          }
        }
        if (plan.backup && statOrNull(plan.backup)) fs.renameSync(plan.backup, plan.file);
        if (plan.stage && statOrNull(plan.stage)) fs.rmdirSync(plan.stage);
      } catch (rollbackError) { rollbackErrors.push(rollbackError.message); }
    }
    if (rollbackErrors.length) throw new Error(`${error.message}\n部分链接回滚需要检查，原链接备份已保留：${rollbackErrors.join('; ')}`, { cause: error });
    throw error;
  }
  for (const plan of plans) {
    try { fs.unlinkSync(plan.backup); }
    catch (error) { result.warnings.push(`原链接备份尚未清理：${plan.backup}（${error.message}）`); }
  }
  result.changed = plans.map(({ relativePath, originalTarget, resolvedTarget }) => ({ relativePath, originalTarget, resolvedTarget }));
  result.metadataPath = metadataPath;
  return result;
}

module.exports = { workspaceLayout, initializeWorkspace, prepareManagedPrefix };
