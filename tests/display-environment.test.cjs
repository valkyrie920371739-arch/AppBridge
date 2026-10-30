'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { prepareEmulatedDisplay } = require('../src/display-environment.cjs');

const KEY = 'HKCU\\Software\\Wine\\X11 Driver';
const BACKUP = '\uFEFFWindows Registry Editor Version 5.00\r\n\r\n[HKEY_CURRENT_USER\\Software\\Wine]\r\n\r\n';

function fixture(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'appbridge-display-env-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const prefixPath = path.join(directory, 'prefix');
  const saveDirectory = path.join(directory, 'Application data');
  fs.mkdirSync(path.join(prefixPath, 'dosdevices'), { recursive: true });
  fs.symlinkSync('/', path.join(prefixPath, 'dosdevices', 'z:'));
  fs.mkdirSync(saveDirectory);
  const calls = [];
  const runCommand = async (executable, args, options) => {
    calls.push({ executable, args, options });
    if (args[1] === 'query') return { ok: true, stdout: `${KEY}\r\n    EmulateModeset    REG_SZ    N\r\n` };
    if (args[1] === 'export') fs.writeFileSync(args[3].slice(2).replaceAll('\\', '/'), BACKUP, 'utf16le');
    return { ok: true, stdout: '', stderr: '', exitCode: 0 };
  };
  return { directory, calls, runCommand, options: { runtimePath: path.join(directory, 'Wine runtime', 'wine'), prefixPath, saveDirectory, runCommand } };
}

test('already enabled REG_SZ values are read without writes, backups or a restart', async (t) => {
  const f = fixture(t);
  for (const value of ['Y', 'y', '1', 'T', 'True']) {
    const result = await prepareEmulatedDisplay({ ...f.options, runCommand: async (...args) => {
      f.calls.push(args);
      return { ok: true, stdout: `HKEY_CURRENT_USER\\Software\\Wine\\X11 Driver\r\n    EmulateModeset    REG_SZ    ${value}\r\n` };
    } });
    assert.deepEqual(result, { configured: false, backupPath: null, restarted: false });
  }
  assert.equal(f.calls.length, 5);
  assert.equal(fs.existsSync(path.join(f.options.saveDirectory, 'display-backups')), false);
});

test('first configuration backs up Wine, sets the fixed string, stops and waits for only the selected prefix', async (t) => {
  const f = fixture(t);
  const result = await prepareEmulatedDisplay(f.options);
  assert.equal(result.configured, true); assert.equal(result.restarted, true);
  assert.equal(f.calls.length, 5);
  assert.deepEqual(f.calls[0].args, ['reg', 'query', KEY, '/v', 'EmulateModeset']);
  assert.deepEqual(f.calls[1].args, ['reg', 'export', 'HKCU\\Software\\Wine', `Z:${result.backupPath.replaceAll('/', '\\')}`, '/y']);
  assert.deepEqual(f.calls[2].args, ['reg', 'add', KEY, '/v', 'EmulateModeset', '/t', 'REG_SZ', '/d', 'Y', '/f']);
  assert.deepEqual(f.calls.slice(3).map((c) => [c.executable, c.args]), [
    [path.join(path.dirname(f.options.runtimePath), 'wineserver'), ['-k']],
    [path.join(path.dirname(f.options.runtimePath), 'wineserver'), ['-w']],
  ]);
  for (const call of f.calls) assert.deepEqual(call.options, { prefixPath: f.options.prefixPath, timeoutMs: 20000 });
  assert.equal(path.dirname(result.backupPath), path.join(f.options.saveDirectory, 'display-backups'));
  assert.equal(fs.statSync(result.backupPath).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(f.options.saveDirectory), ['display-backups']);
});

test('localized errors, wrong registry types and misleading value names do not count as enabled', async (t) => {
  const f = fixture(t);
  for (const queried of [
    { ok: false, stdout: '    EmulateModeset    REG_SZ    Y', stderr: '错误：找不到指定项。' },
    { ok: true, stdout: '    EmulateModeset    REG_DWORD    0x1' },
    { ok: true, stdout: '    NotEmulateModeset    REG_SZ    Y\r\n错误：Y' },
    { ok: true, stdout: '    EmulateModeset    REG_EXPAND_SZ    Y' },
  ]) {
    const result = await prepareEmulatedDisplay({ ...f.options, runCommand: async (...args) => {
      if (args[1][1] === 'query') { f.calls.push({ args: args[1] }); return queried; }
      return f.runCommand(...args);
    } });
    assert.equal(result.configured, true);
  }
  assert.equal(f.calls.length, 20);
});

test('a missing, empty or invalid registry backup aborts before setting or stopping Wine', async (t) => {
  const f = fixture(t);
  for (const backup of [null, '', 'Windows Registry Editor Version 5.00\r\n', 'Windows Registry Editor Version 5.00\r\n\r\n[HKEY_LOCAL_MACHINE\\Software\\Other]\r\n']) {
    const calls = [];
    await assert.rejects(prepareEmulatedDisplay({ ...f.options, runCommand: async (exe, args) => {
      calls.push(args);
      if (args[1] === 'export' && backup !== null) fs.writeFileSync(args[3].slice(2).replaceAll('\\', '/'), backup);
      return { ok: true };
    } }), (error) => {
      assert.ok(error.backupPath); assert.equal(error.configured, false); assert.match(error.message, /未修改/); return true;
    });
    assert.equal(calls.length, 2);
  }
});

test('export failure preserves its diagnostic path and never writes registry settings', async (t) => {
  const f = fixture(t);
  await assert.rejects(prepareEmulatedDisplay({ ...f.options, runCommand: async (...args) => {
    const result = await f.runCommand(...args);
    return args[1][1] === 'export' ? { ok: false, stderr: 'export denied' } : result;
  } }), (error) => {
    assert.match(error.message, /export denied/); assert.ok(error.backupPath); return true;
  });
  assert.equal(f.calls.length, 2);
});

test('setting failure attempts the saved import and reports failed rollback without restarting', async (t) => {
  const f = fixture(t);
  for (const rollbackOk of [true, false]) {
    const calls = [];
    await assert.rejects(prepareEmulatedDisplay({ ...f.options, runCommand: async (...args) => {
      calls.push(args[1]);
      if (args[1][1] === 'add') throw new Error('set denied');
      if (args[1][1] === 'import') return { ok: rollbackOk, stderr: rollbackOk ? '' : 'restore denied' };
      return f.runCommand(...args);
    } }), (error) => {
      assert.equal(error.rollbackAttempted, true); assert.equal(error.rollbackOk, rollbackOk);
      assert.equal(error.configured, false); assert.equal(error.restarted, false);
      assert.match(error.message, /set denied/);
      assert.deepEqual(calls.at(-1), ['reg', 'import', `Z:${error.restorePath.replaceAll('/', '\\')}`]);
      const restoreText = fs.readFileSync(error.restorePath).toString('utf16le');
      assert.match(restoreText, /^\uFEFFWindows Registry Editor Version 5\.00\r\n/);
      assert.ok(restoreText.indexOf('"EmulateModeset"=-') < restoreText.indexOf('[HKEY_CURRENT_USER\\Software\\Wine]\r\n'));
      assert.ok(fs.statSync(error.backupPath).size); return true;
    });
    assert.equal(calls.length, 4);
  }
});

test('wineserver empty exit 1 is accepted only after a successful wait', async (t) => {
  const f = fixture(t);
  const result = await prepareEmulatedDisplay({ ...f.options, runCommand: async (...args) => {
    const normal = await f.runCommand(...args);
    if (args[1][0] === '-k') return { ok: false, exitCode: 1, stdout: '', stderr: '', timedOut: false, error: '运行环境检测未正常退出。' };
    return normal;
  } });
  assert.equal(result.restarted, true);
  assert.deepEqual(f.calls.at(-1).args, ['-w']);
});

test('stop or wait failures restore the setting and backup path without a success marker', async (t) => {
  const f = fixture(t);
  for (const failure of [
    { argument: '-k', result: { ok: false, exitCode: 1, stderr: 'cannot stop' } },
    { argument: '-k', result: { ok: false, exitCode: 1, stdout: 'unexpected output', stderr: '' } },
    { argument: '-k', result: { ok: false, exitCode: 1, stderr: '', timedOut: true } },
    { argument: '-w', result: { ok: false, error: 'wait timed out', timedOut: true } },
  ]) {
    const calls = [];
    await assert.rejects(prepareEmulatedDisplay({ ...f.options, runCommand: async (...args) => {
      calls.push(args[1]); const result = await f.runCommand(...args);
      return args[1][0] === failure.argument ? failure.result : result;
    } }), (error) => {
      assert.equal(error.configured, false); assert.equal(error.restarted, false); assert.ok(error.backupPath);
      assert.equal(error.rollbackOk, true); assert.equal(error.rollbackAttempted, true);
      assert.deepEqual(calls.at(-1), ['reg', 'import', `Z:${error.restorePath.replaceAll('/', '\\')}`]); return true;
    });
    assert.equal(calls.length, failure.argument === '-k' ? 5 : 6);
  }
  assert.deepEqual(fs.readdirSync(f.options.saveDirectory), ['display-backups']);
});

test('restore files remove a newly added value, preserve an original value, and allow retries after stop failures', async (t) => {
  const f = fixture(t);
  for (const original of [null, 'N']) {
    let value = original;
    let stopFails = true;
    const runCommand = async (...args) => {
      const command = args[1];
      if (command[1] === 'query') return { ok: value !== null, stdout: value === null ? '' : `    EmulateModeset    REG_SZ    ${value}\r\n` };
      if (command[1] === 'export') {
        const text = BACKUP + (value === null ? '' : `[HKEY_CURRENT_USER\\Software\\Wine\\X11 Driver]\r\n"EmulateModeset"="${value}"\r\n`);
        fs.writeFileSync(command[3].slice(2).replaceAll('\\', '/'), text, 'utf16le');
      }
      if (command[1] === 'add') value = 'Y';
      if (command[0] === '-k' && stopFails) return { ok: false, exitCode: 2, stderr: 'stop denied' };
      if (command[1] === 'import') {
        const text = fs.readFileSync(command[2].slice(2).replaceAll('\\', '/')).toString('utf16le');
        const changes = [...text.matchAll(/^"EmulateModeset"=(?:-|"([^"]*)")\r?$/gm)];
        assert.equal(changes[0][0].trim(), '"EmulateModeset"=-');
        for (const change of changes) value = change[1] ?? null;
      }
      return { ok: true };
    };
    await assert.rejects(prepareEmulatedDisplay({ ...f.options, runCommand }), (error) => error.rollbackOk);
    assert.equal(value, original);
    stopFails = false;
    const retried = await prepareEmulatedDisplay({ ...f.options, runCommand });
    assert.equal(retried.configured, true); assert.equal(retried.restarted, true); assert.equal(value, 'Y');
  }
});

test('invalid paths, symlinked directories and non-root Z mappings cannot mutate settings', async (t) => {
  const f = fixture(t);
  for (const patch of [{ runtimePath: 'wine' }, { prefixPath: '/' }, { prefixPath: 'prefix' }, { saveDirectory: 'data' }]) {
    await assert.rejects(prepareEmulatedDisplay({ ...f.options, ...patch }));
  }
  const saveLink = path.join(f.directory, 'save-link'); fs.symlinkSync(f.options.saveDirectory, saveLink);
  await assert.rejects(prepareEmulatedDisplay({ ...f.options, saveDirectory: saveLink }), /不能是符号链接/);
  const prefixLink = path.join(f.directory, 'prefix-link'); fs.symlinkSync(f.options.prefixPath, prefixLink);
  await assert.rejects(prepareEmulatedDisplay({ ...f.options, prefixPath: prefixLink }), /不能是符号链接/);
  fs.symlinkSync(f.directory, path.join(f.options.saveDirectory, 'display-backups'));
  await assert.rejects(prepareEmulatedDisplay(f.options), /备份目录必须是普通目录/);
  assert.equal(f.calls.length, 1); // The read-only query is allowed before backup validation.
  fs.unlinkSync(path.join(f.options.saveDirectory, 'display-backups'));
  fs.unlinkSync(path.join(f.options.prefixPath, 'dosdevices', 'z:'));
  fs.symlinkSync(f.directory, path.join(f.options.prefixPath, 'dosdevices', 'z:'));
  await assert.rejects(prepareEmulatedDisplay(f.options), /Z: 映射不是本机根目录/);
  assert.equal(f.calls.length, 1);
});
