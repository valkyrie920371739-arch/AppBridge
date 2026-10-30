#!/usr/bin/env node
'use strict';

// Publish this project's verified archive into its unified local workspace.
// Runtime files, settings, the library and saves share the AppBridge root.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const projectRoot = fs.realpathSync(path.join(__dirname, '..'));
const cloudRoot = path.dirname(projectRoot);
const homeDirectory = os.homedir();
const workspaceRoot = path.join(homeDirectory, 'Library', 'Application Support', 'AppBridge');
const cacheBase = path.join(workspaceRoot, 'runtime');
const legacyCacheBase = path.join(homeDirectory, 'Library', 'Caches', 'AppBridge');
const applicationsDirectory = path.join(homeDirectory, 'Applications');
const installedShortcut = path.join(applicationsDirectory, 'AppBridge.app');

function statIfPresent(file) {
  try { return fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function regularDirectory(directory, { create = false } = {}) {
  let stat = statIfPresent(directory);
  if (!stat && create) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    stat = fs.lstatSync(directory);
  }
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`必须使用普通目录，不能是符号链接：${directory}`);
  }
  if (fs.realpathSync(directory) !== path.resolve(directory)) {
    throw new Error(`目录路径经过符号链接，已停止：${directory}`);
  }
}

function ordinaryFileIfPresent(file) {
  const stat = statIfPresent(file);
  if (stat && (stat.isSymbolicLink() || !stat.isFile())) {
    throw new Error(`目标不是普通文件，已停止以避免覆盖：${file}`);
  }
}

function run(executable, args) {
  const result = spawnSync(executable, args, {
    shell: false, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${path.basename(executable)} 失败（${result.status ?? result.signal}）：${(result.stderr || result.stdout || '').trim()}`);
  }
  return result.stdout;
}

async function digest(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function syncFile(file) {
  const descriptor = fs.openSync(file, 'r+');
  try { fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
}

function writeJsonAtomic(file, value) {
  ordinaryFileIfPresent(file);
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    ordinaryFileIfPresent(file);
    fs.renameSync(temporary, file);
  } catch (error) {
    if (descriptor !== undefined) { try { fs.closeSync(descriptor); } catch {} }
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

async function copyFileAtomic(source, destination, { sha256, mode = 0o644 } = {}) {
  ordinaryFileIfPresent(destination);
  if (statIfPresent(destination) && fs.realpathSync(source) === fs.realpathSync(destination)) {
    if (sha256 && await digest(destination) !== sha256) throw new Error(`文件校验不一致：${destination}`);
    fs.chmodSync(destination, mode);
    return;
  }
  const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.${crypto.randomUUID()}.tmp`);
  try {
    fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(temporary, mode);
    syncFile(temporary);
    if (sha256 && await digest(temporary) !== sha256) throw new Error(`复制后校验不一致：${destination}`);
    ordinaryFileIfPresent(destination);
    fs.renameSync(temporary, destination);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

function verifyCachedApp(appDirectory) {
  const stat = statIfPresent(appDirectory);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`运行副本不是普通应用目录：${appDirectory}`);
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', appDirectory]);
  const attributes = run('/usr/bin/xattr', ['-r', appDirectory]);
  if (/fileprovider|finderinfo|resourcefork/i.test(attributes)) {
    throw new Error(`运行副本含有云盘或资源元数据，已保留并停止：${appDirectory}`);
  }
  fs.accessSync(path.join(appDirectory, 'Contents', 'Resources', 'runtime', 'AppBridgeWine.app', 'Contents', 'MacOS', 'wine'), fs.constants.R_OK | fs.constants.X_OK);
}

function checkShortcut() {
  const stat = statIfPresent(installedShortcut);
  if (!stat) return;
  if (!stat.isSymbolicLink()) throw new Error(`已有应用不是本项目的链接，已保留：${installedShortcut}`);
  const target = path.resolve(path.dirname(installedShortcut), fs.readlinkSync(installedShortcut));
  const oldCloudEntry = path.join(cloudRoot, 'AppBridge.app');
  const managedRoots = [cacheBase, legacyCacheBase];
  if (target !== oldCloudEntry && !managedRoots.some((root) => target === root || target.startsWith(`${root}${path.sep}`))) {
    throw new Error(`已有链接不属于本项目的工作区，已保留：${installedShortcut}`);
  }
}

function reusableLegacyApp(versionDirectory) {
  if (!statIfPresent(legacyCacheBase)) return null;
  try {
    // Reusing an older, verified runtime is a read-only operation. Never follow
    // a redirected cache folder and never remove a cache that fails validation.
    regularDirectory(legacyCacheBase);
    const legacyDirectory = path.join(legacyCacheBase, versionDirectory);
    if (!statIfPresent(legacyDirectory)) return null;
    regularDirectory(legacyDirectory);
    const legacyApp = path.join(legacyDirectory, 'AppBridge.app');
    verifyCachedApp(legacyApp);
    return legacyApp;
  } catch (error) {
    console.warn(`旧运行缓存未复用，原件保留；将从软件包准备。${error.message}`);
    return null;
  }
}

function installShortcut(cachedApp) {
  regularDirectory(applicationsDirectory, { create: true });
  checkShortcut();
  const temporary = path.join(applicationsDirectory, `.AppBridge.${crypto.randomUUID()}.app`);
  try {
    fs.symlinkSync(cachedApp, temporary, 'dir');
    checkShortcut();
    fs.renameSync(temporary, installedShortcut);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

async function main() {
  if (process.platform !== 'darwin') throw new Error('本机发布需要在 macOS 上执行。');
  if (process.argv.length > 2) throw new Error('此脚本不接受参数，仅发布当前项目。');
  if (path.basename(cloudRoot) !== 'AppBridge') throw new Error('工程的父目录必须是 AppBridge，不能发布到其他目录。');
  regularDirectory(cloudRoot);

  const buildInfoPath = path.join(projectRoot, 'build', '构建信息.json');
  const info = JSON.parse(fs.readFileSync(buildInfoPath, 'utf8'));
  if (!info || typeof info !== 'object' || !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/.test(info.version || '')) {
    throw new Error('构建信息缺少有效版本号。');
  }
  const archive = info.archive;
  if (!archive || typeof archive.file !== 'string' || path.basename(archive.file) !== archive.file ||
      !archive.file.endsWith('.zip') || !/^[a-f0-9]{64}$/i.test(archive.sha256 || '')) {
    throw new Error('构建信息必须提供普通 ZIP 文件名和完整 SHA256。');
  }
  const expected = archive.sha256.toLowerCase();
  const sourceArchive = path.join(projectRoot, 'build', archive.file);
  const destinationArchive = path.join(cloudRoot, archive.file);
  if (!fs.statSync(sourceArchive).isFile()) throw new Error('构建的软件包不是文件。');
  if (await digest(sourceArchive) !== expected) throw new Error('构建软件包 SHA256 不一致，已停止发布。');
  const launcherSource = path.join(projectRoot, 'build', '打开 AppBridge.command');
  const launcherText = fs.readFileSync(launcherSource, 'utf8');
  if (!launcherText.includes(expected) || !launcherText.includes(info.version)) throw new Error('启动脚本与当前构建的软件包不匹配。');
  run('/bin/zsh', ['-n', launcherSource]);

  // Check user-owned locations before publishing any new entry points.
  checkShortcut();
  if (statIfPresent(workspaceRoot)) regularDirectory(workspaceRoot);
  const existingBase = statIfPresent(cacheBase);
  if (existingBase) regularDirectory(cacheBase);
  const versionDirectory = `${info.version}-${expected.slice(0, 12)}`;
  const cacheDirectory = path.join(cacheBase, versionDirectory);
  if (statIfPresent(cacheDirectory)) regularDirectory(cacheDirectory);
  const settingsPath = path.join(workspaceRoot, 'settings.json');
  ordinaryFileIfPresent(settingsPath);
  let settings = null;
  if (statIfPresent(settingsPath)) {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('设置文件格式无效，已保留原件。');
  }

  await copyFileAtomic(sourceArchive, destinationArchive, { sha256: expected });
  regularDirectory(workspaceRoot, { create: true });
  regularDirectory(cacheBase, { create: true });
  const cachedApp = path.join(cacheDirectory, 'AppBridge.app');
  let runtimePreparedFrom = 'existing-workspace';
  if (statIfPresent(cacheDirectory)) {
    verifyCachedApp(cachedApp);
  } else {
    const legacyApp = reusableLegacyApp(versionDirectory);
    const staging = fs.mkdtempSync(path.join(cacheBase, '.publish-'));
    try {
      if (legacyApp) {
        run('/usr/bin/ditto', ['--noextattr', '--norsrc', legacyApp, path.join(staging, 'AppBridge.app')]);
        runtimePreparedFrom = 'verified-legacy-cache';
      } else {
        run('/usr/bin/ditto', ['-x', '-k', destinationArchive, staging]);
        runtimePreparedFrom = 'verified-archive';
      }
      verifyCachedApp(path.join(staging, 'AppBridge.app'));
      if (statIfPresent(cacheDirectory)) throw new Error('运行缓存位置在准备期间已出现，请检查后重新发布。');
      fs.renameSync(staging, cacheDirectory);
      verifyCachedApp(cachedApp);
    } catch (error) {
      const preserved = statIfPresent(staging) ? staging : cacheDirectory;
      throw new Error(`${error.message}\n未删除已有缓存；本次准备目录保留在：${preserved}`);
    }
  }

  await copyFileAtomic(buildInfoPath, path.join(cloudRoot, '构建信息.json'));
  await copyFileAtomic(launcherSource, path.join(cloudRoot, '打开 AppBridge.command'), { mode: 0o755 });
  installShortcut(cachedApp);

  let runtimeSettingsUpdated = false;
  if (statIfPresent(settingsPath)) {
    ordinaryFileIfPresent(settingsPath);
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('设置文件格式无效，已保留原件。');
  } else settings = null;
  if (settings && settings.runtimeSource === 'bundled') {
    const wineRuntimePath = path.join(cachedApp, 'Contents', 'Resources', 'runtime', 'AppBridgeWine.app', 'Contents', 'MacOS', 'wine');
    writeJsonAtomic(settingsPath, { ...settings, wineRuntimePath, runtimeCheck: null });
    runtimeSettingsUpdated = true;
  }
  const docsDirectory = path.join(projectRoot, 'docs');
  regularDirectory(docsDirectory, { create: true });
  const report = {
    archive: destinationArchive,
    sha256: expected,
    cachedApp,
    archiveHashVerified: true,
    signatureVerifiedAfterExtraction: true,
    noCloudMetadataInCache: true,
    cloudEntryIsCommand: true,
    workspaceRoot,
    runtimeRoot: cacheBase,
    runtimePreparedFrom,
    installedShortcut,
    runtimeSettingsUpdated,
    publishedAt: new Date().toISOString(),
  };
  writeJsonAtomic(path.join(docsDirectory, 'final-package-check.json'), report);
  console.log(`已发布 AppBridge ${info.version}。`);
  console.log(`云盘软件包：${destinationArchive}`);
  console.log(`AppBridge 工作区运行副本：${cachedApp}`);
  console.log('软件包 SHA256、应用签名及本机元数据检查均已通过。资料库与存档未修改。');
}

main().catch((error) => { console.error(error.stack || error.message || String(error)); process.exitCode = 1; });
