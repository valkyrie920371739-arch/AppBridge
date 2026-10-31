'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { detectEngine } = require('../src/engine-profiles.cjs');

function fixture(t, name = 'Game.exe') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'appbridge-engine-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = (relative, content = '') => { const target = path.join(root, relative); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content); return target; };
  const directory = (relative) => { const target = path.join(root, relative); fs.mkdirSync(target, { recursive: true }); return target; };
  return { root, file, directory, exe: file(name, 'offline executable fixture') };
}
function pck(major, format = major === 3 ? 1 : 2) {
  const bytes = Buffer.alloc(20); bytes.write('GDPC'); bytes.writeUInt32LE(format, 4); bytes.writeUInt32LE(major, 8); bytes.writeUInt32LE(3, 12); bytes.writeUInt32LE(2, 16); return bytes;
}

test('UnityPlayer alone retains the existing Unity route without claiming a backend or strong confidence', (t) => {
  const f = fixture(t); f.file('UnityPlayer.dll');
  const result = detectEngine(f.exe);
  assert.equal(result.id, 'unity'); assert.equal(result.variant, null); assert.equal(result.confidence, 'low');
  assert.deepEqual(result.evidence, ['UnityPlayer.dll']);
});

test('Unity Mono and IL2CPP use matching data folders and case-insensitive Windows paths', (t) => {
  const mono = fixture(t, 'A game.EXE'); mono.file('UNITYPLAYER.DLL'); mono.directory('a GAME_data'); mono.directory('monobleedingedge');
  const a = detectEngine(mono.exe); assert.equal(a.id, 'unity'); assert.equal(a.variant, 'mono'); assert.equal(a.confidence, 'high');
  const il2cpp = fixture(t); il2cpp.file('UnityPlayer.dll'); il2cpp.file('GameAssembly.dll'); il2cpp.file('Game_Data/il2cpp_data/Metadata/global-metadata.dat');
  const b = detectEngine(il2cpp.exe); assert.equal(b.id, 'unity'); assert.equal(b.variant, 'il2cpp'); assert.equal(b.confidence, 'high');
  assert.ok(b.evidence.includes('Game_Data/il2cpp_data/Metadata/global-metadata.dat'));
});

test('older Unity layouts need real data markers, while generic data folders and GameAssembly alone are insufficient', (t) => {
  const old = fixture(t); old.file('Game_Data/globalgamemanagers'); old.directory('Game_Data/Managed');
  assert.equal(detectEngine(old.exe).variant, 'mono');
  const unknown = fixture(t); unknown.directory('Game_Data'); unknown.file('GameAssembly.dll');
  assert.equal(detectEngine(unknown.exe).id, 'unknown');
  unknown.file('Other_Data/globalgamemanagers'); assert.equal(detectEngine(unknown.exe).id, 'unknown');
});

test('mixed Unity scripting backends stay unselected and report the conflict', (t) => {
  const f = fixture(t); f.file('UnityPlayer.dll'); f.directory('Game_Data'); f.file('GameAssembly.dll'); f.directory('MonoBleedingEdge');
  const result = detectEngine(f.exe); assert.equal(result.id, 'unity'); assert.equal(result.variant, null); assert.match(result.warnings.join(' '), /Mono.*IL2CPP/);
});

test('Godot standalone PCK headers distinguish 3 and 4, and future versions retain default arguments', (t) => {
  for (const major of [3, 4, 5]) {
    const f = fixture(t); f.file('gAME.PCK', pck(major));
    const result = detectEngine(f.exe); assert.equal(result.id, 'godot'); assert.equal(result.variant, major <= 4 ? `godot-${major}` : null);
    assert.deepEqual(result.engineVersion, { major, minor: 3, patch: 2 });
    assert.equal(result.warnings.length > 0, major === 5);
  }
  const f = fixture(t); f.file('Game.pck', pck(4, 100)); assert.equal(detectEngine(f.exe).variant, null);
});

test('PCK filenames, malformed headers and truncated packs do not establish Godot', (t) => {
  const f = fixture(t); f.file('Other.pck', pck(4)); assert.equal(detectEngine(f.exe).id, 'unknown');
  f.file('Game.pck', 'not a Godot pack file'); assert.equal(detectEngine(f.exe).id, 'unknown');
  f.file('Game.pck', pck(4).subarray(0, 12)); assert.equal(detectEngine(f.exe).id, 'unknown');
  f.file('Game.pck', pck(0)); assert.equal(detectEngine(f.exe).id, 'unknown');
});

test('equally strong engines are reported as ambiguous, while a weak stray Unity DLL does not override Godot', (t) => {
  const f = fixture(t); f.file('UnityPlayer.dll'); f.file('Game.pck', pck(4));
  assert.equal(detectEngine(f.exe).id, 'godot');
  f.directory('Game_Data'); const result = detectEngine(f.exe);
  assert.equal(result.id, 'unknown'); assert.equal(result.confidence, 'ambiguous'); assert.match(result.warnings.join(' '), /多个引擎/);
});

test('Unreal packaged project layout identifies a bootstrap without changing its selected entry', (t) => {
  const f = fixture(t); f.file('Project/Content/Paks/data.pak'); f.file('Project/Binaries/Win64/Project-Win64-Shipping.exe'); f.directory('Engine/Binaries/Win64');
  const result = detectEngine(f.exe); assert.equal(result.id, 'unreal'); assert.equal(result.variant, null);
  assert.ok(result.evidence.includes('Project/Binaries/Win64/Project-Win64-Shipping.exe')); assert.equal(Object.hasOwn(result, 'exePath'), false);
});

test('Unreal nested entries use only an explicitly supplied resource root; Shipping names alone are not evidence', (t) => {
  const f = fixture(t, 'Project/Binaries/Win64/Project-Win64-Shipping.exe'); f.file('Project/Content/Paks/chunk.utoc');
  assert.equal(detectEngine(f.exe).id, 'unknown');
  assert.equal(detectEngine(f.exe, { rootDirectory: f.root }).id, 'unreal');
  fs.rmSync(path.join(f.root, 'Project/Content'), { recursive: true });
  assert.equal(detectEngine(f.exe, { rootDirectory: f.root }).id, 'unknown');
});

test('a standard Unreal nested entry can infer a complete package root only with the Engine and project resources present', (t) => {
  const f = fixture(t, 'Project/Binaries/Win64/Project-Win64-Shipping.exe');
  f.file('Project/Content/Paks/chunk.pak'); f.directory('Engine/Binaries/Win64');
  const result = detectEngine(f.exe); assert.equal(result.id, 'unreal'); assert.equal(result.rootDirectory, f.root);
  fs.rmSync(path.join(f.root, 'Engine'), { recursive: true });
  assert.equal(detectEngine(f.exe).rootDirectory, path.dirname(f.exe));
});

test('Unreal packages with only Engine third-party binaries still infer and identify the complete nested-entry root', (t) => {
  const f = fixture(t, 'Project/Binaries/Win64/Project-Win64-Shipping.exe');
  f.file('Project/Content/Paks/chunk.pak'); f.file('Engine/Binaries/ThirdParty/vendor/Win64/dependency.dll');
  const result = detectEngine(f.exe);
  assert.equal(result.id, 'unreal'); assert.equal(result.rootDirectory, f.root);
  assert.ok(result.evidence.includes('Project/Binaries/Win64/Project-Win64-Shipping.exe'));
  assert.ok(result.evidence.includes('Engine/Binaries'));
  assert.equal(Object.hasOwn(result, 'exePath'), false);
  fs.rmSync(path.join(f.root, 'Project/Content'), { recursive: true });
  assert.equal(detectEngine(f.exe).id, 'unknown');
  assert.equal(detectEngine(f.exe).rootDirectory, path.dirname(f.exe));
});

test('Unreal bootstrap detection accepts Engine third-party layout together with project Paks', (t) => {
  const f = fixture(t); f.file('Project/Content/Paks/chunk.utoc');
  f.file('Engine/Binaries/ThirdParty/vendor/dependency.dll'); f.file('Project/Binaries/Win64/Project.exe');
  const result = detectEngine(f.exe);
  assert.equal(result.id, 'unreal'); assert.equal(result.rootDirectory, f.root);
  assert.ok(result.evidence.includes('Project/Content/Paks/chunk.utoc'));
  fs.rmSync(path.join(f.root, 'Engine'), { recursive: true });
  assert.equal(detectEngine(f.exe).id, 'unknown');
});

test('RenPy requires its runtime code, lib and game folders together', (t) => {
  const f = fixture(t); f.directory('renpy'); f.directory('game'); f.directory('lib');
  assert.equal(detectEngine(f.exe).id, 'unknown'); f.file('RenPy/__init__.py');
  // Case-sensitive filesystems may have two differently-cased directories;
  // make the expected unambiguous path explicit on every platform.
  if (fs.readdirSync(f.root).includes('RenPy')) { fs.rmSync(path.join(f.root, 'RenPy'), { recursive: true }); f.file('renpy/__init__.py'); }
  assert.equal(detectEngine(f.exe).id, 'renpy');
});

test('RPG Maker MV and MZ recognize the declared local web root and engine core', (t) => {
  const mv = fixture(t); mv.file('package.json', JSON.stringify({ main: 'www/index.html' })); mv.file('www/index.html'); mv.file('www/js/rpg_core.js');
  assert.equal(detectEngine(mv.exe).id, 'rpg-maker-mv');
  const mz = fixture(t); mz.file('www/package.json', JSON.stringify({ main: './index.html' })); mz.file('www/index.html'); mz.file('www/js/rmmz_core.js');
  assert.equal(detectEngine(mz.exe).id, 'rpg-maker-mz');
  mz.file('www/js/rpg_core.js'); assert.equal(detectEngine(mz.exe).confidence, 'ambiguous');
});

test('Tyrano recognizes NW.js and unpacked Electron layouts using declared manifests', (t) => {
  for (const main of ['index.html', 'www/index.html', 'main.js']) {
    const f = fixture(t); f.file('package.json', JSON.stringify({ name: 'tyranogame', main })); f.file(main);
    f.file((main.startsWith('www/') ? 'www/' : '') + 'tyrano/plugins/kag/kag.js');
    assert.equal(detectEngine(f.exe).id, 'tyrano');
  }
});

test('web manifests are bounded data and cannot request paths outside the program', (t) => {
  const f = fixture(t); f.file('index.html'); f.file('js/rmmz_core.js');
  for (const manifest of ['not JSON', JSON.stringify({ main: '../index.html' }), JSON.stringify({ main: '/index.html' }), JSON.stringify({ main: 'index.html', filler: 'x'.repeat(65536) })]) {
    f.file('package.json', manifest); assert.equal(detectEngine(f.exe).id, 'unknown');
  }
  assert.ok(detectEngine(f.exe).warnings.some((warning) => warning.includes('配置文件过大')));
});

test('symlinked markers and resource directories cannot supply evidence outside the selected root', (t) => {
  const f = fixture(t); const outside = fixture(t); outside.file('UnityPlayer.dll'); outside.file('Game_Data/globalgamemanagers');
  fs.symlinkSync(path.join(outside.root, 'UnityPlayer.dll'), path.join(f.root, 'UnityPlayer.dll'));
  fs.symlinkSync(path.join(outside.root, 'Game_Data'), path.join(f.root, 'Game_Data'));
  assert.equal(detectEngine(f.exe).id, 'unknown');
  fs.symlinkSync(outside.root, path.join(f.root, 'outside'));
  assert.throws(() => detectEngine(path.join(f.root, 'outside', 'Game.exe'), { rootDirectory: f.root }), /入口必须位于/);
  assert.throws(() => detectEngine(f.exe, { rootDirectory: path.join(f.root, 'outside') }), /符号链接/);
});

test('invalid input paths fail before scanning and broad directories stop at a fixed entry bound', (t) => {
  const f = fixture(t);
  assert.throws(() => detectEngine('Game.exe'), /绝对路径/);
  assert.throws(() => detectEngine(f.exe, { rootDirectory: '..' }), /绝对路径/);
  assert.throws(() => detectEngine(f.exe, { rootDirectory: f.exe }), /普通文件夹/);
  const marker = f.file('UnityPlayer.dll'); const stat = fs.statSync(marker);
  for (let i = 0; i < 1024; i++) f.file(`unrelated-${i}.dat`);
  const result = detectEngine(f.exe); assert.equal(result.id, 'unknown'); assert.ok(result.warnings.some((warning) => warning.includes('项目过多')));
  assert.equal(fs.statSync(marker).mtimeMs, stat.mtimeMs);
});
