'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/compatibility-panel.js'), 'utf8');

function deferred() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}

// Test real panel events with only Electron/DOM boundaries replaced. These
// fixtures never select folders, start Wine, or modify application data.
function harness() {
  let document;
  class Node {
    constructor(id = '') {
      this.id = id; this.value = ''; this.textContent = ''; this.hidden = false;
      this.disabled = false; this.open = false; this.isConnected = true;
      this.attributes = new Map(); this.handlers = new Map(); this.children = [];
    }
    setAttribute(key, value) { this.attributes.set(key, value); }
    replaceChildren(...children) { this.children = children; }
    addEventListener(name, callback) {
      const callbacks = this.handlers.get(name) || [];
      callbacks.push(callback); this.handlers.set(name, callbacks);
    }
    async trigger(name, event = {}) {
      for (const callback of this.handlers.get(name) || []) await callback(event);
    }
    querySelectorAll(selector) { return selector === '.close-dialog' ? closeButtons : []; }
    close() { this.open = false; void this.trigger('close'); }
    focus() { document.activeElement = this; }
    closest() { return null; }
  }
  const ids = [...source.matchAll(/\$\('([^']+)'\)/g)].map((match) => match[1]);
  const nodes = Object.fromEntries([...new Set(ids)].map((id) => [id, new Node(id)]));
  const closeButtons = [new Node('close-top'), new Node('cancel')];
  const opener = new Node('opener'), fallback = new Node('fallback'), details = new Node('details-dialog');
  document = {
    activeElement: opener,
    getElementById: (id) => nodes[id],
    createElement: () => new Node(),
    querySelectorAll: (selector) => selector === '.panel-dialog[open]' ? [nodes['compatibility-dialog'], details].filter((node) => node.open) : [],
    querySelector: () => fallback,
  };
  const game = { id: 'example', title: 'Example.exe', kind: 'windows', engineProfile: { id: 'unity', name: 'Unity', variant: 'mono' } };
  let state = { games: [game] };
  const calls = { compatibility: [], state: 0, messages: [], updates: 0 };
  const behavior = {};
  const ok = (value) => Promise.resolve({ ok: true, value });
  const window = {
    player: {
      compatibility: (id, value) => { calls.compatibility.push({ id, value }); return behavior.compatibility ? behavior.compatibility(id, value) : ok(value); },
      state: () => { calls.state++; return behavior.state ? behavior.state() : ok(state); },
    },
  };
  const context = vm.createContext({ window, document });
  new vm.Script(source, { filename: 'compatibility-panel.js' }).runInContext(context);
  const hooks = {
    request: async (promise) => { const result = await promise; if (!result.ok) throw new Error(result.error); return result.value; },
    getState: () => state,
    onState: (value) => { state = value; calls.updates++; },
    isPending: () => Boolean(behavior.pending),
    message: (text, error) => calls.messages.push({ text, error }),
    showDialog: (id) => { nodes[id].open = true; },
  };
  const submit = () => nodes['compatibility-form'].trigger('submit', { preventDefault() {} });
  const values = () => nodes['compatibility-graphics'].children.map((node) => node.value);
  return { panel: window.AppCompatibilityPanel, game, nodes, closeButtons, opener, fallback, details, calls, behavior, hooks, document, submit, values, getState: () => state };
}

test('compatibility panel identifies the selected app and preserves graphically conservative defaults', () => {
  const h = harness(); h.details.open = true;
  assert.equal(h.panel.open(h.game, h.hooks), true);
  assert.equal(h.details.open, false);
  assert.equal(h.nodes['compatibility-app-name'].textContent, 'Example');
  assert.equal(h.nodes['compatibility-engine'].value, 'auto');
  assert.equal(h.nodes['compatibility-graphics'].value, 'auto');
  assert.deepEqual(h.values(), ['auto', 'game', 'd3d11']);
  assert.match(h.nodes['compatibility-detected'].textContent, /Unity/);
  assert.match(h.nodes['compatibility-help'].textContent, /保留程序的图形接口/);
  assert.equal(h.calls.compatibility.length, 0);
});

test('changing engines removes incompatible graphics choices and a library refresh preserves unsaved selections', async () => {
  const h = harness(); h.game.compatibility = { engine: 'unity', graphics: 'd3d11' };
  h.panel.open(h.game, h.hooks);
  h.nodes['compatibility-engine'].value = 'godot';
  await h.nodes['compatibility-engine'].trigger('change');
  assert.deepEqual(h.values(), ['auto', 'game', 'opengl']);
  assert.equal(h.nodes['compatibility-graphics'].value, 'auto');
  h.nodes['compatibility-graphics'].value = 'opengl';
  await h.nodes['compatibility-graphics'].trigger('change');
  assert.match(h.nodes['compatibility-help'].textContent, /需要识别 Godot 3 或 4/);
  h.panel.refresh();
  assert.equal(h.nodes['compatibility-engine'].value, 'godot');
  assert.equal(h.nodes['compatibility-graphics'].value, 'opengl');
  assert.equal(h.game.compatibility.graphics, 'd3d11', 'draft changes must not mutate saved options');
});

test('running, pending and removed application states block stale submits as well as visible controls', async () => {
  const h = harness(); h.panel.open(h.game, h.hooks);
  h.game.running = true; h.panel.refresh();
  assert.equal(h.nodes['compatibility-fields'].disabled, true);
  assert.equal(h.nodes['compatibility-locked'].hidden, false);
  await h.submit(); assert.equal(h.calls.compatibility.length, 0);
  h.game.running = false; h.behavior.pending = true; h.panel.refresh();
  await h.submit(); assert.equal(h.calls.compatibility.length, 0);
  h.behavior.pending = false; h.getState().games.length = 0; h.panel.refresh();
  assert.equal(h.nodes['compatibility-save'].disabled, true);
  assert.equal(h.nodes['compatibility-unavailable'].hidden, false);
  await h.submit(); assert.equal(h.calls.compatibility.length, 0);
});

test('saving sends structured choices, refreshes the library and closes with a truthful next-launch message', async () => {
  const h = harness(); h.panel.open(h.game, h.hooks);
  h.nodes['compatibility-engine'].value = 'unity';
  await h.nodes['compatibility-engine'].trigger('change');
  h.nodes['compatibility-graphics'].value = 'd3d11';
  await h.submit();
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls.compatibility)), [{ id: 'example', value: { engine: 'unity', graphics: 'd3d11' } }]);
  assert.equal(h.calls.updates, 1);
  assert.equal(h.nodes['compatibility-dialog'].open, false);
  assert.match(h.calls.messages.at(-1).text, /下次启动/);
  assert.equal(h.calls.messages.at(-1).error, false);
});

test('a pending save prevents duplicate requests and dismissal, and errors preserve the editable draft with focus', async () => {
  const h = harness(), pending = deferred();
  h.behavior.compatibility = () => pending.promise;
  h.panel.open(h.game, h.hooks);
  h.nodes['compatibility-graphics'].value = 'd3d11';
  const saving = h.submit();
  await h.submit();
  assert.equal(h.calls.compatibility.length, 1);
  assert.ok(h.closeButtons.every((node) => node.disabled));
  assert.equal(h.panel.open({ ...h.game, id: 'other' }, h.hooks), false);
  let cancelBlocked = false, backdropBlocked = false;
  await h.nodes['compatibility-dialog'].trigger('cancel', { preventDefault: () => { cancelBlocked = true; } });
  await h.nodes['compatibility-dialog'].trigger('click', { target: h.nodes['compatibility-dialog'], stopImmediatePropagation: () => { backdropBlocked = true; } });
  assert.equal(cancelBlocked, true); assert.equal(backdropBlocked, true);
  pending.resolve({ ok: false, error: 'Godot 主版本尚未识别' }); await saving;
  assert.equal(h.nodes['compatibility-dialog'].open, true);
  assert.equal(h.nodes['compatibility-graphics'].value, 'd3d11');
  assert.match(h.nodes['compatibility-error'].textContent, /Godot 主版本/);
  assert.equal(h.document.activeElement, h.nodes['compatibility-error']);
  assert.equal(h.nodes['compatibility-save'].disabled, false);
  assert.ok(h.closeButtons.every((node) => !node.disabled));
});

test('a completed save is not retried or misreported when the following library refresh fails', async () => {
  const h = harness(); h.panel.open(h.game, h.hooks);
  h.behavior.state = () => Promise.resolve({ ok: false, error: '资料库暂时不可读' });
  await h.submit();
  assert.equal(h.calls.compatibility.length, 1);
  assert.equal(h.nodes['compatibility-dialog'].open, false);
  assert.match(h.calls.messages.at(-1).text, /兼容设置已保存.*未能刷新/);
  assert.equal(h.calls.messages.at(-1).error, true);
});

test('canceling does not save, returns keyboard focus, and generic programs expose no renderer-specific options', async () => {
  const h = harness(); h.game.engineProfile = { id: 'unknown', name: 'Windows' };
  h.panel.open(h.game, h.hooks);
  assert.deepEqual(h.values(), ['auto', 'game']);
  assert.match(h.nodes['compatibility-detected'].textContent, /尚未可靠识别/);
  h.nodes['compatibility-dialog'].close();
  assert.equal(h.document.activeElement, h.opener);
  assert.equal(h.calls.compatibility.length, 0);
  assert.equal(h.panel.open({ ...h.game, kind: 'tyrano' }, h.hooks), false);
});

test('invalid or unavailable selections do not cross the bridge', async () => {
  const h = harness(); h.panel.open(h.game, h.hooks);
  h.nodes['compatibility-graphics'].value = 'opengl';
  await h.submit();
  assert.equal(h.calls.compatibility.length, 0);
  assert.match(h.nodes['compatibility-error'].textContent, /可用的图形模式/);
});

test('backend notes describe the stored engine without leaking into a different draft engine', async () => {
  const h = harness();
  h.game.compatibilityInfo = { engineId: 'unity', detectedEngineName: 'Unity', note: 'Unity-specific backend note', graphicsOptions: [{ value: 'auto' }, { value: 'game' }, { value: 'd3d11' }] };
  h.panel.open(h.game, h.hooks);
  assert.equal(h.nodes['compatibility-help'].textContent, 'Unity-specific backend note');
  h.nodes['compatibility-engine'].value = 'godot';
  await h.nodes['compatibility-engine'].trigger('change');
  assert.doesNotMatch(h.nodes['compatibility-help'].textContent, /Unity-specific/);
  assert.match(h.nodes['compatibility-help'].textContent, /保留程序的图形接口/);
});

test('opening from an older information dialog uses the latest saved preferences', () => {
  const h = harness();
  const earlierGame = { ...h.game, compatibility: { engine: 'unity', graphics: 'd3d11' } };
  h.game.compatibility = { engine: 'unity', graphics: 'game' };
  h.panel.open(earlierGame, h.hooks);
  assert.equal(h.nodes['compatibility-engine'].value, 'unity');
  assert.equal(h.nodes['compatibility-graphics'].value, 'game');
});
