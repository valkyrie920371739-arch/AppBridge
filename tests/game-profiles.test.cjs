'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { applyGameDisplayProfile, buildDisplayValues, __createGameDisplayProfilerForTests } = require('../src/game-profiles.cjs');

const KEY = 'HKCU\\Software\\Alan.Maiyer\\Re:Sister';
const fixtureBytes = Buffer.from('AppBridge offline display-profile fixture\n');
const fixtureHash = crypto.createHash('sha256').update(fixtureBytes).digest('hex');

function fixture(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'appbridge-profile-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const exePath = path.join(directory, 'Game folder with spaces', 'fixture.exe');
  fs.mkdirSync(path.dirname(exePath)); fs.writeFileSync(exePath, fixtureBytes);
  const prefixPath = path.join(directory, 'prefix');
  fs.mkdirSync(path.join(prefixPath, 'dosdevices'), { recursive: true });
  fs.symlinkSync('/', path.join(prefixPath, 'dosdevices', 'z:'));
  const saveDirectory = path.join(directory, 'Application data'); fs.mkdirSync(saveDirectory);
  const calls = [];
  const options = { exePath, prefixPath, saveDirectory, runtimePath: path.join(directory, 'Wine runtime', 'wine'), display: { mode: 'windowed', width: 1280, height: 720 } };
  const runCommand = async (runtimePath, args, commandOptions) => {
    calls.push({ runtimePath, args, options: commandOptions });
    if (args[1] === 'export') {
      const backup = args[3].slice(2).replaceAll('\\', '/');
      fs.writeFileSync(backup, '\uFEFFWindows Registry Editor Version 5.00\r\n\r\n[HKEY_CURRENT_USER\\Software\\Alan.Maiyer\\Re:Sister]\r\n"fullscreen_h1476830426"=dword:00000001\r\n', 'utf16le');
    }
    return { ok: true, stdout: '', stderr: '' };
  };
  const apply = __createGameDisplayProfilerForTests(new Map([[fixtureHash, { name: 'Offline ReSister profile' }]]));
  return { directory, options: { ...options, runCommand }, calls, runCommand, apply };
}

test('default profiler never changes an unknown executable, even with caller-supplied profile fields', async (t) => {
  const f = fixture(t);
  const result = await applyGameDisplayProfile({ ...f.options, profiles: new Map([[fixtureHash, { name: 'spoofed' }]]), sha256: 'c84fdc125d469680fa25b9eb0ce204d63ae7bcc3ad8852bda95880ce558adba6' });
  assert.equal(result.applied, false); assert.equal(f.calls.length, 0);
  assert.equal(fs.existsSync(path.join(f.options.saveDirectory, 'display-backups')), false);
});

test('follow-game mode does not hash a missing entry or invoke Wine', async (t) => {
  const f = fixture(t);
  const result = await f.apply({ ...f.options, exePath: path.join(f.directory, 'missing.exe'), display: { mode: 'app', width: 1280, height: 720 } });
  assert.equal(result.applied, false); assert.equal(f.calls.length, 0);
});

test('known profile uses two Wine calls and imports one UTF16LE file with six fixed DWORD values', async (t) => {
  const f = fixture(t); const result = await f.apply(f.options);
  assert.equal(result.applied, true); assert.equal(result.profile, 'Offline ReSister profile');
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[0].args.slice(0, 3), ['reg', 'export', KEY]);
  assert.equal(f.calls[0].args[3], `Z:${result.backupPath.replaceAll('/', '\\')}`);
  assert.equal(f.calls[0].args[4], '/y');
  assert.equal(path.dirname(result.backupPath), path.join(f.options.saveDirectory, 'display-backups'));
  assert.ok(fs.statSync(result.backupPath).size > 0);
  for (const call of f.calls) {
    assert.equal(call.runtimePath, f.options.runtimePath);
    assert.deepEqual(call.options, { prefixPath: f.options.prefixPath, timeoutMs: 20000 });
  }
  assert.deepEqual(f.calls[1].args, ['reg', 'import', `Z:${result.applyFile.replaceAll('/', '\\')}`]);
  assert.equal(path.dirname(result.applyFile), path.dirname(result.backupPath));
  const appliedBytes = fs.readFileSync(result.applyFile);
  assert.deepEqual([...appliedBytes.subarray(0, 2)], [0xff, 0xfe]);
  assert.equal(appliedBytes.toString('utf16le'), '\uFEFFWindows Registry Editor Version 5.00\r\n\r\n[HKEY_CURRENT_USER\\Software\\Alan.Maiyer\\Re:Sister]\r\n' +
    '"fullscreen_h1476830426"=dword:00000000\r\n' +
    '"Screenmanager Fullscreen mode_h3630240806"=dword:00000003\r\n' +
    '"Screenmanager Resolution Width_h182942802"=dword:00000500\r\n' +
    '"Screenmanager Resolution Height_h2627697771"=dword:000002d0\r\n' +
    '"Screenmanager Resolution Window Width_h2524650974"=dword:00000500\r\n' +
    '"Screenmanager Resolution Window Height_h1684712807"=dword:000002d0\r\n\r\n');
  assert.equal(fs.statSync(result.applyFile).mode & 0o777, 0o600);
  assert.equal(result.values['Screenmanager Fullscreen mode_h3630240806'], 3);
  assert.equal(result.values['Screenmanager Resolution Window Width_h2524650974'], 1280);
  assert.equal(result.values['Screenmanager Resolution Window Height_h1684712807'], 720);
  const second = await f.apply(f.options);
  assert.notEqual(second.backupPath, result.backupPath); assert.notEqual(second.applyFile, result.applyFile);
  assert.equal(f.calls.length, 4);
});

test('fullscreen values preserve requested dimensions and use fullscreen-window mode', () => {
  assert.deepEqual(buildDisplayValues({ mode: 'fullscreen', width: 1440, height: 900 }), {
    fullscreen_h1476830426: 1,
    'Screenmanager Fullscreen mode_h3630240806': 1,
    'Screenmanager Resolution Width_h182942802': 1440,
    'Screenmanager Resolution Height_h2627697771': 900,
    'Screenmanager Resolution Window Width_h2524650974': 1440,
    'Screenmanager Resolution Window Height_h1684712807': 900,
  });
});

test('backup failure or a missing backup aborts before the first registry write', async (t) => {
  const f = fixture(t);
  await assert.rejects(f.apply({ ...f.options, runCommand: async (...args) => { f.calls.push(args); return { ok: false, stderr: 'key does not exist' }; } }), /未修改任何设置/);
  assert.equal(f.calls.length, 1);
  await assert.rejects(f.apply({ ...f.options, runCommand: async () => ({ ok: true }) }), /未修改游戏设置/);
});

test('a failed application import imports the original backup and reports rollback success', async (t) => {
  const f = fixture(t);
  await assert.rejects(f.apply({ ...f.options, runCommand: async (...args) => {
    const result = await f.runCommand(...args);
    if (args[1][1] === 'import' && args[1][2].endsWith('.apply.reg')) return { ok: false, stderr: 'write denied' };
    return result;
  } }), (error) => {
    assert.equal(error.rollbackAttempted, true); assert.equal(error.rollbackOk, true);
    assert.match(error.message, /write denied/);
    assert.deepEqual(f.calls.at(-1).args, ['reg', 'import', `Z:${error.backupPath.replaceAll('/', '\\')}`]);
    assert.equal(f.calls.length, 3); assert.ok(fs.existsSync(error.applyFile));
    return true;
  });
});

test('a thrown application import and failed rollback preserve both files and report both errors', async (t) => {
  const f = fixture(t);
  await assert.rejects(f.apply({ ...f.options, runCommand: async (...args) => {
    if (args[1][1] === 'export') return f.runCommand(...args);
    f.calls.push({ args: args[1] });
    if (args[1][1] === 'import' && args[1][2].endsWith('.apply.reg')) throw new Error('spawn failed');
    return { ok: false, error: 'restore failed' };
  } }), (error) => {
    assert.equal(error.rollbackOk, false); assert.equal(error.rollbackError, 'restore failed');
    assert.match(error.message, /spawn failed/); assert.match(error.message, /restore failed/);
    assert.ok(fs.existsSync(error.backupPath)); assert.ok(fs.existsSync(error.applyFile)); return true;
  });
});

test('invalid paths, dimensions, backup symlinks and non-root Z drives never run commands', async (t) => {
  const f = fixture(t);
  for (const patch of [{ exePath: 'relative.exe' }, { runtimePath: 'wine' }, { prefixPath: 'prefix' }, { saveDirectory: 'data' }, { display: { mode: 'windowed', width: 639, height: 720 } }, { display: { mode: 'windowed', width: 1280.5, height: 720 } }]) {
    await assert.rejects(f.apply({ ...f.options, ...patch }));
  }
  fs.symlinkSync(f.directory, path.join(f.options.saveDirectory, 'display-backups'));
  await assert.rejects(f.apply(f.options), /备份目录必须是普通目录/); assert.equal(f.calls.length, 0);
  fs.unlinkSync(path.join(f.options.saveDirectory, 'display-backups'));
  fs.unlinkSync(path.join(f.options.prefixPath, 'dosdevices', 'z:'));
  fs.symlinkSync(f.directory, path.join(f.options.prefixPath, 'dosdevices', 'z:'));
  await assert.rejects(f.apply(f.options), /Z: 映射不是本机根目录/); assert.equal(f.calls.length, 0);
});
