'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/data-panel.js'), 'utf8');

function deferred() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}

// Exercise UI decisions without starting Electron, selecting folders or copying
// real application data. Only the DOM/event boundary is replaced here.
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
  const closeButtons = [new Node('close-top'), new Node('close-bottom')];
  const opener = new Node('opener'), fallback = new Node('fallback'), details = new Node('details-dialog');
  document = {
    activeElement: opener,
    getElementById: (id) => nodes[id],
    createElement: () => new Node(),
    querySelectorAll: (selector) => selector === '.panel-dialog[open]' ? [nodes['data-dialog'], details].filter((node) => node.open) : [],
    querySelector: () => fallback,
  };
  const game = { id: 'example', title: 'ReSister.exe', saveDirectory: '/workspace/old', kind: 'windows' };
  let state = { games: [game] };
  const calls = { saves: [], relocate: [], state: 0, messages: [], updates: 0 };
  const behavior = {};
  const ok = (value) => Promise.resolve({ ok: true, value });
  const window = {
    AppIcons: { FolderOpen: '<svg/>', LoaderCircle: '<svg/>' },
    player: {
      saves: (id) => { calls.saves.push(id); return behavior.saves ? behavior.saves(id) : ok(true); },
      relocateData: (id) => { calls.relocate.push(id); return behavior.relocate ? behavior.relocate(id) : ok({ canceled: true }); },
      state: () => { calls.state++; return behavior.state ? behavior.state() : ok(state); },
    },
  };
  const context = vm.createContext({ window, document });
  new vm.Script(source, { filename: 'data-panel.js' }).runInContext(context);
  const hooks = {
    request: async (promise) => { const result = await promise; if (!result.ok) throw new Error(result.error); return result.value; },
    getState: () => state,
    onState: (value) => { state = value; calls.updates++; },
    message: (text, error) => calls.messages.push({ text, error }),
    showDialog: (id) => { nodes[id].open = true; },
  };
  return { panel: window.AppDataPanel, game, nodes, closeButtons, opener, fallback, details, calls, behavior, hooks, document, getState: () => state };
}

test('data panel exposes the current location and refreshes its running lock without replacing the text field', async () => {
  const h = harness(); h.details.open = true;
  assert.equal(h.panel.open(h.game, h.hooks), true);
  assert.equal(h.details.open, false, 'data panel must not leave another modal underneath');
  assert.equal(h.nodes['data-app-name'].textContent, 'ReSister');
  const textField = h.nodes['data-location-path'];
  assert.equal(textField.value, '/workspace/old');
  assert.equal(h.nodes['data-change-location'].disabled, false);
  h.game.running = true; h.panel.refresh();
  assert.equal(h.nodes['data-location-path'], textField);
  assert.equal(h.nodes['data-location-locked'].hidden, false);
  assert.equal(h.nodes['data-change-location'].disabled, true);
  assert.equal(h.nodes['data-open-location'].disabled, false, 'a running app can still reveal its files');
  await h.nodes['data-change-location'].trigger('click');
  assert.equal(h.calls.relocate.length, 0, 'a stale click must not bypass the running lock');
});

test('a pending folder choice blocks duplicate actions and dismissal, while cancellation preserves the location', async () => {
  const h = harness(); const choice = deferred();
  h.behavior.relocate = () => choice.promise;
  h.panel.open(h.game, h.hooks);
  const changing = h.nodes['data-change-location'].trigger('click');
  assert.equal(h.nodes['data-location-progress'].hidden, false);
  assert.ok(h.closeButtons.every((node) => node.disabled));
  await h.nodes['data-change-location'].trigger('click');
  assert.equal(h.calls.relocate.length, 1);
  let cancelBlocked = false, backdropBlocked = false;
  await h.nodes['data-dialog'].trigger('cancel', { preventDefault: () => { cancelBlocked = true; } });
  await h.nodes['data-dialog'].trigger('click', { target: h.nodes['data-dialog'], stopImmediatePropagation: () => { backdropBlocked = true; } });
  assert.equal(cancelBlocked, true); assert.equal(backdropBlocked, true);
  assert.equal(h.panel.open({ ...h.game, id: 'other' }, h.hooks), false);
  choice.resolve({ ok: true, value: { canceled: true } }); await changing;
  assert.equal(h.nodes['data-location-path'].value, '/workspace/old');
  assert.ok(h.closeButtons.every((node) => !node.disabled));
  assert.equal(h.nodes['data-location-progress'].hidden, true);
  assert.equal(h.calls.state, 0, 'a canceled choice does not report or refresh a migration');
});

test('a completed migration refreshes the library, displays the new location and retains the original backup path', async () => {
  const h = harness();
  h.behavior.relocate = () => Promise.resolve({ ok: true, value: { saveDirectory: '/chosen/AppBridge 数据/example', backupDirectory: '/workspace/old' } });
  h.behavior.state = () => Promise.resolve({ ok: true, value: { games: [{ ...h.game, saveDirectory: '/chosen/AppBridge 数据/example' }] } });
  h.panel.open(h.game, h.hooks);
  await h.nodes['data-change-location'].trigger('click');
  assert.equal(h.calls.updates, 1);
  assert.equal(h.nodes['data-location-path'].value, '/chosen/AppBridge 数据/example');
  assert.equal(h.nodes['data-backup-note'].hidden, false);
  assert.equal(h.nodes['data-backup-path'].textContent, '/workspace/old');
  assert.match(h.calls.messages.at(-1).text, /已切换/);
  assert.equal(h.nodes['data-dialog'].open, true, 'the result stays visible for review');
});

test('a migration error leaves the existing location usable and releases the controls', async () => {
  const h = harness();
  h.behavior.relocate = () => Promise.resolve({ ok: false, error: '目标文件夹不可写' });
  h.panel.open(h.game, h.hooks);
  await h.nodes['data-change-location'].trigger('click');
  assert.equal(h.nodes['data-location-path'].value, '/workspace/old');
  assert.equal(h.calls.updates, 0);
  assert.equal(h.calls.messages.at(-1).error, true);
  assert.equal(h.nodes['data-change-location'].disabled, false);
  assert.ok(h.closeButtons.every((node) => !node.disabled));
});

test('a library refresh failure does not misreport a finished migration or retry copying', async () => {
  const h = harness();
  h.behavior.relocate = () => Promise.resolve({ ok: true, value: { saveDirectory: '/new/location', backupDirectory: '/workspace/old' } });
  h.behavior.state = () => Promise.resolve({ ok: false, error: '资料库暂时不可读' });
  h.panel.open(h.game, h.hooks);
  await h.nodes['data-change-location'].trigger('click');
  assert.equal(h.calls.relocate.length, 1);
  assert.equal(h.nodes['data-location-path'].value, '/new/location');
  assert.match(h.calls.messages.at(-1).text, /存放位置已切换.*界面更新失败/);
  assert.equal(h.calls.messages.at(-1).error, true);
});

test('opening the existing folder uses the selected application and returns focus when the panel closes', async () => {
  const h = harness(); h.panel.open(h.game, h.hooks);
  await h.nodes['data-open-location'].trigger('click');
  assert.deepEqual(h.calls.saves, ['example']);
  assert.equal(h.calls.relocate.length, 0);
  h.document.activeElement = h.nodes['data-open-location'];
  h.nodes['data-dialog'].close();
  assert.equal(h.document.activeElement, h.opener);
  const html = fs.readFileSync(path.join(__dirname, '../src/ui.html'), 'utf8');
  assert.match(html, /<textarea\b[^>]*id="data-location-path"[^>]*\breadonly\b/);
});
