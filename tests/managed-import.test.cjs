'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { inspectImportFolder, copyImportFolder } = require('../src/managed-import.cjs');

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'appbridge-import-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { homeDirectory: path.join(root, 'home'), workspaceRoot: path.join(root, 'workspace'), cloudRoot: path.join(root, 'cloud') };
  for (const folder of Object.values(options)) fs.mkdirSync(folder);
  const source = path.join(root, '完整游戏 folder'); fs.mkdirSync(source);
  const exe = path.join(source, 'Launch.exe'); fs.writeFileSync(exe, Buffer.from('MZ-source-executable'));
  fs.chmodSync(exe, 0o755);
  const save = path.join(options.workspaceRoot, 'windows-apps', 'app-id');
  return { root, options, source, exe, save };
}
function snapshot(directory) {
  return fs.readdirSync(directory, { recursive: true }).sort().map((name) => {
    const file = path.join(directory, name); const stat = fs.lstatSync(file);
    return stat.isDirectory() ? [name, 'directory'] : [name, createHash('sha256').update(fs.readFileSync(file)).digest('hex'), stat.mode & 0o777];
  });
}

test('copies the complete program folder and its resources, preserving original contents and returning the managed EXE', (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.source, 'Data')); fs.mkdirSync(path.join(f.source, 'DLC'));
  fs.writeFileSync(path.join(f.source, 'Data', '配套资源.bin'), Buffer.from([0, 1, 127, 255]));
  fs.writeFileSync(path.join(f.source, 'UnityPlayer.dll'), 'support library');
  const original = snapshot(f.source);
  const plan = inspectImportFolder(f.exe, f.options);
  assert.equal(plan.alreadyManaged, false); assert.equal(plan.files, 3);
  assert.equal(plan.sizeBytes, 20 + 4 + 15);
  const copiedExe = copyImportFolder(plan, f.save);
  assert.equal(copiedExe, path.join(f.save, 'program', 'Launch.exe'));
  assert.deepEqual(snapshot(f.source), original);
  assert.deepEqual(snapshot(path.join(f.save, 'program')), original);
  assert.deepEqual(fs.readdirSync(f.save), ['program']);
});

test('existing workspace and cloud entries are reused without creating any copy destination', (t) => {
  const f = fixture(t);
  for (const root of [f.options.workspaceRoot, f.options.cloudRoot]) {
    const directory = path.join(root, 'managed-game'); fs.mkdirSync(directory);
    const exe = path.join(directory, 'Game.exe'); fs.writeFileSync(exe, 'existing program');
    const plan = inspectImportFolder(exe, f.options);
    assert.equal(plan.alreadyManaged, true);
    assert.equal(copyImportFolder(plan, f.save), exe);
    assert.equal(fs.existsSync(f.save), false);
    assert.equal(fs.readFileSync(exe, 'utf8'), 'existing program');
  }
});

test('refuses root and broad home folders before inspecting unrelated contents', (t) => {
  const f = fixture(t);
  const broad = [f.options.homeDirectory, ...['Downloads', 'Desktop', 'Documents'].map((name) => path.join(f.options.homeDirectory, name))];
  for (const directory of broad) {
    fs.mkdirSync(directory, { recursive: true });
    const exe = path.join(directory, 'Loose.exe'); fs.writeFileSync(exe, 'loose executable');
    assert.throws(() => inspectImportFolder(exe, f.options), /范围太大.*独立文件夹/);
  }
  // A fake root executable avoids writing any fixture outside the temp tree.
  const rootExe = path.join(path.parse(f.root).root, 'AppBridge-test-Root.exe');
  const originalLstat = fs.lstatSync; const originalAccess = fs.accessSync;
  const fileStat = originalLstat(f.exe);
  const statMock = t.mock.method(fs, 'lstatSync', (file, ...args) => file === rootExe ? fileStat : originalLstat(file, ...args));
  const accessMock = t.mock.method(fs, 'accessSync', (file, ...args) => file === rootExe ? undefined : originalAccess(file, ...args));
  assert.throws(() => inspectImportFolder(rootExe, f.options), /范围太大.*独立文件夹/);
  statMock.mock.restore(); accessMock.mock.restore();
});

test('refuses symbolic links in external resources and never follows or changes their targets', (t) => {
  const f = fixture(t); const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'private.bin'), 'untouched external data');
  const link = path.join(f.source, 'linked-data'); fs.symlinkSync(outside, link, 'dir');
  assert.throws(() => inspectImportFolder(f.exe, f.options), /符号链接/);
  assert.equal(fs.readFileSync(path.join(outside, 'private.bin'), 'utf8'), 'untouched external data');
  assert.equal(fs.readlinkSync(link), outside);
  fs.unlinkSync(link);
  const executableLink = path.join(f.source, 'Linked.exe'); fs.symlinkSync(f.exe, executableLink);
  assert.throws(() => inspectImportFolder(executableLink, f.options), /普通文件.*符号链接/);
});

test('refuses a source containing the workspace and refuses destinations nested into the source', (t) => {
  const f = fixture(t);
  const nestedOptions = { ...f.options, workspaceRoot: path.join(f.source, 'workspace') };
  assert.throws(() => inspectImportFolder(f.exe, nestedOptions), /相互包含/);
  const plan = inspectImportFolder(f.exe, f.options);
  assert.throws(() => copyImportFolder(plan, path.join(f.source, 'copy-here')), /工作区内|相互包含/);
  assert.equal(fs.existsSync(path.join(f.source, 'copy-here')), false);
  const outside = path.join(f.root, 'external-data'); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(f.options.workspaceRoot, 'redirected'));
  assert.throws(() => copyImportFolder(plan, path.join(f.options.workspaceRoot, 'redirected', 'app')), /工作区内|链接/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('never overwrites an existing program or accepts a symlink save directory', (t) => {
  const f = fixture(t); const plan = inspectImportFolder(f.exe, f.options);
  const program = path.join(f.save, 'program'); fs.mkdirSync(program, { recursive: true });
  fs.writeFileSync(path.join(program, 'user-data.txt'), 'keep existing data');
  assert.throws(() => copyImportFolder(plan, f.save), /已存在/);
  assert.equal(fs.readFileSync(path.join(program, 'user-data.txt'), 'utf8'), 'keep existing data');
  const alternate = path.join(f.options.workspaceRoot, 'alternate'); fs.mkdirSync(alternate);
  const saveLink = path.join(f.options.workspaceRoot, 'save-link'); fs.symlinkSync(alternate, saveLink);
  assert.throws(() => copyImportFolder(plan, saveLink), /符号链接/);
  assert.deepEqual(fs.readdirSync(alternate), []);
  fs.rmSync(program, { recursive: true }); fs.symlinkSync(alternate, program);
  assert.throws(() => copyImportFolder(plan, f.save), /已存在/);
  assert.equal(fs.readlinkSync(program), alternate);
});

test('a changed import plan is rejected, including a new symlink after confirmation', (t) => {
  const f = fixture(t); const plan = inspectImportFolder(f.exe, f.options);
  fs.writeFileSync(path.join(f.source, 'added.bin'), 'new file');
  assert.throws(() => copyImportFolder(plan, f.save), /确认期间发生了变化/);
  assert.equal(fs.existsSync(f.save), false);
  fs.unlinkSync(path.join(f.source, 'added.bin'));
  fs.symlinkSync(f.exe, path.join(f.source, 'unexpected-link'));
  assert.throws(() => copyImportFolder(plan, f.save), /符号链接/);
  assert.equal(fs.existsSync(f.save), false);
});

test('a workspace root redirected after inspection cannot redirect copied files outside the original workspace', (t) => {
  const f = fixture(t); const plan = inspectImportFolder(f.exe, f.options);
  const outside = path.join(f.root, 'outside-workspace'); fs.mkdirSync(outside);
  fs.rmdirSync(f.options.workspaceRoot); fs.symlinkSync(outside, f.options.workspaceRoot);
  assert.throws(() => copyImportFolder(plan, f.save), /工作区位置发生了变化/);
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.equal(fs.readFileSync(f.exe, 'utf8'), 'MZ-source-executable');
});

test('failed copying cleans only its own staging directory and leaves source and other data intact', (t) => {
  const f = fixture(t); const plan = inspectImportFolder(f.exe, f.options);
  fs.mkdirSync(f.save, { recursive: true }); fs.writeFileSync(path.join(f.save, 'runtime.log'), 'existing log');
  const before = snapshot(f.source);
  const originalWrite = fs.writeSync;
  const mock = t.mock.method(fs, 'writeSync', () => {
    throw Object.assign(new Error('simulated disk full'), { code: 'ENOSPC' });
  });
  assert.throws(() => copyImportFolder(plan, f.save), /disk full/);
  mock.mock.restore();
  assert.equal(fs.writeSync, originalWrite);
  assert.deepEqual(fs.readdirSync(f.save), ['runtime.log']);
  assert.equal(fs.readFileSync(path.join(f.save, 'runtime.log'), 'utf8'), 'existing log');
  assert.deepEqual(snapshot(f.source), before);
});
