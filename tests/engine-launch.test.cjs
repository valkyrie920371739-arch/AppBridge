'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { buildEngineLaunchPlan, validateCompatibility, compatibilityInfo, winePath } = require('../src/engine-launch.cjs');
const saveDirectory = path.resolve('/tmp', 'AppBridge $literal & `value`');
const display = { mode: 'app', width: 1600, height: 900, hideDock: true };
const plan = (id, extra = {}) => buildEngineLaunchPlan({ profile: { id, name: id }, display, saveDirectory, ...extra });

test('automatic Unity adapter preserves graphics API while directing logs to managed Windows path', () => {
  const result = plan('unity');
  assert.deepEqual(result.arguments, ['-logFile', winePath(path.join(saveDirectory, 'unity-player.log'))]);
  assert.equal(result.verification, 'awaiting-application-test');
  assert.equal(result.arguments.includes('-force-d3d11'), false);
  assert.ok(result.logFiles.every((f) => path.dirname(f.path) === saveDirectory));
});
test('Unity DX11 fullscreen uses explicit CLI and avoids a second native fullscreen toggle', () => {
  const result = plan('unity', { compatibility: { engine: 'auto', graphics: 'd3d11' }, display: { ...display, mode: 'fullscreen' } });
  assert.deepEqual(result.arguments, ['-force-d3d11', '-logFile', winePath(path.join(saveDirectory, 'unity-player.log')), '-screen-fullscreen', '1', '-screen-width', '1600', '-screen-height', '900', '-window-mode', 'borderless']);
  assert.equal(result.displayHelperMode, 'app');
});
test('Unreal keeps default graphics unless selected and uses a literal absolute log argument', () => {
  const auto = plan('unreal');
  assert.deepEqual(auto.arguments, [`-ABSLOG=${winePath(path.join(saveDirectory, 'unreal-player.log'))}`]);
  const selected = plan('unreal', { compatibility: { engine: 'unreal', graphics: 'd3d11' }, display: { ...display, mode: 'windowed' } });
  assert.deepEqual(selected.arguments, ['-dx11', `-ABSLOG=${winePath(path.join(saveDirectory, 'unreal-player.log'))}`, '-windowed', '-ResX=1600', '-ResY=900']);
  assert.ok(selected.warnings.some((s) => s.includes('Shipping')));
});
test('Godot render and log parameters are gated by actual PCK version evidence', () => {
  for (const minor of [0, 1, 2, 3, 4]) {
    const result = plan('godot', { profile: { id: 'godot', name: 'Godot', variant: 'godot-4', engineVersion: { major: 4, minor, patch: 0 } }, compatibility: { engine: 'auto', graphics: 'opengl' }, display: { ...display, mode: 'windowed' } });
    assert.deepEqual(result.arguments.slice(0, 4), ['--rendering-method', 'gl_compatibility', '--rendering-driver', 'opengl3']);
    assert.equal(result.arguments.includes('--log-file'), minor >= 3);
    assert.deepEqual(result.arguments.slice(-3), ['--resolution', '1600x900', '--windowed']);
  }
  const legacy = plan('godot', { profile: { id: 'godot', variant: 'godot-3' }, compatibility: { engine: 'auto', graphics: 'opengl' } });
  assert.deepEqual(legacy.arguments, ['--video-driver', 'GLES2']);
  const unknown = plan('godot');
  assert.deepEqual(unknown.arguments, []);
  assert.throws(() => plan('godot', { compatibility: { engine: 'auto', graphics: 'opengl' } }), /主版本/);
});
test('manual engine changes do not borrow a different detected engine version', () => {
  assert.throws(() => plan('unity', { profile: { id: 'unity', variant: 'godot-4', engineVersion: { major: 4, minor: 4 } }, compatibility: { engine: 'godot', graphics: 'opengl' } }), /主版本/);
  const generic = plan('unity', { compatibility: { engine: 'unknown', graphics: 'game' }, display: { ...display, mode: 'fullscreen' } });
  assert.deepEqual(generic.arguments, []);
  assert.equal(generic.displayHelperMode, 'fullscreen');
});
test('unrelated engines never receive graphics flags and invalid settings are rejected', () => {
  for (const id of ['renpy', 'rpg-maker-mv', 'rpg-maker-mz', 'tyrano', 'unknown']) {
    assert.deepEqual(plan(id).arguments, []);
    assert.throws(() => validateCompatibility({ engine: 'auto', graphics: 'd3d11' }, { id }), /不支持/);
  }
  for (const value of [null, [], {}, { engine: 'unity', graphics: 'shell-command' }, { engine: '../unity', graphics: 'auto' }]) assert.throws(() => validateCompatibility(value, { id: 'unity' }), /有效/);
  assert.throws(() => winePath('relative.log'), /绝对路径/);
  assert.throws(() => winePath('/tmp/invalid\0path'), /绝对路径/);
  assert.throws(() => plan('unity', { saveDirectory: 'relative' }), /绝对路径/);
});
test('public compatibility info distinguishes identification from validation and normalizes RPG families', () => {
  const info = compatibilityInfo({ engineProfile: { id: 'rpg-maker-mz', name: 'RPG Maker MZ' } });
  assert.equal(info.engineId, 'rpgmaker');
  assert.equal(info.engineName, 'RPG Maker MZ');
  assert.deepEqual(info.graphicsOptions.map((x) => x.value), ['auto', 'game']);
  assert.match(info.note, /待实际程序验证/);
});
