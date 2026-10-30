'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { probeRuntime, discoverRuntime, runtimeSelfTest, inspectWindowsExecutable, launchWindowsExecutable } = require('../src/wine-runtime.cjs');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'appbridge wine test '));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function script(filename, source) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, `#!${process.execPath}\n'use strict';\n${source}\n`, { mode: 0o755 });
  return filename;
}

function executable(directory, machine, characteristics = 0x0002) {
  const filename = path.join(directory, `application ${machine}.exe`);
  const header = Buffer.alloc(128);
  header.writeUInt16LE(0x5a4d, 0);
  header.writeUInt32LE(0x40, 0x3c);
  header.writeUInt32LE(0x00004550, 0x40);
  header.writeUInt16LE(machine, 0x44);
  header.writeUInt16LE(characteristics, 0x56);
  fs.writeFileSync(filename, header);
  return filename;
}

test('version probe accepts Wine versions and rejects unrelated successful executables', async (t) => {
  const directory = fixture(t);
  const valid = script(path.join(directory, 'wine'), 'console.log("wine-11.0 (Test Build)");');
  const invalid = script(path.join(directory, 'unrelated'), 'console.log("version 11.0");');
  const multiline = script(path.join(directory, 'multiple lines'), 'console.log("wine-11.0\\nother program");');
  const result = await probeRuntime(valid, { platform: 'darwin' });
  assert.equal(result.ok, true);
  assert.equal(result.version, 'wine-11.0 (Test Build)');
  assert.equal((await probeRuntime(invalid, { platform: 'darwin' })).ok, false);
  assert.equal((await probeRuntime(multiline, { platform: 'darwin' })).ok, false);
  assert.equal((await probeRuntime(valid, { platform: 'win32' })).ok, false);
});

test('probe bounds output and cancels a hung process', async (t) => {
  const directory = fixture(t);
  const noisy = script(path.join(directory, 'noisy'), 'process.stdout.write("x".repeat(100000)); process.stderr.write("y".repeat(100000));');
  const result = await probeRuntime(noisy, { platform: 'darwin' });
  assert.equal(result.ok, false);
  assert.equal(result.outputTruncated, true);
  assert.equal(result.stdout.length, 65536);
  assert.equal(result.stderr.length, 65536);
  const hung = script(path.join(directory, 'hung'), 'setInterval(() => {}, 10000);');
  const start = Date.now();
  const timeout = await probeRuntime(hung, { platform: 'darwin', timeoutMs: 100 });
  assert.equal(timeout.ok, false);
  assert.equal(timeout.timedOut, true);
  assert.ok(Date.now() - start < 3000, 'timed out process must not keep the probe pending');
});

test('discovery verifies each fixed candidate and prioritizes a valid bundled runtime', async (t) => {
  const directory = fixture(t);
  const bundledRoot = path.join(directory, 'runtime');
  const homeDirectory = path.join(directory, 'home');
  const suffix = ['Wine Stable.app', 'Contents', 'Resources', 'wine', 'bin', 'wine'];
  const bundled = script(path.join(bundledRoot, ...suffix), 'console.log("wine-11.0");');
  const user = script(path.join(homeDirectory, 'Applications', ...suffix), 'console.log("wine-10.0");');
  assert.deepEqual(await discoverRuntime({ bundledRoot, homeDirectory, platform: 'darwin' }), {
    executablePath: bundled, version: 'wine-11.0', source: 'bundled',
  });
  script(bundled, 'console.log("not Wine");');
  assert.deepEqual(await discoverRuntime({ bundledRoot, homeDirectory, platform: 'darwin' }), {
    executablePath: user, version: 'wine-10.0', source: 'user',
  });
  const stagingRoot = path.join(directory, 'staging runtime');
  const staging = script(path.join(stagingRoot, 'Wine Staging.app', 'Contents', 'Resources', 'wine', 'bin', 'wine'), 'console.log("wine-11.20(Staging)");');
  assert.deepEqual(await discoverRuntime({ bundledRoot: stagingRoot, homeDirectory, platform: 'darwin' }), {
    executablePath: staging, version: 'wine-11.20(Staging)', source: 'bundled',
  });
  assert.equal(await discoverRuntime({ bundledRoot, homeDirectory, platform: 'linux' }), null);
});

test('Windows command self-test passes a separate prefix and requires the exact marker', async (t) => {
  const directory = fixture(t);
  const runtimePath = script(path.join(directory, 'wine'), `
    const fs = require('node:fs');
    const path = require('node:path');
    if (process.argv[2] === '--version') console.log('wine-11.0');
    else {
      fs.writeFileSync(path.join(process.env.WINEPREFIX, 'invocation.json'), JSON.stringify({args: process.argv.slice(2), searchPath: process.env.PATH}));
      console.log('AppBridge runtime OK');
    }
  `);
  const prefixPath = path.join(directory, 'diagnostic prefix');
  const result = await runtimeSelfTest({ runtimePath, prefixPath, platform: 'darwin' });
  assert.equal(result.ok, true);
  const invocation = JSON.parse(fs.readFileSync(path.join(prefixPath, 'invocation.json'), 'utf8'));
  assert.deepEqual(invocation.args, ['cmd', '/d', '/c', 'echo AppBridge runtime OK']);
  assert.equal(invocation.searchPath.split(path.delimiter)[0], directory);
  script(runtimePath, `console.log(process.argv[2] === '--version' ? 'wine-11.0' : 'unexpected output');`);
  assert.equal((await runtimeSelfTest({ runtimePath, prefixPath, platform: 'darwin' })).ok, false);
});

test('PE inspection identifies DLLs and rejects malformed headers', (t) => {
  const directory = fixture(t);
  assert.equal(inspectWindowsExecutable(executable(directory, 0x8664)).architecture, 'x64');
  assert.equal(inspectWindowsExecutable(executable(directory, 0x014c, 0x2002)).isDll, true);
  const invalid = path.join(directory, 'invalid.exe');
  fs.writeFileSync(invalid, Buffer.alloc(64));
  assert.throws(() => inspectWindowsExecutable(invalid), /MZ/);
  const outOfRange = fs.readFileSync(executable(directory, 0x8664));
  outOfRange.writeUInt32LE(0x7fffffff, 0x3c);
  fs.writeFileSync(invalid, outOfRange);
  assert.throws(() => inspectWindowsExecutable(invalid), /偏移/);
});

test('launcher blocks ARM and DLL inputs before creating a prefix', (t) => {
  const directory = fixture(t);
  const runtimePath = script(path.join(directory, 'wine'), 'process.exit(0);');
  const prefixPath = path.join(directory, 'prefix');
  const options = { runtimePath, prefixPath, platform: 'darwin' };
  assert.throws(() => launchWindowsExecutable({ ...options, exePath: executable(directory, 0xaa64) }), /ARM64/);
  assert.throws(() => launchWindowsExecutable({ ...options, exePath: executable(directory, 0x014c, 0x2002) }), /DLL/);
  assert.equal(fs.existsSync(prefixPath), false);
});

test('launcher preserves the literal EXE argument, working directory, and per-app prefix', async (t) => {
  const directory = fixture(t);
  const runtimePath = script(path.join(directory, 'wine'), `console.log(JSON.stringify({args: process.argv.slice(2), cwd: process.cwd(), prefix: process.env.WINEPREFIX}));`);
  const input = executable(directory, 0x8664);
  const exePath = path.join(directory, 'app $literal & spaces.exe');
  fs.renameSync(input, exePath);
  const prefixPath = path.join(directory, 'app prefix');
  const launchArguments = ['-force-d3d11', '-logFile', path.join(directory, 'unity player.log')];
  let stdout = '';
  const details = await new Promise((resolve) => {
    launchWindowsExecutable({ runtimePath, exePath, prefixPath, launchArguments, platform: 'darwin',
      onOutput: (output) => { if (output.stream === 'stdout') stdout += output.text; },
      onExit: resolve,
    });
  });
  assert.equal(details.ok, true);
  assert.deepEqual(JSON.parse(stdout), { args: [exePath, ...launchArguments], cwd: fs.realpathSync(directory), prefix: prefixPath });
  assert.throws(() => launchWindowsExecutable({ runtimePath, exePath, prefixPath, launchArguments: [12], platform: 'darwin' }), /字符串列表/);
});

test('game exit is reported while a background service still holds its log pipes', async (t) => {
  const directory = fixture(t);
  const runtimePath = script(path.join(directory, 'wine'), `
    const {spawn} = require('node:child_process');
    const service = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], {stdio: ['ignore', 1, 2]});
    console.log(service.pid);
    process.exit(0);
  `);
  let output = '';
  let exits = 0;
  const started = Date.now();
  const details = await new Promise((resolve) => {
    launchWindowsExecutable({ runtimePath, exePath: executable(directory, 0x8664),
      prefixPath: path.join(directory, 'prefix'), platform: 'darwin',
      onOutput: (entry) => { if (entry.stream === 'stdout') output += entry.text; },
      onExit: (entry) => { exits++; resolve(entry); },
    });
  });
  const servicePid = Number(output.trim());
  t.after(() => { if (servicePid) { try { process.kill(servicePid); } catch {} } });
  assert.equal(details.ok, true);
  assert.ok(Date.now() - started < 3000, 'background service must not keep the library marked as running');
  assert.ok(servicePid > 0);
  assert.equal(exits, 1);
});
