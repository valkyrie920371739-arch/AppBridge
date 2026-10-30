'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readJsonRecoverable, writeJsonAtomic } = require('../src/storage.cjs');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'appbridge-storage-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, file: path.join(directory, 'data.json') };
}

test('reads valid JSON without changing the file or creating recovery copies', (t) => {
  const { directory, file } = fixture(t);
  const source = '{"apps":[{"id":"a"}]}';
  fs.writeFileSync(file, source);
  assert.deepEqual(readJsonRecoverable(file, { fallback: {}, validate: (value) => Array.isArray(value.apps) }), { apps: [{ id: 'a' }] });
  assert.equal(fs.readFileSync(file, 'utf8'), source);
  assert.deepEqual(fs.readdirSync(directory), ['data.json']);
});

test('missing files return independent fallback values, including factory values', (t) => {
  const { directory, file } = fixture(t);
  const fallback = { apps: [] };
  const first = readJsonRecoverable(file, { fallback });
  first.apps.push('changed');
  assert.deepEqual(readJsonRecoverable(file, { fallback }), { apps: [] });
  assert.deepEqual(fallback, { apps: [] });
  const factory = () => fallback;
  readJsonRecoverable(file, { fallback: factory }).apps.push('factory change');
  assert.deepEqual(fallback, { apps: [] });
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('invalid JSON is preserved byte-for-byte under a unique recovery name', (t) => {
  const { directory, file } = fixture(t);
  const source = '{"apps":\n';
  fs.writeFileSync(file, source);
  const previousBackup = `${file}.corrupt-older.bak`;
  fs.writeFileSync(previousBackup, 'previous recovery');
  let recovery;
  assert.deepEqual(readJsonRecoverable(file, { fallback: [], onRecovery: (event) => { recovery = event; } }), []);
  assert.equal(recovery.file, file);
  assert.ok(recovery.error instanceof SyntaxError);
  assert.match(recovery.backupPath, /data\.json\.corrupt-.+\.bak$/);
  assert.equal(fs.readFileSync(recovery.backupPath, 'utf8'), source);
  assert.equal(fs.readFileSync(previousBackup, 'utf8'), 'previous recovery');
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.readdirSync(directory).length, 2);
});

test('validation failure recovers a syntactically valid file', (t) => {
  const { directory, file } = fixture(t);
  fs.writeFileSync(file, '{}');
  assert.deepEqual(readJsonRecoverable(file, { fallback: [], validate: Array.isArray }), []);
  const [backup] = fs.readdirSync(directory);
  assert.equal(fs.readFileSync(path.join(directory, backup), 'utf8'), '{}');
});

test('read errors are propagated and do not classify data as corrupt', (t) => {
  const { directory, file } = fixture(t);
  fs.writeFileSync(file, '{}');
  const originalRead = fs.readFileSync;
  const accessError = Object.assign(new Error('denied'), { code: 'EACCES' });
  const mock = t.mock.method(fs, 'readFileSync', (...args) => {
    if (args[0] === file) throw accessError;
    return originalRead(...args);
  });
  assert.throws(() => readJsonRecoverable(file, { fallback: [] }), (error) => error === accessError);
  mock.mock.restore();
  assert.equal(fs.readFileSync(file, 'utf8'), '{}');
  assert.deepEqual(fs.readdirSync(directory), ['data.json']);
});

test('a failed recovery rename preserves the original and removes its reservation', (t) => {
  const { directory, file } = fixture(t);
  fs.writeFileSync(file, 'broken');
  const renameError = Object.assign(new Error('rename denied'), { code: 'EACCES' });
  const mock = t.mock.method(fs, 'renameSync', () => { throw renameError; });
  assert.throws(() => readJsonRecoverable(file, { fallback: [] }), (error) => error === renameError);
  mock.mock.restore();
  assert.equal(fs.readFileSync(file, 'utf8'), 'broken');
  assert.deepEqual(fs.readdirSync(directory), ['data.json']);
});

test('atomic writes replace data only after syncing and keep private permissions', (t) => {
  const { directory, file } = fixture(t);
  fs.writeFileSync(file, '{"old":true}');
  const originalSync = fs.fsyncSync;
  const originalRename = fs.renameSync;
  let synced = false;
  const syncMock = t.mock.method(fs, 'fsyncSync', (fd) => { originalSync(fd); synced = true; });
  const renameMock = t.mock.method(fs, 'renameSync', (...args) => {
    assert.equal(synced, true);
    assert.equal(fs.readFileSync(file, 'utf8'), '{"old":true}');
    return originalRename(...args);
  });
  writeJsonAtomic(file, { apps: [{ id: 'next' }] });
  syncMock.mock.restore(); renameMock.mock.restore();
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { apps: [{ id: 'next' }] });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(directory), ['data.json']);
});

test('failed atomic replacement leaves existing data intact and removes temporary files', (t) => {
  const { directory, file } = fixture(t);
  fs.writeFileSync(file, '{"old":true}');
  const renameError = Object.assign(new Error('rename denied'), { code: 'EACCES' });
  const mock = t.mock.method(fs, 'renameSync', () => { throw renameError; });
  assert.throws(() => writeJsonAtomic(file, { next: true }), (error) => error === renameError);
  mock.mock.restore();
  assert.equal(fs.readFileSync(file, 'utf8'), '{"old":true}');
  assert.deepEqual(fs.readdirSync(directory), ['data.json']);
  assert.throws(() => writeJsonAtomic(file, undefined), TypeError);
  assert.deepEqual(fs.readdirSync(directory), ['data.json']);
});
