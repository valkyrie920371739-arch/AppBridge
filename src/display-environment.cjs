'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SETTINGS_KEY = 'HKCU\\Software\\Wine\\X11 Driver';
const BACKUP_KEY = 'HKCU\\Software\\Wine';
const TIMEOUT_MS = 20000;

function absolutePath(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) throw new Error(`${label}必须是明确的绝对路径。`);
  return path.resolve(value);
}

function ordinaryDirectory(directory, label) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label}必须是普通目录，不能是符号链接。`);
  return fs.realpathSync(directory);
}

function commandError(result) {
  const value = result?.error || result?.stderr || result?.stdout || '运行命令失败。';
  return (value instanceof Error ? value.message : String(value)).trim().slice(0, 2000);
}

function alreadyEnabled(result) {
  if (!result?.ok || typeof result.stdout !== 'string') return false;
  const lines = result.stdout.split(/\r?\n/);
  // Registry value/type names are invariant; do not inspect localized success
  // or error messages. Wine treats the initial Y, T or 1 as a true string.
  const values = lines.map((line) => /^\s*EmulateModeset[ \t]+REG_SZ[ \t]+([^\r\n]*)$/i.exec(line)).filter(Boolean);
  return values.length === 1 && /^[yt1]/i.test(values[0][1].trim());
}

function prepareBackupDirectory(saveDirectory) {
  const root = ordinaryDirectory(saveDirectory, '应用数据目录');
  const directory = path.join(root, 'display-backups');
  try { fs.mkdirSync(directory, { mode: 0o700 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (ordinaryDirectory(directory, '显示设置备份目录') !== directory) throw new Error('显示设置备份目录不能指向应用数据目录之外。');
  return directory;
}

function verifyBackup(backupPath) {
  const stat = fs.lstatSync(backupPath);
  if (!stat.isFile() || stat.isSymbolicLink() || !stat.size) throw new Error('运行环境没有生成有效的显示环境备份。');
  const bytes = fs.readFileSync(backupPath);
  const text = bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.subarray(2).toString('utf16le') : bytes.toString('utf8').replace(/^\uFEFF/, '');
  if (!/^(Windows Registry Editor Version 5\.00|REGEDIT4)(?:\r?\n|$)/.test(text) ||
      !/^\[HKEY_CURRENT_USER\\Software\\Wine(?:\\[^\]\r\n]+)?\][ \t]*\r?$/mi.test(text)) {
    throw new Error('显示环境备份格式无效，未修改设置。');
  }
  fs.chmodSync(backupPath, 0o600);
  return text;
}

// Call only before launching the game: changing this process-initialized Wine
// setting requires stopping and waiting for this private prefix's server.
async function prepareEmulatedDisplay({ runtimePath, prefixPath, saveDirectory, runCommand } = {}) {
  runtimePath = absolutePath(runtimePath, '运行环境路径');
  prefixPath = absolutePath(prefixPath, '软件运行目录');
  saveDirectory = absolutePath(saveDirectory, '应用数据目录');
  if (typeof runCommand !== 'function') throw new Error('缺少运行环境命令接口。');
  if (prefixPath === path.parse(prefixPath).root || saveDirectory === path.parse(saveDirectory).root) throw new Error('软件运行目录和应用数据目录不能是磁盘根目录。');
  ordinaryDirectory(prefixPath, '软件运行目录');
  ordinaryDirectory(saveDirectory, '应用数据目录');
  let zDrive;
  try { zDrive = fs.realpathSync(path.join(prefixPath, 'dosdevices', 'z:')); }
  catch { throw new Error('运行目录尚未建立可用的 Z: 文件映射，无法安全备份显示环境。'); }
  if (zDrive !== '/') throw new Error('运行目录的 Z: 映射不是本机根目录，无法安全备份显示环境。');

  const options = { prefixPath, timeoutMs: TIMEOUT_MS };
  const command = async (executable, args) => {
    try { return await runCommand(executable, args, options); }
    catch (error) { return { ok: false, error }; }
  };
  const queried = await command(runtimePath, ['reg', 'query', SETTINGS_KEY, '/v', 'EmulateModeset']);
  if (alreadyEnabled(queried)) return { configured: false, backupPath: null, restarted: false };

  const directory = prepareBackupDirectory(saveDirectory);
  const backupPath = path.join(directory, `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID()}-environment.reg`);
  const windowsBackupPath = `Z:${backupPath.replaceAll('/', '\\')}`;
  fs.closeSync(fs.openSync(backupPath, 'wx', 0o600));
  const fail = (message, extra = {}) => Object.assign(new Error(`${message}\n备份：${backupPath}`), { backupPath, configured: false, restarted: false, ...extra });

  const exported = await command(runtimePath, ['reg', 'export', BACKUP_KEY, windowsBackupPath, '/y']);
  if (!exported?.ok) throw fail(`无法备份现有显示环境，未修改设置。${commandError(exported)}`);
  let backupText;
  try { backupText = verifyBackup(backupPath); }
  catch (error) { throw fail(`无法确认显示环境备份，未修改设置。${error.message}`); }

  const restorePath = backupPath.replace(/\.reg$/, '.restore.reg');
  const windowsRestorePath = `Z:${restorePath.replaceAll('/', '\\')}`;
  const backupBody = backupText.replace(/^(Windows Registry Editor Version 5\.00|REGEDIT4)(?:\r?\n|$)/, '');
  try {
    // Import merges keys: explicitly remove the new value first, then restore
    // the original export, including its original value when one existed.
    const lines = ['Windows Registry Editor Version 5.00', '', '[HKEY_CURRENT_USER\\Software\\Wine\\X11 Driver]', '"EmulateModeset"=-', '', backupBody];
    fs.writeFileSync(restorePath, `\uFEFF${lines.join('\r\n')}`, { encoding: 'utf16le', mode: 0o600, flag: 'wx' });
  } catch (error) { throw fail(`无法保存显示环境恢复文件，未修改设置。${error.message}`); }
  const restoreFailure = async (message, configured) => {
    const rollback = await command(runtimePath, ['reg', 'import', windowsRestorePath]);
    const rollbackOk = Boolean(rollback?.ok);
    throw fail(`${message}${rollbackOk ? '已恢复原显示环境设置。' : `恢复备份也未成功：${commandError(rollback)}`}`, {
      configured: configured && !rollbackOk, restorePath, rollbackAttempted: true, rollbackOk,
      rollbackError: rollbackOk ? null : commandError(rollback),
    });
  };

  const applied = await command(runtimePath, ['reg', 'add', SETTINGS_KEY, '/v', 'EmulateModeset', '/t', 'REG_SZ', '/d', 'Y', '/f']);
  if (!applied?.ok) await restoreFailure(`无法启用兼容分辨率。${commandError(applied)}`, false);

  const wineserverPath = path.join(path.dirname(runtimePath), 'wineserver');
  const stopped = await command(wineserverPath, ['-k']);
  // Wine returns 1 when there was no server to stop. Confirm with -w rather
  // than treating that empty, non-timeout result as an application failure.
  const noServer = stopped?.exitCode === 1 && !stopped.timedOut && !stopped.signal && !String(stopped.stderr || '').trim() && !String(stopped.stdout || '').trim();
  if (!stopped?.ok && !noServer) await restoreFailure(`无法停止旧运行环境。${commandError(stopped)}`, true);
  const waited = await command(wineserverPath, ['-w']);
  if (!waited?.ok) await restoreFailure(`无法确认旧运行环境已经结束。${commandError(waited)}`, true);
  return { configured: true, backupPath, restarted: true };
}

module.exports = { prepareEmulatedDisplay };
