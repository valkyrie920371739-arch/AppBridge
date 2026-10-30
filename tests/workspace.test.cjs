'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { workspaceLayout, initializeWorkspace, prepareManagedPrefix } = require('../src/workspace.cjs');

function fixture(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'appbridge-workspace-test-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'workspace');
  fs.mkdirSync(root);
  const prefix = path.join(root, 'windows-apps', 'app-id', 'prefix');
  const user = path.join(prefix, 'drive_c', 'users', 'alice');
  const outside = path.join(directory, 'Mac user files');
  fs.mkdirSync(outside);
  return { directory, root, prefix, user, outside };
}
function userDirectory(f) { fs.mkdirSync(f.user, { recursive: true }); }
function outsideLink(f, name, targetName = name) {
  const target = path.join(f.outside, targetName);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'untouched.txt'), `Original ${name}`);
  fs.symlinkSync(target, path.join(f.user, name), 'dir');
  return target;
}
function linksIn(directory) {
  return fs.readdirSync(directory).filter((name) => name.startsWith('.appbridge-'));
}

test('workspace layout has one root and initialization is repeatable without changing existing data', (t) => {
  const f = fixture(t);
  const expected = workspaceLayout(f.root);
  assert.equal(expected.profileRoot, f.root);
  for (const name of ['runtimeRoot', 'cacheRoot', 'logsRoot', 'exportsRoot', 'appsRoot', 'homeRoot']) {
    assert.equal(path.dirname(expected[name]), f.root);
  }
  assert.equal(expected.appsRoot, path.join(f.root, 'windows-apps'));
  const initialized = initializeWorkspace(f.root);
  for (const directory of Object.values(initialized)) assert.ok(fs.lstatSync(directory).isDirectory());
  const saved = path.join(initialized.appsRoot, 'saved.txt');
  fs.writeFileSync(saved, 'keep this app data');
  assert.deepEqual(initializeWorkspace(f.root), initialized);
  assert.equal(fs.readFileSync(saved, 'utf8'), 'keep this app data');
});

test('initialization refuses a redirected root or component before creating other component folders', (t) => {
  const f = fixture(t);
  const alias = path.join(f.directory, 'redirected-workspace');
  fs.symlinkSync(f.root, alias, 'dir');
  assert.throws(() => initializeWorkspace(alias), /普通文件夹/);
  fs.symlinkSync(f.outside, path.join(f.root, 'cache'), 'dir');
  const before = fs.readdirSync(f.root);
  assert.throws(() => initializeWorkspace(f.root), /普通文件夹/);
  assert.deepEqual(fs.readdirSync(f.root), before);
  assert.deepEqual(fs.readdirSync(f.outside), []);
  assert.throws(() => workspaceLayout('/'), /根目录/);
  assert.throws(() => workspaceLayout('relative'), /绝对路径/);
});

test('uninitialized prefixes are left empty for Wineboot rather than receiving a drive skeleton', (t) => {
  const f = fixture(t);
  const absent = prepareManagedPrefix(f.prefix, f.root);
  assert.equal(absent.initialized, false);
  assert.deepEqual(absent.changed, []);
  assert.ok(!fs.existsSync(f.prefix));
  fs.mkdirSync(f.prefix, { recursive: true });
  assert.equal(prepareManagedPrefix(f.prefix, f.root).initialized, false);
  assert.deepEqual(fs.readdirSync(f.prefix), []);
});

test('standard external user-folder links become internal directories and retain their source metadata', (t) => {
  const f = fixture(t);
  userDirectory(f);
  const originals = new Map();
  for (const folder of ['Desktop', 'Documents', 'Downloads', 'Music', 'Pictures', 'Videos']) {
    originals.set(folder, outsideLink(f, folder, folder === 'Videos' ? 'Movies' : folder));
  }
  const result = prepareManagedPrefix(f.prefix, f.root);
  assert.equal(result.initialized, true);
  assert.equal(result.changed.length, 6);
  assert.deepEqual(result.warnings, []);
  const metadata = JSON.parse(fs.readFileSync(result.metadataPath, 'utf8'));
  assert.equal(metadata.version, 1);
  assert.equal(metadata.entries.length, 6);
  for (const [folder, target] of originals) {
    const managed = path.join(f.user, folder);
    assert.ok(fs.lstatSync(managed).isDirectory());
    assert.ok(!fs.lstatSync(managed).isSymbolicLink());
    assert.deepEqual(fs.readdirSync(managed), []); // Never copy the Mac user's files.
    assert.equal(fs.readFileSync(path.join(target, 'untouched.txt'), 'utf8'), `Original ${folder}`);
    const record = metadata.entries.find((entry) => entry.folder === folder);
    assert.equal(record.user, 'alice');
    assert.equal(record.originalTarget, target);
    assert.equal(record.resolvedTarget, fs.realpathSync(target));
    assert.equal(record.relativePath, path.join('drive_c', 'users', 'alice', folder));
    assert.ok(Number.isFinite(Date.parse(record.convertedAt)));
  }
  assert.deepEqual(linksIn(f.user), []);
  const before = fs.readFileSync(result.metadataPath, 'utf8');
  assert.deepEqual(prepareManagedPrefix(f.prefix, f.root).changed, []);
  assert.equal(fs.readFileSync(result.metadataPath, 'utf8'), before);
});

test('internal links, existing directories, nonstandard links, and special user aliases remain untouched', (t) => {
  const f = fixture(t);
  userDirectory(f);
  const internal = path.join(f.root, 'home', 'Documents');
  fs.mkdirSync(internal, { recursive: true });
  fs.symlinkSync(path.relative(f.user, internal), path.join(f.user, 'Documents'), 'dir');
  const internalTarget = fs.readlinkSync(path.join(f.user, 'Documents'));
  fs.mkdirSync(path.join(f.user, 'Desktop'));
  fs.writeFileSync(path.join(f.user, 'Desktop', 'save.dat'), 'existing save');
  fs.symlinkSync(f.outside, path.join(f.user, 'UnmanagedFolder'), 'dir');
  for (const name of ['Public', 'All Users', 'AllUsers', 'Default', 'Default User']) {
    fs.symlinkSync(f.outside, path.join(f.prefix, 'drive_c', 'users', name), 'dir');
  }
  const result = prepareManagedPrefix(f.prefix, f.root);
  assert.deepEqual(result.changed, []);
  assert.equal(fs.readlinkSync(path.join(f.user, 'Documents')), internalTarget);
  assert.equal(fs.readFileSync(path.join(f.user, 'Desktop', 'save.dat'), 'utf8'), 'existing save');
  assert.equal(fs.readlinkSync(path.join(f.user, 'UnmanagedFolder')), f.outside);
  for (const name of ['Public', 'All Users', 'AllUsers', 'Default', 'Default User']) {
    assert.equal(fs.readlinkSync(path.join(f.prefix, 'drive_c', 'users', name)), f.outside);
  }
  assert.ok(!fs.existsSync(path.join(f.prefix, '.appbridge-folder-links.json')));
});

test('a missing external folder is repaired without creating or touching its former target', (t) => {
  const f = fixture(t);
  userDirectory(f);
  const missing = path.join(f.outside, 'not created', 'Documents');
  fs.symlinkSync(missing, path.join(f.user, 'Documents'), 'dir');
  assert.equal(prepareManagedPrefix(f.prefix, f.root).changed.length, 1);
  assert.ok(fs.lstatSync(path.join(f.user, 'Documents')).isDirectory());
  assert.ok(!fs.existsSync(missing));
});

test('external symlink targets containing an intermediate symlink and parent segment are resolved by the filesystem', (t) => {
  const f = fixture(t);
  userDirectory(f);
  const nested = path.join(f.outside, 'nested');
  fs.mkdirSync(nested);
  const target = path.join(f.outside, 'Documents');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'untouched.txt'), 'outside data');
  fs.symlinkSync(nested, path.join(f.root, 'anchor'), 'dir');
  const link = `${f.root}/anchor/../Documents`;
  fs.symlinkSync(link, path.join(f.user, 'Documents'), 'dir');
  const result = prepareManagedPrefix(f.prefix, f.root);
  assert.equal(result.changed.length, 1);
  assert.equal(result.changed[0].originalTarget, link);
  assert.equal(result.changed[0].resolvedTarget, target);
  assert.equal(fs.readFileSync(path.join(target, 'untouched.txt'), 'utf8'), 'outside data');
  assert.ok(fs.lstatSync(path.join(f.user, 'Documents')).isDirectory());
});

test('prefix containment checks reject direct and ancestor redirects, including user directories', (t) => {
  const f = fixture(t);
  assert.throws(() => prepareManagedPrefix(f.outside, f.root), /工作区内/);
  assert.throws(() => prepareManagedPrefix(f.root, f.root), /工作区内/);
  const alias = path.join(f.root, 'alias');
  fs.symlinkSync(f.outside, alias, 'dir');
  assert.throws(() => prepareManagedPrefix(path.join(alias, 'new-prefix'), f.root), /之外/);
  assert.ok(!fs.existsSync(path.join(f.outside, 'new-prefix')));
  userDirectory(f);
  fs.symlinkSync(f.outside, path.join(f.prefix, 'drive_c', 'users', 'outside-user'), 'dir');
  outsideLink(f, 'Documents');
  assert.throws(() => prepareManagedPrefix(f.prefix, f.root), /之外/);
  assert.ok(fs.lstatSync(path.join(f.user, 'Documents')).isSymbolicLink());
  assert.deepEqual(linksIn(f.user), []);
});

test('a folder replacement failure restores all original links and preserves external files', (t) => {
  const f = fixture(t);
  userDirectory(f);
  const desktop = outsideLink(f, 'Desktop');
  const documents = outsideLink(f, 'Documents');
  const realRename = fs.renameSync;
  fs.renameSync = (source, destination) => {
    if (String(source).includes('.appbridge-folder-') && destination === path.join(f.user, 'Documents')) {
      throw Object.assign(new Error('simulated rename failure'), { code: 'EACCES' });
    }
    return realRename(source, destination);
  };
  try { assert.throws(() => prepareManagedPrefix(f.prefix, f.root), /simulated rename failure/); }
  finally { fs.renameSync = realRename; }
  assert.equal(fs.readlinkSync(path.join(f.user, 'Desktop')), desktop);
  assert.equal(fs.readlinkSync(path.join(f.user, 'Documents')), documents);
  assert.equal(fs.readFileSync(path.join(documents, 'untouched.txt'), 'utf8'), 'Original Documents');
  assert.deepEqual(linksIn(f.user), []);
  assert.ok(!fs.existsSync(path.join(f.prefix, '.appbridge-folder-links.json')));
});

test('a failed metadata commit rolls back converted links and retains the prior journal', (t) => {
  const f = fixture(t);
  userDirectory(f);
  const target = outsideLink(f, 'Downloads');
  const journal = path.join(f.prefix, '.appbridge-folder-links.json');
  const oldText = '{"version":1,"entries":[],"note":"prior record"}\n';
  fs.writeFileSync(journal, oldText);
  const realRename = fs.renameSync;
  fs.renameSync = (source, destination) => {
    if (destination === journal) throw Object.assign(new Error('simulated journal failure'), { code: 'EACCES' });
    return realRename(source, destination);
  };
  try { assert.throws(() => prepareManagedPrefix(f.prefix, f.root), /simulated journal failure/); }
  finally { fs.renameSync = realRename; }
  assert.equal(fs.readlinkSync(path.join(f.user, 'Downloads')), target);
  assert.equal(fs.readFileSync(journal, 'utf8'), oldText);
  assert.equal(fs.readFileSync(path.join(target, 'untouched.txt'), 'utf8'), 'Original Downloads');
  assert.deepEqual(linksIn(f.user), []);
  assert.deepEqual(fs.readdirSync(f.prefix).sort(), ['.appbridge-folder-links.json', 'drive_c']);
});
