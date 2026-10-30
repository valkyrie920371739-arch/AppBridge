'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const fs = require('node:fs');
const originalFs = require('original-fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { inspectArchive, managedArchive } = require('./core.cjs');
const { probeRuntime, inspectWindowsExecutable, launchWindowsExecutable, discoverRuntime, runtimeSelfTest, runRuntimeCommand } = require('./wine-runtime.cjs');
const { readJsonRecoverable, writeJsonAtomic } = require('./storage.cjs');
const { initializeWorkspace, prepareManagedPrefix } = require('./workspace.cjs');
const { inspectImportFolder, copyImportFolder } = require('./managed-import.cjs');
const { applyGameDisplayProfile } = require('./game-profiles.cjs');
const { prepareEmulatedDisplay } = require('./display-environment.cjs');
const { extractExecutableIcon } = require('./executable-icon.cjs');
const { inspectDataDirectory, relocateAppData } = require('./data-location.cjs');
const { scanRuntimeProcesses } = require('./runtime-processes.cjs');

const arg = (key) => process.argv.find((item) => item.startsWith(`${key}=`))?.slice(key.length + 1);
const profileOverride = arg('--profile');
const profileRoot = profileOverride || path.join(app.getPath('appData'), 'AppBridge');
const workspace = initializeWorkspace(profileRoot);
app.setPath('userData', profileRoot);
const sessionDirectory = path.join(workspace.cacheRoot, 'electron');
fs.mkdirSync(sessionDirectory, { recursive: true });
app.setPath('sessionData', sessionDirectory);
if (typeof app.setAppLogsPath === 'function') app.setAppLogsPath(workspace.logsRoot);
if (!app.requestSingleInstanceLock()) app.exit(0);
const libraryPath = path.join(profileRoot, 'library.json');
const logPath = path.join(workspace.logsRoot, 'player.log');
const legacyLogPath = path.join(profileRoot, 'player.log');
if (fs.existsSync(legacyLogPath) && !fs.existsSync(logPath)) fs.renameSync(legacyLogPath, logPath);
const gameWindows = new Map();
const windowsProcesses = new Map();
const launching = new Set();
const relocating = new Set();
const externalRunning = new Set();
let externalWatchTimer = null;
const executableIcons = new Map();
const settingsPath = path.join(profileRoot, 'settings.json');
const recoveryMessages = [];
const recovered = ({ backupPath }) => recoveryMessages.push(`资料文件损坏，原件已保留：${backupPath}`);
let settings = readJsonRecoverable(settingsPath, { fallback: {}, validate: (v) => v && typeof v === 'object' && !Array.isArray(v), onRecovery: recovered });
let runtimeActivity = null;
let runtimeBusy = false;
let libraryWindow;
let library = [];
let importing = false;
let selfTesting = Boolean(arg('--self-test'));

function recordMacEnvironment() {
  if (process.platform !== 'darwin') return;
  execFile('/usr/bin/sw_vers', [], { timeout: 10000 }, (error, stdout, stderr) => {
    log(`macOS version check: ${error ? error.message : stdout.trim()}`);
    if (stderr) log(stderr.trim());
  });
  execFile('/usr/bin/arch', ['-x86_64', '/usr/bin/true'], { timeout: 10000 }, (error) => {
    log(`Intel instruction execution check: ${error ? error.message : 'passed'}`);
  });
}

function log(message) {
  fs.appendFileSync(logPath, `${new Date().toISOString()} ${String(message)}\n`, 'utf8');
}
function readLibrary() {
  return readJsonRecoverable(libraryPath, { fallback: [], validate: (v) => Array.isArray(v) && v.every((g) => g && typeof g.id === 'string' && typeof g.title === 'string' && typeof g.saveDirectory === 'string' && path.isAbsolute(g.saveDirectory) && ['windows', 'tyrano'].includes(g.kind)), onRecovery: recovered });
}
function writeLibrary() {
  writeJsonAtomic(libraryPath, library);
}
function libraryIcon(game) {
  if (game.kind !== 'windows' || !game.exePath) return null;
  try {
    const stat = fs.statSync(game.exePath);
    const key = `${game.exePath}\0${stat.size}\0${stat.mtimeMs}`;
    if (!executableIcons.has(key)) {
      if (executableIcons.size >= 256) executableIcons.clear();
      executableIcons.set(key, extractExecutableIcon(game.exePath));
    }
    return executableIcons.get(key);
  } catch { return null; }
}
function publicState() {
  return { games: library.filter((game) => !game.hidden).map((game) => ({ ...game, iconData: libraryIcon(game), running: gameWindows.has(game.id) || windowsProcesses.has(game.id) || externalRunning.has(game.id), launching: launching.has(game.id), relocating: relocating.has(game.id) })),
    platform: process.platform, arch: process.arch, version: app.getVersion(), wineVersion: settings.wineVersion || null,
    runtimePath: settings.wineRuntimePath || null, runtimeSource: settings.runtimeSource || null,
    runtimeCheck: settings.runtimeCheck || null, runtimeActivity, recoveryMessages,
    workspace: { root: profileRoot, runtime: workspace.runtimeRoot, apps: workspace.appsRoot, cache: workspace.cacheRoot, logs: workspace.logsRoot, exports: workspace.exportsRoot } };
}
function saveRuntime(runtimePath, version, source) {
  const same = settings.wineRuntimePath === runtimePath && settings.wineVersion === version;
  settings = { ...settings, wineRuntimePath: runtimePath, wineVersion: version, runtimeSource: source, runtimeCheck: same ? settings.runtimeCheck : null };
  writeJsonAtomic(settingsPath, settings); refresh();
}
async function detectRuntime() {
  if (runtimeBusy) throw new Error('正在检测运行环境，请稍候。');
  runtimeBusy = true; runtimeActivity = '正在检测可用运行环境…'; refresh();
  try {
    const found = await discoverRuntime({ bundledRoot: path.join(process.resourcesPath, 'runtime'), homeDirectory: app.getPath('home') });
    if (!found) throw new Error('没有找到可用的 Wine。可手动选择运行文件，或使用包含运行组件的完整构建。');
    saveRuntime(found.executablePath, found.version, found.source); return found;
  } finally { runtimeBusy = false; runtimeActivity = null; refresh(); }
}
async function restoreRuntime() {
  if (settings.wineRuntimePath) {
    runtimeBusy = true; runtimeActivity = '正在验证上次使用的运行环境…'; refresh();
    try {
      const probe = await probeRuntime(settings.wineRuntimePath);
      if (probe.ok) { saveRuntime(settings.wineRuntimePath, probe.version || probe.stdout.trim(), settings.runtimeSource || '手动选择'); return; }
      settings.wineVersion = null; settings.runtimeCheck = null; writeJsonAtomic(settingsPath, settings);
    } finally { runtimeBusy = false; runtimeActivity = null; refresh(); }
  }
  return detectRuntime();
}
function refresh() {
  if (libraryWindow && !libraryWindow.isDestroyed()) libraryWindow.webContents.send('player:changed', publicState());
}
function getGame(id) {
  const game = library.find((item) => item.id === id);
  if (!game) throw new Error('游戏已不在游戏库中。');
  return game;
}
async function checkExistingWindowsProcess(game) {
  const previouslyActive = externalRunning.has(game.id);
  if (game.kind !== 'windows' || !fs.existsSync(game.prefixPath)) { externalRunning.delete(game.id); if (previouslyActive) refresh(); return false; }
  const values = await scanRuntimeProcesses({ helperPath: path.join(process.resourcesPath, 'runtime', 'appbridge-processes'), prefixPath: game.prefixPath });
  const active = values.some((item) => item.kind === 'application' || item.kind === 'unknown');
  if (active) externalRunning.add(game.id); else externalRunning.delete(game.id);
  if (active !== previouslyActive) refresh();
  return active;
}
function watchExistingWindowsProcesses() {
  if (!externalRunning.size || externalWatchTimer) return;
  externalWatchTimer = setTimeout(async () => {
    externalWatchTimer = null;
    for (const id of [...externalRunning]) {
      try { await checkExistingWindowsProcess(getGame(id)); }
      catch (error) { log(`Existing process check ${id}: ${error.message}`); }
    }
    watchExistingWindowsProcesses();
  }, 3000);
  externalWatchTimer.unref?.();
}
async function restoreExistingWindowsProcesses() {
  for (const game of library.filter((item) => item.kind === 'windows' && !item.hidden)) {
    try { await checkExistingWindowsProcess(game); }
    catch (error) { log(`Existing process check ${game.id}: ${error.message}`); }
  }
  refresh(); watchExistingWindowsProcesses();
}
function gameContext(event) {
  for (const record of gameWindows.values()) {
    if (record.window.webContents.id === event.sender.id) return record;
  }
  throw new Error('游戏窗口未登记。');
}
function verifyLibrarySender(event) {
  if (!libraryWindow || event.sender.id !== libraryWindow.webContents.id) throw new Error('无效的界面请求。');
}
function sourceArchive(selection) {
  const info = originalFs.statSync(selection);
  if (info.isDirectory()) return path.join(selection, 'resources', 'app.asar');
  if (path.basename(selection) === 'app.asar') return selection;
  throw new Error('请选择完整游戏文件夹，或其中 resources 文件夹里的 app.asar。');
}
async function importGame(selection) {
  if (importing) throw new Error('已有游戏正在导入，请等待完成。');
  importing = true;
  let staging;
  try {
    const source = sourceArchive(selection);
    if (!originalFs.existsSync(source) || !originalFs.statSync(source).isFile()) throw new Error('这个文件夹里没有 resources/app.asar。请选择与样本格式一致的完整游戏文件夹。');
    const metadata = inspectArchive(source, (file) => fs.readFileSync(file));
    const hash = crypto.createHash('sha256');
    for await (const chunk of originalFs.createReadStream(source)) hash.update(chunk);
    const digest = hash.digest('hex');
    const existing = library.find((game) => game.sha256 === digest);
    if (existing) { existing.hidden = false; writeLibrary(); refresh(); return { game: existing, alreadyImported: true }; }
    const id = crypto.randomUUID();
    const gameProfile = path.join(profileRoot, 'games', id);
    const destination = managedArchive(gameProfile, process.platform);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    staging = `${destination}.partial`;
    await originalFs.promises.copyFile(source, staging);
    await originalFs.promises.rename(staging, destination);
    staging = null;
    const game = { id, kind: 'tyrano', ...metadata, sha256: digest, archivePath: destination,
      saveDirectory: gameProfile, importedAt: new Date().toISOString(), lastPlayedAt: null };
    library.push(game);
    writeLibrary();
    log(`Imported ${id}; SHA256=${digest}; interface=${metadata.interfaceHash}`);
    refresh();
    return { game, alreadyImported: false };
  } finally {
    if (staging && originalFs.existsSync(staging)) await originalFs.promises.unlink(staging);
    importing = false;
  }
}

function openGame(game, hidden = false) {
  if (process.platform === 'darwin' && process.execPath.includes('var/folders')) {
    throw new Error('播放器正从 macOS 的临时位置运行。请关闭它，然后使用压缩包中的“安装并打开.command”安装后再运行，以确保独立存档位置正确。');
  }
  const existing = gameWindows.get(game.id);
  if (existing) { existing.window.focus(); return existing.window; }
  inspectArchive(game.archivePath, (file) => fs.readFileSync(file));
  const window = new BrowserWindow({
    width: game.width, height: game.height, useContentSize: true, show: false,
    minWidth: 640, minHeight: 360, backgroundColor: '#10131b', title: game.title,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: false,
      preload: path.join(__dirname, 'game-preload.cjs'), partition: `persist:game-${game.id}` },
  });
  gameWindows.set(game.id, { window, game });
  window.webContents.setUserAgent(`${window.webContents.getUserAgent()} TyranoErectron`);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== window.webContents.getURL()) event.preventDefault();
  });
  window.webContents.on('preload-error', (_event, _file, error) => log(`Preload: ${error.stack || error}`));
  window.webContents.on('render-process-gone', (_event, details) => log(`Renderer ${game.id}: ${details.reason}`));
  window.webContents.on('did-fail-load', (_event, code, description) => log(`Load ${game.id}: ${code} ${description}`));
  window.webContents.on('console-message', (...args) => {
    const details = args[0];
    if (typeof details === 'object' && details.level === 'error') log(`Game ${game.id}: ${details.message}`);
  });
  window.once('ready-to-show', () => { if (!hidden) window.show(); });
  window.on('closed', () => { gameWindows.delete(game.id); refresh(); });
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') {
      window.setFullScreen(!window.isFullScreen()); event.preventDefault();
    }
  });
  window.loadFile(path.join(game.archivePath, 'index.html')).catch((error) => log(error.stack));
  game.lastPlayedAt = new Date().toISOString();
  writeLibrary(); refresh();
  return window;
}

ipcMain.on('player:game-context', (event) => {
  const { game } = gameContext(event);
  event.returnValue = { archivePath: game.archivePath, saveDirectory: game.saveDirectory };
});
ipcMain.on('getAppPath', (event) => { event.returnValue = gameContext(event).game.archivePath; });
ipcMain.on('getProcess', (event) => {
  const { game } = gameContext(event);
  event.returnValue = { platform: process.platform, __dirname: game.archivePath,
    execPath: process.execPath, env: { HOME: app.getPath('home') } };
});
ipcMain.on('doubleCheck', (event) => { gameContext(event); event.returnValue = true; });
ipcMain.on('showSelectFileDialog', (event, options = {}) => {
  const { window } = gameContext(event);
  const files = dialog.showOpenDialogSync(window, { title: options.title || '',
    properties: ['openFile'], filters: options.extensions?.length ? [{ name: 'Files', extensions: options.extensions }] : [] });
  event.returnValue = files?.[0] ? { filepath: files[0], filename: path.basename(files[0]), dirname: path.dirname(files[0]) } : undefined;
});
ipcMain.on('showSaveDialog', (event, options = {}) => {
  const { window } = gameContext(event);
  event.returnValue = dialog.showSaveDialogSync(window, { title: options.title || '', defaultPath: options.filename || '' });
});

function handle(channel, callback) {
  ipcMain.handle(channel, async (event, ...args) => {
    verifyLibrarySender(event);
    try { return { ok: true, value: await callback(...args) }; }
    catch (error) { log(`${channel}: ${error.stack || error}`); return { ok: false, error: error.message }; }
  });
}
handle('player:state', () => publicState());
handle('player:workspace', async (section = 'root') => {
  const locations = { root: profileRoot, runtime: workspace.runtimeRoot, apps: workspace.appsRoot, cache: workspace.cacheRoot, logs: workspace.logsRoot, exports: workspace.exportsRoot };
  if (typeof section !== 'string' || !Object.hasOwn(locations, section)) throw new Error('未知的工作区分类。');
  const error = await shell.openPath(locations[section]);
  if (error) throw new Error(error);
  return true;
});
handle('player:import', async () => {
  const choice = await dialog.showMessageBox(libraryWindow, { type: 'question', title: '添加应用',
    message: '选择要添加的应用类型', buttons: ['Windows 程序（.exe）', 'TyranoScript 游戏文件夹', '取消'], cancelId: 2 });
  if (choice.response === 2) return null;
  if (choice.response === 0) {
    const result = await dialog.showOpenDialog(libraryWindow, { title: '选择要运行的 Windows 程序或安装包',
      properties: ['openFile'], filters: [{ name: 'Windows executable', extensions: ['exe'] }] });
    if (result.canceled) return null;
    const executable = result.filePaths[0];
    const metadata = inspectWindowsExecutable(executable);
    if (metadata.isDll) throw new Error('选择的文件是动态链接库，请选择程序本身。');
    const existing = library.find((item) => item.kind === 'windows' && (item.exePath === executable || item.sourceExePath === executable));
    if (existing) { existing.hidden = false; writeLibrary(); refresh(); return { game: existing, alreadyImported: true }; }
    const plan = inspectImportFolder(executable, { homeDirectory: app.getPath('home'), workspaceRoot: profileRoot,
      cloudRoot: path.join(app.getPath('home'), 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'AppBridge') });
    if (!plan.alreadyManaged) {
      const confirmation = await dialog.showMessageBox(libraryWindow, { type: 'question', title: '复制到 AppBridge 工作区',
        message: '将完整程序文件夹收进 AppBridge',
        detail: `${plan.sourceDirectory}\n${plan.files} 个文件，约 ${(plan.sizeBytes / 1024 / 1024).toFixed(1)} MB。\n保留源文件，今后使用工作区中的副本。`,
        buttons: ['复制并添加', '取消'], defaultId: 0, cancelId: 1 });
      if (confirmation.response !== 0) return null;
    }
    const id = crypto.randomUUID();
    const saveDirectory = path.join(profileRoot, 'windows-apps', id);
    fs.mkdirSync(saveDirectory, { recursive: true });
    const managedExecutable = copyImportFolder(plan, saveDirectory);
    const game = { id, kind: 'windows', title: path.basename(executable), exePath: managedExecutable, sourceExePath: executable,
      engine: 'Windows', architecture: metadata.architecture || metadata.machineHex, saveDirectory,
      prefixPath: path.join(saveDirectory, 'prefix'), importedAt: new Date().toISOString(), lastPlayedAt: null };
    library.push(game); writeLibrary(); refresh(); return { game, alreadyImported: false };
  }
  const result = await dialog.showOpenDialog(libraryWindow, { title: '选择完整游戏文件夹', properties: ['openDirectory'] });
  if (result.canceled) return null;
  return importGame(result.filePaths[0]);
});
handle('player:launch', async (id) => {
  const game = getGame(id);
  if (relocating.has(id)) throw new Error('应用数据正在整理，请完成后再启动。');
  if (game.kind !== 'windows') { openGame(game); return true; }
  if (process.platform !== 'darwin') throw new Error('Windows 兼容运行入口需要在 Mac 版中验证。当前环境只做文件检查。');
  if (windowsProcesses.has(id) || launching.has(id)) throw new Error('该应用正在启动或运行，请查看已经打开的窗口。');
  launching.add(id); refresh();
  try {
    if (await checkExistingWindowsProcess(game)) { watchExistingWindowsProcesses(); throw new Error('此应用已经在运行，请先查看已有窗口。'); }
    if (!settings.wineRuntimePath) await detectRuntime();
    const runtimePath = settings.wineRuntimePath;
    const probe = await probeRuntime(runtimePath);
    if (!probe.ok) throw new Error(probe.error || `运行环境检测失败：${probe.stderr}`);
    const prefixRecordPath = path.join(game.saveDirectory, 'prefix-state.json');
    const prefixRecord = readJsonRecoverable(prefixRecordPath, { fallback: {}, onRecovery: recovered });
    let prefixRecordChanged = false;
    const prefixExists = fs.existsSync(path.join(game.prefixPath, 'system.reg'));
    if (!prefixExists) delete prefixRecord.emulatedDisplayModes;
    if (prefixRecord.runtimePath !== runtimePath || !prefixExists) {
      log(`Preparing managed Windows directory for ${id}`);
      const prepared = await runtimeSelfTest({ runtimePath, prefixPath: game.prefixPath });
      if (!prepared.ok) throw new Error(prepared.error || prepared.stderr || '应用运行目录初始化失败。');
      Object.assign(prefixRecord, { runtimePath, preparedAt: new Date().toISOString() });
      prefixRecordChanged = true;
    }
    const folders = prepareManagedPrefix(game.prefixPath, game.dataRoot || profileRoot);
    if (folders.changed.length) log(`Managed user folders ${id}: ${JSON.stringify(folders.changed)}`);
    if (settings.runtimeSource === 'bundled' && prefixRecord.emulatedDisplayModes !== 1) {
      // This prefix belongs to this application and its game is not running.
      // Wine can provide virtual modes without switching the Mac display.
      const modes = await prepareEmulatedDisplay({ runtimePath, prefixPath: game.prefixPath,
        saveDirectory: game.saveDirectory, runCommand: runRuntimeCommand });
      log(`Emulated display modes ${id}: ${JSON.stringify(modes)}`);
      prefixRecord.emulatedDisplayModes = 1;
      prefixRecordChanged = true;
    }
    if (prefixRecordChanged) writeJsonAtomic(prefixRecordPath, prefixRecord);
    const unity = fs.existsSync(path.join(path.dirname(game.exePath), 'UnityPlayer.dll'));
    const display = game.display || { mode: 'app', width: 1280, height: 720, hideDock: true };
    const displayProfile = await applyGameDisplayProfile({ exePath: game.exePath, runtimePath, prefixPath: game.prefixPath, saveDirectory: game.saveDirectory, display, runCommand: runRuntimeCommand });
    if (displayProfile.applied) log(`Display profile ${id}: ${JSON.stringify(displayProfile)}`);
    const launchArguments = unity ? ['-force-d3d11', '-logFile', path.join(game.saveDirectory, 'unity-player.log')] : [];
    if (unity && display.mode !== 'app') {
      launchArguments.push('-screen-fullscreen', display.mode === 'fullscreen' ? '1' : '0', '-screen-width', String(display.width), '-screen-height', String(display.height));
      if (display.mode === 'fullscreen') launchArguments.push('-window-mode', 'borderless');
    }
    const displayHelperPath = path.join(process.resourcesPath, 'runtime', 'display-helper.dylib');
    const runtimeLog = path.join(game.saveDirectory, 'runtime.log');
    if (fs.existsSync(runtimeLog) && fs.statSync(runtimeLog).size > 4 * 1024 * 1024) fs.renameSync(runtimeLog, `${runtimeLog}.${Date.now()}.bak`);
    fs.appendFileSync(runtimeLog, `\n${new Date().toISOString()} Launch ${game.title}; ${probe.stdout.trim()}; ${JSON.stringify(launchArguments)}\n`);
    const child = launchWindowsExecutable({ runtimePath, exePath: game.exePath,
      prefixPath: game.prefixPath, workingDirectory: path.dirname(game.exePath), launchArguments,
      ...(settings.runtimeSource === 'bundled' && fs.existsSync(displayHelperPath) ? { displayHelperPath, displayOptions: { ...display, mode: unity && display.mode === 'fullscreen' ? 'app' : display.mode } } : {}),
      onOutput: (output) => { fs.appendFileSync(runtimeLog, `[${output.stream}] ${output.text}`); },
      onExit: (details) => { windowsProcesses.delete(id); game.lastExit = { ...details, at: new Date().toISOString() }; writeLibrary(); log(`Windows process ${id}: ${JSON.stringify(details)}`); refresh(); },
    });
    windowsProcesses.set(id, child);
    game.engine = unity ? 'Unity · Direct3D 11' : 'Windows';
    game.lastPlayedAt = new Date().toISOString(); writeLibrary(); refresh(); return true;
  } finally { launching.delete(id); refresh(); }
});
handle('player:detect-runtime', detectRuntime);
handle('player:test-runtime', async () => {
  if (runtimeBusy) throw new Error('运行环境正在检测，请稍候。');
  if (!settings.wineRuntimePath) await detectRuntime();
  runtimeBusy = true; runtimeActivity = '正在初始化独立测试目录并执行 Windows 命令，首次可能需要约一分钟…'; refresh();
  try {
    const result = await runtimeSelfTest({ runtimePath: settings.wineRuntimePath, prefixPath: path.join(profileRoot, 'runtime-check') });
    settings.runtimeCheck = { ...result, checkedAt: new Date().toISOString() };
    writeJsonAtomic(settingsPath, settings); log(`Runtime self-test: ${JSON.stringify(result)}`);
    if (!result.ok) throw new Error(result.error || result.stderr || 'Windows 命令测试失败，请导出诊断日志。');
    return result;
  } finally { runtimeBusy = false; runtimeActivity = null; refresh(); }
});
handle('player:runtime', async () => {
  if (process.platform !== 'darwin') throw new Error('请在 Mac 上选择并检测 Wine 运行环境。');
  if (runtimeBusy || launching.size) throw new Error('请等待当前检测或启动完成。');
  runtimeBusy = true; runtimeActivity = '正在选择并验证运行环境…'; refresh();
  try {
  const result = await dialog.showOpenDialog(libraryWindow, { title: '选择已安装的免费 Wine 运行环境可执行文件',
    message: '可展开 .app 包。请选择运行文件本身；播放器不会根据名称或安装位置自动推断。',
    properties: ['openFile', 'treatPackageAsDirectory'] });
  if (result.canceled) return null;
  const runtimePath = result.filePaths[0];
  const probe = await probeRuntime(runtimePath);
  if (!probe.ok) throw new Error(probe.error || `运行环境自检失败：${probe.stderr}`);
  saveRuntime(runtimePath, probe.stdout.trim(), '手动选择'); return settings.wineVersion;
  } finally { runtimeBusy = false; runtimeActivity = null; refresh(); }
});
handle('player:entry', async (id) => {
  const game = getGame(id);
  if (game.kind !== 'windows') throw new Error('此操作只适用于 Windows 程序。');
  if (windowsProcesses.has(id) || launching.has(id) || relocating.has(id)) throw new Error('请先关闭此应用并等待文件操作完成。');
  const result = await dialog.showOpenDialog(libraryWindow, { title: '选择安装后的程序入口',
    defaultPath: game.prefixPath, properties: ['openFile'], filters: [{ name: 'Windows executable', extensions: ['exe'] }] });
  if (result.canceled) return false;
  const metadata = inspectWindowsExecutable(result.filePaths[0]);
  if (metadata.isDll) throw new Error('选择的文件是动态链接库，请选择程序本身。');
  game.exePath = result.filePaths[0]; game.title = path.basename(game.exePath); game.architecture = metadata.architecture || metadata.machineHex;
  writeLibrary(); refresh(); return true;
});
handle('player:display', async (id, options) => {
  const game = getGame(id);
  if (game.kind !== 'windows') throw new Error('显示设置适用于 Windows 应用。');
  if (windowsProcesses.has(id) || launching.has(id) || relocating.has(id)) throw new Error('请先关闭此应用并等待文件操作完成，再修改显示设置。');
  if (await checkExistingWindowsProcess(game)) { watchExistingWindowsProcesses(); throw new Error('此应用仍在运行，请关闭后再修改显示设置。'); }
  if (relocating.has(id)) throw new Error('应用数据正在整理，请完成后再修改显示设置。');
  if (!options || !['app', 'windowed', 'fullscreen'].includes(options.mode) ||
      !Number.isInteger(options.width) || options.width < 640 || options.width > 7680 ||
      !Number.isInteger(options.height) || options.height < 360 || options.height > 4320 || typeof options.hideDock !== 'boolean') {
    throw new Error('请选择显示方式，宽度需为 640–7680，高度需为 360–4320 的整数。');
  }
  game.display = { mode: options.mode, width: options.width, height: options.height, hideDock: options.hideDock };
  writeLibrary(); refresh(); return game.display;
});
handle('player:saves', async (id) => {
  const error = await shell.openPath(getGame(id).saveDirectory);
  if (error) throw new Error(error);
});
handle('player:relocate-data', async (id) => {
  const game = getGame(id);
  if (gameWindows.has(id) || windowsProcesses.has(id) || launching.has(id) || relocating.has(id)) throw new Error('请先关闭应用，再更改数据与存档的存放位置。');
  relocating.add(id); refresh();
  try {
    const oldDirectory = game.saveDirectory;
    const relativePrefix = game.prefixPath ? path.relative(oldDirectory, game.prefixPath) : null;
    if (game.kind === 'windows' && (!relativePrefix || relativePrefix.startsWith('..') || path.isAbsolute(relativePrefix))) throw new Error('此应用的运行目录不在数据文件夹内，已保留原位置。');
    const helperPath = path.join(process.resourcesPath, 'runtime', 'appbridge-processes');
    const inspectProcesses = async () => {
      if (game.kind !== 'windows' || !fs.existsSync(game.prefixPath)) return [];
      const processes = await scanRuntimeProcesses({ helperPath, prefixPath: game.prefixPath });
      if (processes.some((entry) => entry.kind === 'application' || entry.kind === 'unknown')) throw new Error('这个应用仍有运行中的进程。请先完全关闭应用，再更改存放位置。');
      return processes;
    };
    const quiesceRuntime = async () => {
      const processes = await inspectProcesses();
      if (!processes.length) return;
      if (!settings.wineRuntimePath) throw new Error('请先在“运行环境”中检测可用组件。');
      const server = path.join(path.dirname(settings.wineRuntimePath), 'wineserver');
      const options = { prefixPath: game.prefixPath, timeoutMs: 20000 };
      const stopped = await runRuntimeCommand(server, ['-k'], options);
      const absent = stopped.exitCode === 1 && !stopped.timedOut && !stopped.signal && !stopped.stdout?.trim() && !stopped.stderr?.trim();
      if (!stopped.ok && !absent) throw new Error('无法结束旧运行环境，原数据位置已保留。');
      const waited = await runRuntimeCommand(server, ['-w'], options);
      if (!waited.ok || (await inspectProcesses()).length) throw new Error('运行环境尚未完全结束，原数据位置已保留。');
    };
    await inspectProcesses();
    const picked = await dialog.showOpenDialog(libraryWindow, { title: '选择数据与存档的存放位置',
      message: '将在所选文件夹中建立“AppBridge 数据”，完整复制并继续使用新位置。',
      defaultPath: path.dirname(oldDirectory), properties: ['openDirectory', 'createDirectory'] });
    if (picked.canceled || !picked.filePaths?.[0]) return { canceled: true };
    await quiesceRuntime();
    const info = await inspectDataDirectory(oldDirectory);
    const proposed = path.join(picked.filePaths[0], 'AppBridge 数据', game.id);
    const confirmation = await dialog.showMessageBox(libraryWindow, { type: 'question', title: '更改数据与存档位置',
      message: '复制完整数据并切换到新位置',
      detail: `当前位置：${oldDirectory}\n新位置：${proposed}\n${info.files} 个文件，约 ${(info.sizeBytes / 1024 / 1024).toFixed(1)} MB。\n原位置保留备份，完成后从 AppBridge 继续访问。`,
      buttons: ['复制并切换', '取消'], defaultId: 0, cancelId: 1 });
    if (confirmation.response !== 0) return { canceled: true };
    await quiesceRuntime();
    const previous = { ...game };
    const remap = (file, newDirectory) => {
      if (!file) return file;
      const relative = path.relative(oldDirectory, file);
      return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) ? path.join(newDirectory, relative) : file;
    };
    const result = await relocateAppData({ sourceDirectory: oldDirectory, targetParent: picked.filePaths[0], appId: game.id,
      commit: async (location) => {
        if ((await inspectProcesses()).length) throw new Error('复制期间运行环境又被打开，已保留原数据位置。请关闭应用后重试。');
        Object.assign(game, { saveDirectory: location.saveDirectory, dataRoot: location.storageRoot, previousDataDirectory: oldDirectory,
          prefixPath: remap(game.prefixPath, location.saveDirectory), exePath: remap(game.exePath, location.saveDirectory),
          archivePath: remap(game.archivePath, location.saveDirectory), dataLocationChangedAt: new Date().toISOString() });
        try { writeLibrary(); }
        catch (error) { for (const key of Object.keys(game)) delete game[key]; Object.assign(game, previous); throw error; }
      } });
    log(`Data location ${id}: ${oldDirectory} -> ${result.saveDirectory}; original retained`);
    refresh(); return { ...result, unchanged: !result.changed, backupDirectory: oldDirectory };
  } finally { relocating.delete(id); refresh(); }
});
handle('player:remove', (id) => {
  getGame(id);
  if (gameWindows.has(id) || windowsProcesses.has(id) || launching.has(id) || relocating.has(id)) throw new Error('请先关闭这个应用并等待文件操作完成。');
  getGame(id).hidden = true; writeLibrary(); refresh();
});
handle('player:export-log', async () => {
  const result = await dialog.showSaveDialog(libraryWindow, { title: '导出诊断日志', defaultPath: path.join(workspace.exportsRoot, 'AppBridge-diagnostics.json') });
  if (result.canceled) return false;
  const tail = (file) => { try { const fd = fs.openSync(file, 'r'); try { const size = fs.fstatSync(fd).size; const data = Buffer.alloc(Math.min(size, 128 * 1024)); fs.readSync(fd, data, 0, data.length, size - data.length); return data.toString('utf8'); } finally { fs.closeSync(fd); } } catch { return null; } };
  writeJsonAtomic(result.filePath, { exportedAt: new Date().toISOString(), state: publicState(), playerLog: tail(logPath), apps: library.filter((g) => g.kind === 'windows' && !g.hidden).map((g) => ({ id: g.id, title: g.title, runtimeLog: tail(path.join(g.saveDirectory, 'runtime.log')), unityLog: tail(path.join(g.saveDirectory, 'unity-player.log')) })) }); return true;
});

function createLibrary() {
  const compactPreview = Boolean(profileOverride && arg('--ui-test-size') === 'compact');
  libraryWindow = new BrowserWindow({ width: compactPreview ? 840 : 1100, height: compactPreview ? 600 : 760, minWidth: 840, minHeight: 600,
    backgroundColor: '#f6f7f9', title: 'AppBridge',
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 18 } } : {}),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  libraryWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  libraryWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  libraryWindow.on('closed', () => { libraryWindow = null; });
  libraryWindow.loadFile(path.join(__dirname, 'ui.html'));
}

async function runSelfTest() {
  const report = { platform: process.platform, arch: process.arch, electron: process.versions.electron };
  try {
    const imported = await importGame(arg('--self-test'));
    const window = openGame(imported.game, true);
    await new Promise((resolve, reject) => {
      window.webContents.once('did-finish-load', resolve);
      window.webContents.once('did-fail-load', (_event, code, description) => reject(new Error(`${code}: ${description}`)));
    });
    let state;
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      state = await window.webContents.executeJavaScript(`({
        bridge: typeof window.studio_api === 'object',
        engine: !!(window.TYRANO && TYRANO.kag && TYRANO.kag.config && TYRANO.kag.config.projectID === ${JSON.stringify(imported.game.projectID)} && TYRANO.kag.stat.is_strong_stop),
        layers: document.querySelectorAll('#tyrano_base > *').length,
        savePath: (window.jQuery && typeof jQuery.getExePath === 'function') ? jQuery.getExePath() : null
      })`);
      if (state.engine && state.layers > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    report.state = state;
    if (!state.engine || !state.bridge) throw new Error('Game initialization did not complete before timeout.');
    if (path.resolve(state.savePath) !== path.resolve(imported.game.saveDirectory)) throw new Error('Save path mismatch.');
    const saveResult = await window.webContents.executeJavaScript(`(() => {
      const key = '__minigame_player_selftest__';
      jQuery.setStorageFile(key, {playerTest: 'ok'});
      const result = JSON.parse(jQuery.getStorageFile(key));
      return result.playerTest === 'ok';
    })()`);
    if (!saveResult) throw new Error('Save roundtrip failed.');
    const probePath = path.join(imported.game.saveDirectory, '__minigame_player_selftest__.sav');
    if (!originalFs.existsSync(probePath)) throw new Error('Save probe did not reach the managed game directory.');
    originalFs.unlinkSync(probePath);
    report.saveRoundtrip = true; report.ok = true;
    window.destroy();
  } catch (error) { report.ok = false; report.error = error.stack; }
  fs.writeFileSync(arg('--test-report'), JSON.stringify(report, null, 2));
  app.exit(report.ok ? 0 : 1);
}

process.on('uncaughtException', (error) => {
  log(error.stack || error);
  if (!selfTesting) dialog.showErrorBox('AppBridge', `${error.message}\n可在游戏库导出日志。`);
});
app.whenReady().then(async () => {
  log(`AppBridge ${app.getVersion()}; ${process.platform}/${process.arch}; Electron ${process.versions.electron}; OS=${os.release()}; CPU=${os.cpus()[0]?.model || 'unavailable'}`);
  recordMacEnvironment();
  library = readLibrary();
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'AppBridge', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit', label: '退出' }] },
    { label: '编辑', submenu: [{ role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'togglefullscreen', label: '切换全屏' }, { role: 'close', label: '关闭窗口' }] },
  ]));
  if (selfTesting) await runSelfTest(); else {
    createLibrary();
    restoreExistingWindowsProcesses().catch((error) => log(`Existing process restore: ${error.message}`));
    if (process.platform === 'darwin') restoreRuntime().catch((error) => log(`Runtime discovery: ${error.message}`));
  }
}).catch((error) => { log(error.stack); app.exit(1); });
app.on('window-all-closed', () => { if (!selfTesting) app.quit(); });
app.on('second-instance', () => {
  if (libraryWindow) { if (libraryWindow.isMinimized()) libraryWindow.restore(); libraryWindow.show(); libraryWindow.focus(); }
});
app.on('activate', () => { if (!libraryWindow && !selfTesting) createLibrary(); });
