'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const OUTPUT_LIMIT = 1024 * 1024;
const KINDS = new Set(['server', 'service', 'application', 'unknown']);
const SERVICES = new Set(['services.exe', 'explorer.exe', 'winedevice.exe', 'svchost.exe', 'plugplay.exe', 'rpcss.exe']);

function absolute(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) throw new Error(`${label}必须是明确的绝对路径。`);
  return path.resolve(value);
}
function defaultRunner(executable, args, options) {
  return new Promise((resolve, reject) => {
    execFile(executable, args, { ...options, encoding: 'utf8', shell: false }, (error, stdout, stderr) => {
      if (error) {
        const failure = new Error('无法确认运行环境进程状态。请关闭相关应用后重试。', { cause: error });
        failure.code = error.code; failure.signal = error.signal;
        reject(failure);
      } else resolve({ stdout, stderr, exitCode: 0 });
    });
  });
}

// A successful empty array means no matching process was observed. Any unknown
// result is deliberately blocking, even if its prefix could not be determined.
// Callers must refuse migration for application OR unknown, then scan again
// after stopping idle services and before copying the prefix.
async function scanRuntimeProcesses({ helperPath, prefixPath, execRunner = defaultRunner, platform = process.platform } = {}) {
  if (platform !== 'darwin') throw new Error('运行环境进程检查需要在 Mac 上执行。');
  helperPath = absolute(helperPath, '进程检查组件路径');
  prefixPath = absolute(prefixPath, '软件运行目录');
  const helper = fs.lstatSync(helperPath);
  if (!helper.isFile() || helper.isSymbolicLink()) throw new Error('进程检查组件必须是普通可执行文件。');
  fs.accessSync(helperPath, fs.constants.R_OK | fs.constants.X_OK);
  const prefix = fs.statSync(prefixPath);
  if (!prefix.isDirectory()) throw new Error('软件运行目录必须是已有文件夹。');
  prefixPath = fs.realpathSync(prefixPath);
  if (prefixPath === path.parse(prefixPath).root) throw new Error('软件运行目录不能是磁盘根目录。');
  if (typeof execRunner !== 'function') throw new Error('缺少进程检查命令接口。');
  const result = await execRunner(helperPath, ['--prefix', prefixPath], { timeout: 10000, maxBuffer: OUTPUT_LIMIT, windowsHide: true });
  if (!result || result.exitCode !== 0 || result.signal || result.timedOut || result.error || result.outputTruncated ||
      typeof result.stdout !== 'string' || result.stdout.length > OUTPUT_LIMIT || String(result.stderr || '').trim()) {
    throw new Error('无法可靠确认运行环境进程状态，已停止后续文件操作。');
  }
  let values;
  try { values = JSON.parse(result.stdout); }
  catch { throw new Error('进程检查结果格式无效，已停止后续文件操作。'); }
  if (!Array.isArray(values) || values.length > 512) throw new Error('进程检查结果超出允许范围。');
  const seen = new Set();
  return values.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).some((key) => !['pid', 'name', 'kind'].includes(key)) ||
        !Number.isInteger(value.pid) || value.pid < 1 || value.pid > 0x7fffffff || seen.has(value.pid) ||
        typeof value.name !== 'string' || !value.name || value.name.length > 255 || /[\0-\x1f\x7f/\\]/.test(value.name) ||
        !KINDS.has(value.kind)) throw new Error('进程检查返回了无效的项目，已停止后续文件操作。');
    if ((value.kind === 'server' && value.name.toLowerCase() !== 'wineserver') ||
        (value.kind === 'service' && !SERVICES.has(value.name.toLowerCase()))) {
      throw new Error('进程检查的服务分类无效，已停止后续文件操作。');
    }
    seen.add(value.pid);
    return { pid: value.pid, name: value.name, kind: value.kind };
  });
}

module.exports = { scanRuntimeProcesses };
