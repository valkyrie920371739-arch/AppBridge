'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { inspectDataDirectory, relocateAppData } = require('../src/data-location.cjs');

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'appbridge-data-location-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceDirectory = path.join(root, 'old data'), targetParent = path.join(root, 'chosen folder');
  fs.mkdirSync(sourceDirectory); fs.mkdirSync(targetParent);
  fs.mkdirSync(path.join(sourceDirectory, 'prefix', 'dosdevices'), { recursive: true });
  fs.mkdirSync(path.join(sourceDirectory, 'prefix', 'drive_c', 'users', 'alice', 'Documents'), { recursive: true });
  fs.mkdirSync(path.join(sourceDirectory, 'empty'));
  fs.writeFileSync(path.join(sourceDirectory, 'prefix', 'user.reg'), 'registry contents\n');
  fs.writeFileSync(path.join(sourceDirectory, 'prefix', 'drive_c', 'users', 'alice', 'Documents', 'slot1.sav'), Buffer.from([0, 255, 31, 17, 0]));
  fs.writeFileSync(path.join(sourceDirectory, 'runtime.log'), 'original log\n');
  const destination = path.join(targetParent, 'AppBridge 数据', 'app-id');
  return { root, sourceDirectory, targetParent, destination, options: { sourceDirectory, targetParent, appId: 'app-id', commit: async () => {} } };
}

function allEntries(directory, relative = '') {
  const output = [];
  for (const name of fs.readdirSync(directory).sort()) {
    const filename = path.join(directory, name), key = path.join(relative, name), stat = fs.lstatSync(filename);
    if (stat.isSymbolicLink()) output.push([key, 'link', fs.readlinkSync(filename)]);
    else if (stat.isDirectory()) { output.push([key, 'directory']); output.push(...allEntries(filename, key)); }
    else output.push([key, 'file', fs.readFileSync(filename).toString('hex')]);
  }
  return output;
}

test('inspection counts files and bytes without following Wine drive links or copying their external targets', async (t) => {
  const f = fixture(t);
  const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'private.txt'), 'not part of the data');
  fs.symlinkSync('/', path.join(f.sourceDirectory, 'prefix', 'dosdevices', 'z:'));
  fs.symlinkSync('../drive_c', path.join(f.sourceDirectory, 'prefix', 'dosdevices', 'c:'));
  fs.symlinkSync(outside, path.join(f.sourceDirectory, 'external'));
  const before = allEntries(f.sourceDirectory), result = await inspectDataDirectory(f.sourceDirectory);
  assert.equal(result.files, 3); assert.equal(result.links, 3);
  assert.equal(result.sizeBytes, Buffer.byteLength('registry contents\n') + 5 + Buffer.byteLength('original log\n'));
  assert.match(result.fingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(allEntries(f.sourceDirectory), before);
});

test('Electron uses original-fs so an app.asar archive is moved as an ordinary data file', async (t) => {
  const f = fixture(t), vm = require('node:vm');
  const calls = [], module = { exports: {} };
  const localRequire = (name) => { calls.push(name); return name === 'original-fs' ? fs : require(name); };
  const file = path.join(__dirname, '..', 'src', 'data-location.cjs');
  new vm.Script(fs.readFileSync(file, 'utf8'), { filename: file }).runInNewContext({
    require: localRequire, module, Buffer, process: { versions: { electron: '45.1.0' } },
  });
  assert.ok(calls.includes('original-fs'));
  assert.ok(!calls.includes('node:fs'));
  fs.mkdirSync(path.join(f.sourceDirectory, 'resources'));
  const archive = Buffer.from([0, 0, 0, 4, 1, 2, 3, 255]);
  fs.writeFileSync(path.join(f.sourceDirectory, 'resources', 'app.asar'), archive);
  await module.exports.relocateAppData(f.options);
  assert.ok(fs.lstatSync(path.join(f.destination, 'resources', 'app.asar')).isFile());
  assert.deepEqual(fs.readFileSync(path.join(f.destination, 'resources', 'app.asar')), archive);
});

test('relocation copies the full data tree before committing, preserves file mode/time and leaves the original unchanged', async (t) => {
  const f = fixture(t), file = path.join(f.sourceDirectory, 'runtime.log');
  fs.chmodSync(file, 0o640); fs.utimesSync(file, 1710000000, 1710000000);
  const before = allEntries(f.sourceDirectory); let committed = 0;
  const result = await relocateAppData({ ...f.options, commit: async (value) => {
    committed++;
    assert.equal(value.saveDirectory, f.destination);
    assert.deepEqual(allEntries(value.saveDirectory), before);
    assert.deepEqual(allEntries(f.sourceDirectory), before);
  } });
  assert.equal(committed, 1); assert.equal(result.changed, true);
  assert.equal(result.previousDirectory, f.sourceDirectory); assert.equal(result.sourcePreserved, true);
  assert.equal(result.storageRoot, path.join(f.targetParent, 'AppBridge 数据'));
  assert.equal(result.files, 3);
  assert.equal(fs.statSync(path.join(f.destination, 'runtime.log')).mode & 0o777, 0o640);
  assert.equal(fs.statSync(path.join(f.destination, 'runtime.log')).mtimeMs, 1710000000000);
  assert.deepEqual(fs.readdirSync(result.storageRoot), ['app-id']);
  assert.deepEqual(allEntries(f.sourceDirectory), before);
});

test('internal absolute mappings are rebased while relative, dangling external and Z drive mappings retain their stored targets', async (t) => {
  const f = fixture(t), drives = path.join(f.sourceDirectory, 'prefix', 'dosdevices');
  fs.symlinkSync('/', path.join(drives, 'z:'));
  fs.symlinkSync('../drive_c', path.join(drives, 'c:'));
  fs.symlinkSync(path.join(f.sourceDirectory, 'prefix', 'drive_c'), path.join(drives, 'd:'));
  fs.symlinkSync(f.sourceDirectory, path.join(f.sourceDirectory, 'self'));
  fs.symlinkSync(path.join(f.root, 'missing external'), path.join(f.sourceDirectory, 'external'));
  const original = allEntries(f.sourceDirectory);
  await relocateAppData(f.options);
  assert.equal(fs.readlinkSync(path.join(f.destination, 'prefix', 'dosdevices', 'z:')), '/');
  assert.equal(fs.readlinkSync(path.join(f.destination, 'prefix', 'dosdevices', 'c:')), '../drive_c');
  assert.equal(fs.readlinkSync(path.join(f.destination, 'prefix', 'dosdevices', 'd:')), path.join(f.destination, 'prefix', 'drive_c'));
  assert.equal(fs.readlinkSync(path.join(f.destination, 'self')), f.destination);
  assert.equal(fs.readlinkSync(path.join(f.destination, 'external')), path.join(f.root, 'missing external'));
  assert.deepEqual(allEntries(f.sourceDirectory), original);
});

test('preexisting destinations, recursive plans and invalid application IDs never replace data or call commit', async (t) => {
  const f = fixture(t); let committed = false;
  const commit = async () => { committed = true; };
  fs.mkdirSync(f.destination, { recursive: true });
  fs.writeFileSync(path.join(f.destination, 'keep.txt'), 'existing destination');
  await assert.rejects(relocateAppData({ ...f.options, commit }), /已经存在/);
  assert.equal(fs.readFileSync(path.join(f.destination, 'keep.txt'), 'utf8'), 'existing destination');
  for (const appId of ['', '../app', '/absolute', 'name/child', '.', 'a\0b']) await assert.rejects(relocateAppData({ ...f.options, appId, commit }), /标识/);
  await assert.rejects(relocateAppData({ ...f.options, targetParent: f.sourceDirectory, commit }), /相互包含/);
  const nested = path.join(f.destination, 'nested source'); fs.mkdirSync(nested);
  await assert.rejects(relocateAppData({ ...f.options, sourceDirectory: nested, commit }), /相互包含/);
  assert.equal(committed, false);
});

test('direct or ancestor symlinks and redirected managed containers are rejected without touching external directories', async (t) => {
  const f = fixture(t); const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside);
  const alias = path.join(f.root, 'alias'); fs.symlinkSync(outside, alias);
  await assert.rejects(relocateAppData({ ...f.options, targetParent: alias }), /符号链接/);
  fs.mkdirSync(path.join(outside, 'child'));
  await assert.rejects(relocateAppData({ ...f.options, targetParent: path.join(alias, 'child') }), /符号链接/);
  fs.symlinkSync(outside, path.join(f.targetParent, 'AppBridge 数据'));
  await assert.rejects(relocateAppData(f.options), /符号链接/);
  assert.deepEqual(fs.readdirSync(outside), ['child']);
  assert.deepEqual(fs.readdirSync(path.join(outside, 'child')), []);
  const sourceAlias = path.join(f.root, 'source alias'); fs.symlinkSync(f.sourceDirectory, sourceAlias);
  await assert.rejects(inspectDataDirectory(sourceAlias), /符号链接/);
  await assert.rejects(inspectDataDirectory('/'), /根目录/);
  await assert.rejects(relocateAppData({ ...f.options, targetParent: '/' }), /根目录/);
});

test('failed commit removes only the new copy and keeps the source and existing sibling data recoverable', async (t) => {
  const f = fixture(t), storageRoot = path.dirname(f.destination);
  fs.mkdirSync(storageRoot); fs.mkdirSync(path.join(storageRoot, 'other-app'));
  fs.writeFileSync(path.join(storageRoot, 'other-app', 'save.sav'), 'different app');
  const original = allEntries(f.sourceDirectory);
  await assert.rejects(relocateAppData({ ...f.options, commit: async () => { throw new Error('library commit failed'); } }), (error) => {
    assert.match(error.message, /library commit failed/);
    assert.equal(error.sourcePreserved, true);
    assert.equal(error.previousDirectory, f.sourceDirectory);
    return true;
  });
  assert.deepEqual(allEntries(f.sourceDirectory), original);
  assert.deepEqual(fs.readdirSync(storageRoot), ['other-app']);
  assert.equal(fs.readFileSync(path.join(storageRoot, 'other-app', 'save.sav'), 'utf8'), 'different app');
});

test('rollback never removes a target another process replaced and reports the remaining recovery location', async (t) => {
  const f = fixture(t), rescue = path.join(f.targetParent, 'copied data moved by user');
  await assert.rejects(relocateAppData({ ...f.options, commit: async (value) => {
    fs.renameSync(value.saveDirectory, rescue);
    fs.mkdirSync(value.saveDirectory);
    fs.writeFileSync(path.join(value.saveDirectory, 'unrelated.txt'), 'keep user data');
    throw new Error('commit failed after external replacement');
  } }), (error) => {
    assert.equal(error.sourcePreserved, true);
    assert.equal(error.recoveryDirectory, f.destination);
    assert.ok(error.cleanupErrors.length > 0);
    assert.match(error.message, /已被替换/);
    return true;
  });
  assert.equal(fs.readFileSync(path.join(f.destination, 'unrelated.txt'), 'utf8'), 'keep user data');
  assert.deepEqual(allEntries(rescue), allEntries(f.sourceDirectory));
});

test('a source file changing after it is opened aborts the copy and removes the owned staging folder', async (t) => {
  const f = fixture(t), source = path.join(f.sourceDirectory, 'runtime.log'), originalOpen = fs.promises.open;
  let changed = false;
  fs.promises.open = async (...args) => {
    if (!changed && String(args[0]).includes('.moving-') && String(args[0]).endsWith('runtime.log')) {
      changed = true; fs.appendFileSync(source, 'changed while copying');
    }
    return originalOpen.apply(fs.promises, args);
  };
  try { await assert.rejects(relocateAppData(f.options), /复制期间发生了变化/); }
  finally { fs.promises.open = originalOpen; }
  assert.equal(changed, true);
  assert.match(fs.readFileSync(source, 'utf8'), /changed while copying/);
  assert.deepEqual(fs.readdirSync(f.targetParent), []);
});

test('a newly added source entry is detected by the final complete inventory before commit', async (t) => {
  const f = fixture(t), originalOpen = fs.promises.open; let committed = false, changed = false;
  fs.promises.open = async (...args) => {
    if (!changed && String(args[0]).includes('.moving-') && String(args[0]).endsWith('runtime.log')) {
      changed = true; fs.writeFileSync(path.join(f.sourceDirectory, 'new save.sav'), 'new save');
    }
    return originalOpen.apply(fs.promises, args);
  };
  try { await assert.rejects(relocateAppData({ ...f.options, commit: async () => { committed = true; } }), /整理期间发生了变化/); }
  finally { fs.promises.open = originalOpen; }
  assert.equal(committed, false); assert.equal(changed, true);
  assert.deepEqual(fs.readdirSync(f.targetParent), []);
  assert.equal(fs.readFileSync(path.join(f.sourceDirectory, 'new save.sav'), 'utf8'), 'new save');
});

test('special files abort before any destination exists and an unchanged selected location is a no-op', async (t) => {
  const f = fixture(t);
  const existingSource = path.join(f.targetParent, 'AppBridge 数据', 'app-id');
  fs.mkdirSync(existingSource, { recursive: true }); fs.writeFileSync(path.join(existingSource, 'save.sav'), 'same location');
  let committed = false;
  const same = await relocateAppData({ ...f.options, sourceDirectory: existingSource, commit: async () => { committed = true; } });
  assert.equal(same.changed, false); assert.equal(committed, false);
  assert.equal(fs.readFileSync(path.join(existingSource, 'save.sav'), 'utf8'), 'same location');
  // macOS UNIX socket names have a small pathname limit; use a short root.
  const shortRoot = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'ab-data-socket-'));
  t.after(() => fs.rmSync(shortRoot, { recursive: true, force: true }));
  const net = require('node:net'), socket = path.join(shortRoot, 'runtime.sock');
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
  try { await assert.rejects(inspectDataDirectory(shortRoot), /套接字或特殊文件/); }
  finally { await new Promise((resolve) => server.close(resolve)); }
});
