'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const OUTPUT_LIMIT = 64 * 1024;
const SELF_TEST_MARKER = 'AppBridge runtime OK';

// Microsoft PE/COFF format: e_lfanew at 0x3c; COFF Machine immediately after
// PE\0\0; COFF Characteristics at offset 18. These describe the input file,
// not its compatibility with the selected Wine build.
// https://learn.microsoft.com/en-us/windows/win32/debug/pe-format
const MACHINES = new Map([
  [0x014c, { machineName: 'IMAGE_FILE_MACHINE_I386', architecture: 'x86' }],
  [0x8664, { machineName: 'IMAGE_FILE_MACHINE_AMD64', architecture: 'x64' }],
  [0xaa64, { machineName: 'IMAGE_FILE_MACHINE_ARM64', architecture: 'ARM64' }],
  [0xa641, { machineName: 'IMAGE_FILE_MACHINE_ARM64EC', architecture: 'ARM64EC' }],
  [0xa64e, { machineName: 'IMAGE_FILE_MACHINE_ARM64X', architecture: 'ARM64X' }],
]);

function absolutePath(value, label) {
  if (typeof value !== 'string' || value.length === 0 || !path.isAbsolute(value)) {
    throw new Error(label + '必须是明确的绝对路径。');
  }
  return value;
}

function fileAt(value, label, executable = false) {
  absolutePath(value, label);
  if (!fs.statSync(value).isFile()) throw new Error(label + '不是文件。');
  fs.accessSync(value, executable ? fs.constants.R_OK | fs.constants.X_OK : fs.constants.R_OK);
  return value;
}

function errorText(error) {
  return error && typeof error.message === 'string' ? error.message : String(error);
}

function readExactly(fd, size, position) {
  const buffer = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const count = fs.readSync(fd, buffer, offset, size - offset, position + offset);
    if (count === 0) throw new Error('可执行文件头不完整。');
    offset += count;
  }
  return buffer;
}

function inspectWindowsExecutable(exePath) {
  fileAt(exePath, 'Windows 程序路径');
  const fd = fs.openSync(exePath, 'r');
  try {
    const sizeBytes = fs.fstatSync(fd).size;
    if (sizeBytes < 64) throw new Error('文件太短，无法包含完整的 DOS 文件头。');
    const dos = readExactly(fd, 64, 0);
    if (dos.readUInt16LE(0) !== 0x5a4d) throw new Error('文件没有 MZ 标识，不是此版本支持的 Windows PE 程序。');
    const peOffset = dos.readUInt32LE(0x3c);
    if (peOffset > sizeBytes - 24) throw new Error('PE 文件头偏移超出文件范围。');
    const pe = readExactly(fd, 24, peOffset);
    if (pe.readUInt32LE(0) !== 0x00004550) throw new Error('文件没有 PE\\0\\0 标识，不是此版本支持的 Windows PE 程序。');
    const machine = pe.readUInt16LE(4);
    const characteristics = pe.readUInt16LE(22);
    const description = MACHINES.get(machine);
    return {
      exePath,
      format: 'PE',
      sizeBytes,
      peOffset,
      machine,
      machineHex: '0x' + machine.toString(16).padStart(4, '0'),
      machineName: description ? description.machineName : null,
      architecture: description ? description.architecture : null,
      characteristics,
      isDll: Boolean(characteristics & 0x2000),
    };
  } finally {
    fs.closeSync(fd);
  }
}

// Finder does not inherit a terminal's PATH. Wine's helper programs live next
// to the selected loader; include that directory without invoking a shell.
function runtimeEnvironment(executablePath, prefixPath) {
  const libraryDirectory = path.resolve(path.dirname(fs.realpathSync(executablePath)), '..', 'lib');
  const directories = [path.dirname(executablePath), path.dirname(fs.realpathSync(executablePath)), ...(process.env.PATH || '').split(path.delimiter),
    '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  const managed = {};
  if (prefixPath) {
    const directory = path.dirname(prefixPath);
    const home = path.join(directory, 'home');
    const cache = path.join(directory, 'cache');
    const temporary = path.join(cache, 'temporary');
    const shaders = path.join(cache, 'dxmt');
    const logs = path.join(directory, 'logs');
    const userFolders = ['Desktop', 'Documents', 'Downloads', 'Music', 'Pictures', 'Movies', 'Videos'].map((name) => path.join(home, name));
    for (const folder of [home, cache, temporary, shaders, logs, ...userFolders]) fs.mkdirSync(folder, { recursive: true });
    Object.assign(managed, { HOME: home, XDG_CACHE_HOME: cache, TMPDIR: temporary, DXMT_SHADER_CACHE_PATH: shaders, DXMT_LOG_PATH: logs });
  }
  return {
    ...process.env,
    PATH: [...new Set(directories.filter(Boolean))].join(path.delimiter),
    WINEDEBUG: process.env.WINEDEBUG || '-all,err+all',
    MVK_CONFIG_LOG_LEVEL: process.env.MVK_CONFIG_LOG_LEVEL || '1',
    DYLD_LIBRARY_PATH: [libraryDirectory, process.env.DYLD_LIBRARY_PATH].filter(Boolean).join(':'),
    DYLD_FALLBACK_LIBRARY_PATH: [libraryDirectory, process.env.DYLD_FALLBACK_LIBRARY_PATH, '/usr/lib'].filter(Boolean).join(':'),
    ...(prefixPath ? { WINEPREFIX: prefixPath } : {}),
    ...managed,
  };
}

function runRuntime(executablePath, args, { platform, timeoutMs, prefixPath }) {
  const base = {
    ok: false, platform, executablePath,
    stdout: '', stderr: '', exitCode: null, signal: null, timedOut: false, error: null,
    outputTruncated: false,
  };
  if (platform !== 'darwin') {
    return Promise.resolve({ ...base, error: '运行环境检测需要在 Mac 上进行；当前系统不是 macOS。' });
  }
  try { fileAt(executablePath, '运行环境路径', true); }
  catch (error) { return Promise.resolve({ ...base, error: errorText(error) }); }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('检测时限必须为正数。');

  return new Promise((resolve) => {
    let child;
    let timer;
    let killTimer;
    let finished = false;
    const result = { ...base };
    function finish() {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve({ ...result });
    }
    function capture(stream, text) {
      if (finished) return;
      const remaining = OUTPUT_LIMIT - result[stream].length;
      result[stream] += text.slice(0, Math.max(0, remaining));
      if (text.length > remaining) result.outputTruncated = true;
    }
    try {
      child = spawn(executablePath, args, {
        shell: false,
        detached: true,
        env: runtimeEnvironment(executablePath, prefixPath),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.once('error', (error) => { result.error = errorText(error); finish(); });
      child.once('close', (exitCode, signal) => {
        result.exitCode = exitCode;
        result.signal = signal;
        result.ok = exitCode === 0 && !result.error && !result.timedOut;
        if (!result.ok && !result.error) result.error = '运行环境检测未正常退出。';
        finish();
      });
      if (child.stdout) {
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (text) => capture('stdout', text));
      }
      if (child.stderr) {
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (text) => capture('stderr', text));
      }
      timer = setTimeout(() => {
        result.timedOut = true;
        result.error = `运行环境检测超过 ${Math.ceil(timeoutMs / 1000)} 秒，已取消检测。`;
        // A wrapper can leave descendants holding the output pipes open. Each
        // probe has its own process group, so cancelling it cannot kill a game.
        try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); }
        catch { child.kill('SIGKILL'); }
        child.stdout?.destroy();
        child.stderr?.destroy();
        // Usually close fires immediately; retain a bound even after OS errors.
        killTimer = setTimeout(finish, 1000);
      }, timeoutMs);
    } catch (error) {
      result.error = errorText(error);
      finish();
    }
  });
}

async function probeRuntime(executablePath, { platform = process.platform, timeoutMs = 10000 } = {}) {
  const result = await runRuntime(executablePath, ['--version'], { platform, timeoutMs });
  const version = result.stdout.trim();
  // A successful /bin/echo or unrelated executable is not a Wine runtime.
  if (result.ok && !/^wine-\d+(?:\.\d+)*(?:[-.~][\w.+-]+)?(?:[ \t]*\([^\r\n]*\))?$/i.test(version)) {
    result.ok = false;
    result.error = '所选文件没有返回可识别的 Wine 版本，请选择 Wine 运行文件。';
  }
  return { ...result, version: result.ok ? version : null };
}

async function discoverRuntime({ bundledRoot, homeDirectory = os.homedir(), platform = process.platform, timeoutMs = 10000 } = {}) {
  if (platform !== 'darwin') return null;
  const candidates = [];
  function addApp(root, source) {
    for (const appName of ['Wine Stable.app', 'Wine Staging.app', 'Wine Development.app']) {
      for (const filename of ['wine', 'wine64']) {
        candidates.push({ executablePath: path.join(root, appName, 'Contents', 'Resources', 'wine', 'bin', filename), source });
      }
    }
  }
  if (bundledRoot) {
    absolutePath(bundledRoot, '内置运行环境目录');
    candidates.push({ executablePath: path.join(bundledRoot, 'AppBridgeWine.app', 'Contents', 'MacOS', 'wine'), source: 'bundled' });
    addApp(bundledRoot, 'bundled');
  }
  addApp(path.join(absolutePath(homeDirectory, '用户目录'), 'Applications'), 'user');
  addApp('/Applications', 'system');
  for (const executablePath of ['/opt/homebrew/bin/wine', '/opt/homebrew/bin/wine64', '/usr/local/bin/wine', '/usr/local/bin/wine64']) {
    candidates.push({ executablePath, source: 'homebrew' });
  }
  const visited = new Set();
  for (const candidate of candidates) {
    let realPath;
    try { realPath = fs.realpathSync(candidate.executablePath); }
    catch { continue; }
    if (visited.has(realPath)) continue;
    visited.add(realPath);
    const probe = await probeRuntime(candidate.executablePath, { platform, timeoutMs });
    if (probe.ok) return { ...candidate, version: probe.version };
  }
  return null;
}

async function runtimeSelfTest({ runtimePath, prefixPath, platform = process.platform, timeoutMs = 90000 }) {
  const probe = await probeRuntime(runtimePath, { platform });
  if (!probe.ok) return { ...probe, prefixPath };
  try {
    // The caller supplies a dedicated diagnostic prefix, never an app prefix.
    absolutePath(prefixPath, '自检运行目录');
    fs.mkdirSync(prefixPath, { recursive: true });
  } catch (error) { return { ...probe, ok: false, prefixPath, error: errorText(error) }; }
  const result = await runRuntime(runtimePath, ['cmd', '/d', '/c', `echo ${SELF_TEST_MARKER}`], { platform, timeoutMs, prefixPath });
  if (result.ok && !result.stdout.split(/\r?\n/).some((line) => line.trim() === SELF_TEST_MARKER)) {
    result.ok = false;
    result.error = 'Windows 命令自检没有返回预期结果，请查看诊断日志。';
  }
  return { ...result, version: probe.version, prefixPath };
}

function launchWindowsExecutable({ runtimePath, exePath, prefixPath, workingDirectory, launchArguments = [], displayHelperPath, displayOptions, onOutput, onExit, platform = process.platform }) {
  if (platform !== 'darwin') {
    throw new Error('Windows 程序兼容启动需要在 Mac 上进行；当前系统不是 macOS。');
  }
  fileAt(runtimePath, '运行环境路径', true);
  const executable = inspectWindowsExecutable(exePath);
  if (executable.isDll) throw new Error('所选文件的 PE 文件头标记为 DLL，不能作为独立程序启动。');
  if (!['x86', 'x64'].includes(executable.architecture)) {
    throw new Error(`当前 Wine 路线支持 x86 与 x64 程序，不能启动 ${executable.architecture || executable.machineHex} 程序。`);
  }
  if (!Array.isArray(launchArguments) || launchArguments.some((argument) => typeof argument !== 'string' || argument.includes('\0'))) {
    throw new Error('启动参数必须是字符串列表，且不能包含空字符。');
  }
  absolutePath(prefixPath, '软件运行数据目录');
  const cwd = workingDirectory === undefined ? path.dirname(exePath) : absolutePath(workingDirectory, '工作目录');
  if (!fs.statSync(cwd).isDirectory()) throw new Error('工作目录不是文件夹。');
  fs.mkdirSync(prefixPath, { recursive: true });

  // Wine's documented contract is wine program [arguments] and WINEPREFIX.
  // Arguments stay separate and literal, including paths containing spaces.
  const environment = runtimeEnvironment(runtimePath, prefixPath);
  if (displayHelperPath && displayOptions) {
    fileAt(displayHelperPath, '显示辅助组件');
    environment.DYLD_INSERT_LIBRARIES = [displayHelperPath, environment.DYLD_INSERT_LIBRARIES].filter(Boolean).join(':');
    environment.APPBRIDGE_GAME_EXE = exePath;
    environment.APPBRIDGE_DISPLAY_MODE = displayOptions.mode;
    environment.APPBRIDGE_HIDE_DOCK = displayOptions.hideDock ? '1' : '0';
    environment.APPBRIDGE_WINDOW_WIDTH = String(displayOptions.width);
    environment.APPBRIDGE_WINDOW_HEIGHT = String(displayOptions.height);
  }
  const child = spawn(runtimePath, [exePath, ...launchArguments], {
    shell: false,
    cwd,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let finished = false;
  let processError = null;
  function output(stream, text) {
    if (typeof onOutput === 'function') onOutput({ stream, text: String(text) });
  }
  function finish(exitCode, signal) {
    if (finished) return;
    finished = true;
    if (typeof onExit === 'function') {
      onExit({
        ok: exitCode === 0 && !processError,
        exitCode,
        signal,
        error: processError,
        platform,
      });
    }
  }
  child.once('error', (error) => {
    processError = errorText(error);
    output('error', processError);
    finish(null, null);
  });
  // Wine services may inherit the log pipes after the game process exits.
  // Report the process exit immediately; keep collecting any remaining logs.
  child.once('exit', (exitCode, signal) => finish(exitCode, signal));
  child.once('close', (exitCode, signal) => finish(exitCode, signal));
  if (child.stdout) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (text) => output('stdout', text));
  }
  if (child.stderr) {
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (text) => output('stderr', text));
  }
  return child;
}

function runRuntimeCommand(executablePath, args, { prefixPath, timeoutMs = 20000, platform = process.platform } = {}) {
  absolutePath(prefixPath, '应用运行目录');
  if (!Array.isArray(args) || args.some((argument) => typeof argument !== 'string' || argument.includes('\0'))) throw new Error('运行参数必须是明确的字符串列表。');
  return runRuntime(executablePath, args, { platform, timeoutMs, prefixPath });
}

module.exports = { probeRuntime, inspectWindowsExecutable, launchWindowsExecutable, discoverRuntime, runtimeSelfTest, runRuntimeCommand };
