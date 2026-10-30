'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const RESISTER_SHA256 = 'c84fdc125d469680fa25b9eb0ce204d63ae7bcc3ad8852bda95880ce558adba6';
const REGISTRY_KEY = 'HKCU\\Software\\Alan.Maiyer\\Re:Sister';
const REGISTRY_FILE_KEY = 'HKEY_CURRENT_USER\\Software\\Alan.Maiyer\\Re:Sister';
const COMMAND_TIMEOUT_MS = 20000;

function absolutePath(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) throw new Error(`${label}必须是明确的绝对路径。`);
  return path.resolve(value);
}

function validateDisplay(display) {
  if (!display || typeof display !== 'object' || Array.isArray(display) ||
      !['app', 'windowed', 'fullscreen'].includes(display.mode) ||
      !Number.isInteger(display.width) || display.width < 640 || display.width > 7680 ||
      !Number.isInteger(display.height) || display.height < 360 || display.height > 4320) {
    throw new Error('显示方式无效；宽度需为 640–7680，高度需为 360–4320 的整数。');
  }
}

function buildDisplayValues(display) {
  validateDisplay(display);
  if (display.mode === 'app') return {};
  const fullscreen = display.mode === 'fullscreen';
  return {
    fullscreen_h1476830426: fullscreen ? 1 : 0,
    'Screenmanager Fullscreen mode_h3630240806': fullscreen ? 1 : 3,
    'Screenmanager Resolution Width_h182942802': display.width,
    'Screenmanager Resolution Height_h2627697771': display.height,
    'Screenmanager Resolution Window Width_h2524650974': display.width,
    'Screenmanager Resolution Window Height_h1684712807': display.height,
  };
}

async function executableDigest(exePath) {
  const stat = await fs.promises.stat(exePath);
  if (!stat.isFile()) throw new Error('Windows 程序路径不是文件。');
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(exePath)) hash.update(chunk);
  return hash.digest('hex');
}

function ordinaryDirectory(directory, label) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label}必须是普通目录，不能是符号链接。`);
  return fs.realpathSync(directory);
}

function backupDirectory(saveDirectory) {
  const root = ordinaryDirectory(saveDirectory, '应用数据目录');
  const directory = path.join(root, 'display-backups');
  try { fs.mkdirSync(directory, { mode: 0o700 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (ordinaryDirectory(directory, '显示设置备份目录') !== directory) throw new Error('显示设置备份目录不能指向应用数据目录之外。');
  return directory;
}

function verifyZDrive(prefixPath) {
  const drive = path.join(prefixPath, 'dosdevices', 'z:');
  let target;
  try { target = fs.realpathSync(drive); }
  catch { throw new Error('运行目录尚未建立可用的 Z: 文件映射，无法安全备份游戏显示设置。'); }
  if (target !== '/') throw new Error('运行目录的 Z: 映射不是本机根目录，无法安全备份游戏显示设置。');
}

function verifyBackup(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) throw new Error('运行环境没有生成有效的显示设置备份。');
  const descriptor = fs.openSync(file, 'r');
  try {
    const data = Buffer.alloc(Math.min(stat.size, 512));
    const count = fs.readSync(descriptor, data, 0, data.length, 0);
    const bytes = data.subarray(0, count);
    const text = bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.subarray(2).toString('utf16le') : bytes.toString('utf8').replace(/^\uFEFF/, '');
    if (!/^(Windows Registry Editor Version 5\.00|REGEDIT4)(?:\r?\n|$)/.test(text)) throw new Error('显示设置备份格式无效，未修改游戏设置。');
  } finally { fs.closeSync(descriptor); }
  fs.chmodSync(file, 0o600);
}

function commandError(result) {
  const value = result?.error || result?.stderr || result?.stdout || '运行命令失败。';
  return (value instanceof Error ? value.message : String(value)).trim().slice(0, 2000);
}

function createApplier(profileMap) {
  // Copy descriptors into a private map. Tests cannot mutate the default map.
  const profiles = new Map([...profileMap].map(([sha256, profile]) => {
    if (!/^[a-f0-9]{64}$/i.test(sha256) || !profile || typeof profile.name !== 'string' || !profile.name) throw new Error('显示适配配置无效。');
    return [sha256.toLowerCase(), Object.freeze({ name: profile.name })];
  }));

  return async function applyGameDisplayProfile({ exePath, runtimePath, prefixPath, saveDirectory, display, runCommand } = {}) {
    exePath = absolutePath(exePath, 'Windows 程序路径');
    runtimePath = absolutePath(runtimePath, '运行环境路径');
    prefixPath = absolutePath(prefixPath, '软件运行目录');
    saveDirectory = absolutePath(saveDirectory, '应用数据目录');
    validateDisplay(display);
    if (display.mode === 'app') return { applied: false, reason: 'follow-app' };
    const sha256 = await executableDigest(exePath);
    const profile = profiles.get(sha256);
    if (!profile) return { applied: false, reason: 'unrecognized-executable' };
    if (typeof runCommand !== 'function') throw new Error('缺少运行环境命令接口。');
    verifyZDrive(prefixPath);

    const directory = backupDirectory(saveDirectory);
    const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID()}.reg`;
    const backupPath = path.join(directory, name);
    const windowsBackupPath = `Z:${backupPath.replaceAll('/', '\\')}`;
    const descriptor = fs.openSync(backupPath, 'wx', 0o600);
    fs.closeSync(descriptor);
    const options = { prefixPath, timeoutMs: COMMAND_TIMEOUT_MS };
    let exported;
    try { exported = await runCommand(runtimePath, ['reg', 'export', REGISTRY_KEY, windowsBackupPath, '/y'], options); }
    catch (error) { exported = { ok: false, error }; }
    if (!exported?.ok) {
      const failure = new Error(`无法备份 ${profile.name} 的现有显示设置，未修改任何设置。请先使用“跟随游戏”启动一次。${commandError(exported)}`);
      failure.profile = profile.name; failure.backupPath = backupPath; failure.rollbackAttempted = false;
      throw failure;
    }
    try { verifyBackup(backupPath); }
    catch (error) { throw new Error(`无法确认显示设置备份，未修改游戏设置。${error.message}`, { cause: error }); }

    const values = buildDisplayValues(display);
    const applyFile = path.join(directory, name.replace(/\.reg$/, '.apply.reg'));
    const windowsApplyPath = `Z:${applyFile.replaceAll('/', '\\')}`;
    try {
      // Only fixed profile value names and previously validated integers are
      // serialized. One import avoids starting six separate Wine processes.
      const lines = ['Windows Registry Editor Version 5.00', '', `[${REGISTRY_FILE_KEY}]`,
        ...Object.entries(values).map(([valueName, value]) => `"${valueName}"=dword:${value.toString(16).padStart(8, '0')}`), '', ''];
      fs.writeFileSync(applyFile, `\uFEFF${lines.join('\r\n')}`, { encoding: 'utf16le', mode: 0o600, flag: 'wx' });
      const result = await runCommand(runtimePath, ['reg', 'import', windowsApplyPath], options);
      if (!result?.ok) throw new Error(commandError(result));
    } catch (error) {
      let rollback;
      try { rollback = await runCommand(runtimePath, ['reg', 'import', windowsBackupPath], options); }
      catch (rollbackError) { rollback = { ok: false, error: rollbackError }; }
      const rollbackOk = Boolean(rollback?.ok);
      const detail = rollbackOk ? '已成功导入启动前的设置备份。' : `恢复备份也未成功：${commandError(rollback)}`;
      const failure = new Error(`无法应用 ${profile.name} 的启动显示设置。${detail}\n备份：${backupPath}\n原因：${error.message || error}`, { cause: error });
      Object.assign(failure, { profile: profile.name, backupPath, applyFile, values, rollbackAttempted: true, rollbackOk, rollbackError: rollbackOk ? null : commandError(rollback) });
      throw failure;
    }
    return { applied: true, profile: profile.name, backupPath, applyFile, values, sha256 };
  };
}

const applyGameDisplayProfile = createApplier(new Map([[RESISTER_SHA256, { name: 'ReSister 1.10 显示偏好' }]]));

module.exports = {
  applyGameDisplayProfile,
  buildDisplayValues,
  // Offline test dependency injection only; application IPC uses the closed-over
  // applyGameDisplayProfile above and cannot supply an alternate profile map.
  __createGameDisplayProfilerForTests: createApplier,
};
