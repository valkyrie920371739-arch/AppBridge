'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const mainFile = path.join(__dirname, '..', 'src', 'main.cjs');
const mainSource = fs.readFileSync(mainFile, 'utf8');
const goodProbe = () => ({ ok: true, version: 'wine-11.0', stdout: 'wine-11.0\n', stderr: '' });

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// The real main module and storage run against a temporary profile. Electron and
// external processes are replaced at their boundary; no window or Wine is started.
async function harness(t, options = {}) {
  const profile = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'appbridge-main-')));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  const saveDirectory = path.join(profile, 'windows-apps', options.saveFolder || 'example');
  fs.mkdirSync(saveDirectory, { recursive: true });
  const game = {
    id: 'example', kind: 'windows', title: 'Example application',
    architecture: 'x64', exePath: options.executableInsideData ? path.join(saveDirectory, 'program', 'Example.exe') : path.join(profile, options.executableName || 'Example.exe'),
    saveDirectory, prefixPath: path.join(saveDirectory, 'prefix'),
    importedAt: new Date(0).toISOString(), lastPlayedAt: null, ...options.game,
  };
  fs.mkdirSync(path.dirname(game.exePath), { recursive: true });
  fs.writeFileSync(game.exePath, 'fixture executable: launcher is mocked');
  options.beforeLoad?.({ profile, game });
  const originalSettings = {
    wineRuntimePath: path.join(profile, 'custom Wine', 'wine'),
    wineVersion: 'wine-11.0', runtimeSource: options.runtimeSource || '手动选择',
    runtimeCheck: { ok: true, checkedAt: 'previous check' },
    customPreference: 'preserve me',
  };
  fs.writeFileSync(path.join(profile, 'settings.json'), options.settingsText ?? JSON.stringify(originalSettings));
  fs.writeFileSync(path.join(profile, 'library.json'), options.libraryText ?? JSON.stringify([game]));

  const behavior = { ...options.runtime };
  const calls = { probe: [], discover: [], launch: [], selfTest: [], display: [], openDialog: [], messageBoxes: [], command: [], scan: [], relocate: [], exits: [] };
  const ready = deferred();
  const handlers = new Map();
  const windows = [];
  const appEvents = new EventEmitter();
  class FakeWindow extends EventEmitter {
    constructor() {
      super();
      this.webContents = new EventEmitter();
      this.webContents.id = windows.length + 1;
      this.webContents.send = () => {};
      this.webContents.setWindowOpenHandler = () => {};
      windows.push(this);
    }
    isDestroyed() { return false; }
    loadFile() { return Promise.resolve(); }
  }
  const electron = {
    app: {
      getPath: (name) => name === 'home' ? path.join(profile, 'home') : profile,
      setPath: () => {}, requestSingleInstanceLock: () => true,
      getVersion: () => '0.2.0', whenReady: () => ready.promise,
      on: (...args) => appEvents.on(...args),
      exit: (code) => { calls.exits.push(code); }, quit: () => {},
    },
    BrowserWindow: FakeWindow,
    ipcMain: { on: () => {}, handle: (channel, callback) => { handlers.set(channel, callback); } },
    dialog: {
      showSaveDialog: async (...args) => behavior.showSaveDialog ? behavior.showSaveDialog(...args) : { canceled: true },
      showOpenDialog: async (...args) => {
        calls.openDialog.push(args);
        return behavior.showOpenDialog ? behavior.showOpenDialog(...args) : { canceled: true, filePaths: [] };
      },
      showMessageBox: async (...args) => { calls.messageBoxes.push(args); return behavior.showMessageBox ? behavior.showMessageBox(...args) : { response: 0 }; },
      showErrorBox: () => {},
    },
    shell: { openPath: async () => '' },
    Menu: { buildFromTemplate: (template) => template, setApplicationMenu: () => {} },
  };
  const wine = {
    runRuntimeCommand: async (...args) => { calls.command.push(args); return behavior.runRuntimeCommand ? behavior.runRuntimeCommand(...args) : { ok: true, stdout: '', stderr: '', exitCode: 0 }; },
    probeRuntime: async (...args) => {
      calls.probe.push(args);
      return behavior.probeRuntime ? behavior.probeRuntime(...args) : goodProbe();
    },
    discoverRuntime: async (...args) => {
      calls.discover.push(args);
      return behavior.discoverRuntime ? behavior.discoverRuntime(...args) : null;
    },
    launchWindowsExecutable: (...args) => {
      calls.launch.push(args);
      return behavior.launchWindowsExecutable ? behavior.launchWindowsExecutable(...args) : { pid: 1234 };
    },
    runtimeSelfTest: async (...args) => {
      calls.selfTest.push(args);
      return behavior.runtimeSelfTest ? behavior.runtimeSelfTest(...args) : { ok: true };
    },
    inspectWindowsExecutable: () => ({ architecture: 'x64', isDll: false }),
  };
  const localRequire = (name) => {
    if (name === 'electron') return electron;
    if (name === 'original-fs') return fs;
    if (name === './wine-runtime.cjs') return wine;
    if (name === './storage.cjs') return require('../src/storage.cjs');
    if (name === './workspace.cjs') return require('../src/workspace.cjs');
    if (name === './managed-import.cjs') return require('../src/managed-import.cjs');
    if (name === './game-profiles.cjs') return require('../src/game-profiles.cjs');
    if (name === './engine-profiles.cjs') return require('../src/engine-profiles.cjs');
    if (name === './engine-launch.cjs') return require('../src/engine-launch.cjs');
    if (name === './display-environment.cjs') return { prepareEmulatedDisplay: async (...args) => {
      calls.display.push(args);
      return behavior.prepareEmulatedDisplay ? behavior.prepareEmulatedDisplay(...args) : { configured: true, restarted: true };
    } };
    if (name === './core.cjs') return require('../src/core.cjs');
    if (name === './executable-icon.cjs') return require('../src/executable-icon.cjs');
    if (name === './data-location.cjs') { const real = require('../src/data-location.cjs'); return { ...real, relocateAppData: async (args) => { calls.relocate.push(args); return behavior.relocateAppData ? behavior.relocateAppData(args) : real.relocateAppData(args); } }; }
    if (name === './runtime-processes.cjs') return { scanRuntimeProcesses: async (...args) => { calls.scan.push(args); return behavior.scanRuntimeProcesses ? behavior.scanRuntimeProcesses(...args) : []; } };
    if (name === 'node:child_process') return {
      execFile: (...args) => {
        const callback = args.at(-1);
        queueMicrotask(() => callback(null, 'test host', ''));
        return new EventEmitter();
      },
    };
    return require(name);
  };
  const context = vm.createContext({
    require: localRequire, __dirname: path.dirname(mainFile), __filename: mainFile,
    module: { exports: {} }, exports: {}, Buffer, console, setTimeout, clearTimeout,
    process: {
      argv: ['node', mainFile, `--profile=${profile}`],
      platform: 'darwin', arch: 'arm64', versions: { electron: 'test-electron' },
      execPath: '/Applications/AppBridge.app/Contents/MacOS/Electron',
      resourcesPath: path.join(profile, 'resources'),
      on: () => {},
    },
  });
  new vm.Script(mainSource, { filename: mainFile }).runInContext(context);
  ready.resolve();
  // Drain startup and restore promises without imposing a real-time delay.
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.exits, [], 'startup must not exit');
  assert.equal(windows.length, 1, 'the library window must open');
  const invoke = async (channel, ...args) => {
    const handler = handlers.get(channel);
    assert.ok(handler, `missing IPC entry ${channel}`);
    return handler({ sender: windows[0].webContents }, ...args);
  };
  const state = async () => {
    const response = await invoke('player:state');
    assert.equal(response.ok, true);
    return JSON.parse(JSON.stringify(response.value));
  };
  return { profile, game, originalSettings, behavior, calls, invoke, state };
}

test('bundled display preparation runs once before launch and a rebuilt prefix prepares again', async (t) => {
  const h = await harness(t, { runtimeSource: 'bundled' });
  h.behavior.runtimeSelfTest = async () => {
    fs.mkdirSync(h.game.prefixPath, { recursive: true });
    fs.writeFileSync(path.join(h.game.prefixPath, 'system.reg'), 'fixture');
    return { ok: true };
  };
  h.behavior.launchWindowsExecutable = () => {
    assert.equal(h.calls.display.length, 1);
    return { pid: 1234 };
  };
  assert.equal((await h.invoke('player:launch', h.game.id)).ok, true);
  assert.equal(h.calls.display[0][0].prefixPath, h.game.prefixPath);
  const recordPath = path.join(h.game.saveDirectory, 'prefix-state.json');
  assert.equal(JSON.parse(fs.readFileSync(recordPath)).emulatedDisplayModes, 1);
  h.calls.launch[0][0].onExit({ ok: true });
  assert.equal((await h.invoke('player:launch', h.game.id)).ok, true);
  assert.equal(h.calls.display.length, 1);
  h.calls.launch[1][0].onExit({ ok: true });
  fs.unlinkSync(path.join(h.game.prefixPath, 'system.reg'));
  h.behavior.launchWindowsExecutable = () => ({ pid: 1234 });
  assert.equal((await h.invoke('player:launch', h.game.id)).ok, true);
  assert.equal(h.calls.display.length, 2);
});

test('display preparation failure prevents game launch and remains retryable', async (t) => {
  const h = await harness(t, { runtimeSource: 'bundled' });
  h.behavior.prepareEmulatedDisplay = async () => { throw new Error('display setup failed'); };
  assert.equal((await h.invoke('player:launch', h.game.id)).ok, false);
  assert.equal(h.calls.launch.length, 0);
  assert.equal(fs.existsSync(path.join(h.game.saveDirectory, 'prefix-state.json')), false);
  assert.equal((await h.state()).games[0].launching, false);
  h.behavior.prepareEmulatedDisplay = async () => ({ configured: true, restarted: true });
  assert.equal((await h.invoke('player:launch', h.game.id)).ok, true);
  assert.equal(h.calls.display.length, 2);
});

test('concurrent launch requests start one process and prevent entry changes or removal during detection', async (t) => {
  const h = await harness(t);
  const probe = deferred();
  h.behavior.probeRuntime = () => probe.promise;
  const first = h.invoke('player:launch', h.game.id);
  const starting = await h.state();
  assert.equal(starting.games[0].launching, true);
  assert.equal(starting.games[0].running, false);

  const second = await h.invoke('player:launch', h.game.id);
  const changeEntry = await h.invoke('player:entry', h.game.id);
  const remove = await h.invoke('player:remove', h.game.id);
  assert.equal(second.ok, false);
  assert.equal(changeEntry.ok, false);
  assert.equal(remove.ok, false);
  assert.equal(h.calls.openDialog.length, 0, 'entry selection must not open during a pending launch');
  assert.equal(h.calls.launch.length, 0, 'Wine must not launch before its check completes');

  probe.resolve(goodProbe());
  assert.equal((await first).ok, true);
  assert.equal(h.calls.launch.length, 1);
  const launch = h.calls.launch[0][0];
  assert.equal(launch.exePath, h.game.exePath);
  assert.equal(launch.prefixPath, h.game.prefixPath);
  let current = await h.state();
  assert.equal(current.games.length, 1);
  assert.equal(current.games[0].launching, false);
  assert.equal(current.games[0].running, true);
  launch.onExit({ ok: true, exitCode: 0, signal: null, error: null });
  current = await h.state();
  assert.equal(current.games[0].running, false);
  const stored = JSON.parse(fs.readFileSync(path.join(h.profile, 'library.json'), 'utf8'));
  assert.equal(stored[0].lastExit.exitCode, 0);
});

test('startup preserves a working manually selected runtime and its previous check', async (t) => {
  const h = await harness(t);
  const current = await h.state();
  assert.equal(h.calls.probe.length, 1);
  assert.equal(h.calls.probe[0][0], h.originalSettings.wineRuntimePath);
  assert.equal(h.calls.discover.length, 0, 'a valid selection must not be replaced by automatic discovery');
  assert.equal(current.runtimePath, h.originalSettings.wineRuntimePath);
  assert.equal(current.runtimeSource, '手动选择');
  assert.deepEqual(current.runtimeCheck, h.originalSettings.runtimeCheck);
  assert.equal(current.runtimeActivity, null);
  const stored = JSON.parse(fs.readFileSync(path.join(h.profile, 'settings.json'), 'utf8'));
  assert.deepEqual(stored, h.originalSettings);
});

test('corrupt settings and library files retain their originals and leave the library usable', async (t) => {
  const settingsText = '{"interrupted settings":';
  const libraryText = '[{"interrupted library":';
  const h = await harness(t, { settingsText, libraryText });
  const current = await h.state();
  assert.deepEqual(current.games, []);
  assert.equal(current.recoveryMessages.length, 2);
  const backups = fs.readdirSync(h.profile).filter((name) => name.includes('.corrupt-') && name.endsWith('.bak'));
  assert.equal(backups.length, 2);
  const settingsBackup = backups.find((name) => name.startsWith('settings.json.corrupt-'));
  const libraryBackup = backups.find((name) => name.startsWith('library.json.corrupt-'));
  assert.ok(settingsBackup);
  assert.ok(libraryBackup);
  assert.equal(fs.readFileSync(path.join(h.profile, settingsBackup), 'utf8'), settingsText);
  assert.equal(fs.readFileSync(path.join(h.profile, libraryBackup), 'utf8'), libraryText);
  assert.equal(current.runtimeActivity, null);
});

test('a failed Windows self-test records its failure and releases the settings controls', async (t) => {
  const h = await harness(t);
  const check = deferred();
  h.behavior.runtimeSelfTest = () => check.promise;
  const pending = h.invoke('player:test-runtime');
  assert.equal(typeof (await h.state()).runtimeActivity, 'string');
  assert.equal((await h.invoke('player:detect-runtime')).ok, false, 'another check must not overlap');
  assert.equal((await h.invoke('player:runtime')).ok, false, 'runtime selection must not overlap the check');

  check.resolve({ ok: false, exitCode: 1, error: 'test command failed', stderr: 'diagnostic evidence' });
  const response = await pending;
  assert.equal(response.ok, false);
  assert.match(response.error, /test command failed/);
  const current = await h.state();
  assert.equal(current.runtimeActivity, null);
  assert.equal(current.runtimeCheck.ok, false);
  assert.equal(current.runtimeCheck.stderr, 'diagnostic evidence');
  const stored = JSON.parse(fs.readFileSync(path.join(h.profile, 'settings.json'), 'utf8'));
  assert.equal(stored.runtimeCheck.error, 'test command failed');
  const cancelledSelection = await h.invoke('player:runtime');
  assert.equal(cancelledSelection.ok, true, 'settings must be usable again after the failure');
  assert.equal(cancelledSelection.value, null);
  assert.equal((await h.state()).runtimeActivity, null);
});

test('display settings accept supported modes and numeric limits, reject invalid input without writing, and lock while running', async (t) => {
  const h = await harness(t);
  const libraryFile = path.join(h.profile, 'library.json');
  const valid = [
    { mode: 'app', width: 640, height: 360, hideDock: false },
    { mode: 'windowed', width: 7680, height: 4320, hideDock: true },
    { mode: 'fullscreen', width: 1920, height: 1080, hideDock: false },
  ];
  for (const options of valid) {
    assert.equal((await h.invoke('player:display', h.game.id, options)).ok, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(libraryFile, 'utf8'))[0].display, options);
    assert.deepEqual((await h.state()).games[0].display, options);
  }
  const good = valid.at(-1);
  const invalid = [
    null, {}, { ...good, mode: 'fullscreen; invalid command' },
    { ...good, width: 639 }, { ...good, width: 7681 },
    { ...good, height: 359 }, { ...good, height: 4321 },
    { ...good, width: 1280.5 }, { ...good, width: NaN },
    { ...good, height: Infinity }, { ...good, width: '1920' },
    { ...good, height: '1080' }, { ...good, hideDock: 'true' },
  ];
  const beforeInvalid = fs.readFileSync(libraryFile, 'utf8');
  for (const options of invalid) {
    assert.equal((await h.invoke('player:display', h.game.id, options)).ok, false);
    assert.equal(fs.readFileSync(libraryFile, 'utf8'), beforeInvalid, 'invalid settings must not change the stored library');
  }
  assert.equal((await h.invoke('player:launch', h.game.id)).ok, true);
  const whileRunning = fs.readFileSync(libraryFile, 'utf8');
  assert.equal((await h.invoke('player:display', h.game.id, valid[0])).ok, false);
  assert.equal(fs.readFileSync(libraryFile, 'utf8'), whileRunning);
  assert.deepEqual((await h.state()).games[0].display, good);
  h.calls.launch[0][0].onExit({ ok: true, exitCode: 0, signal: null, error: null });
});

test('Unity display modes pass literal argument arrays and request borderless fullscreen only for fullscreen', async (t) => {
  const h = await harness(t, {
    executableName: 'Game $literal & `value`.exe', saveFolder: 'data $literal & `value`', runtimeSource: 'bundled',
  });
  fs.writeFileSync(path.join(path.dirname(h.game.exePath), 'UnityPlayer.dll'), 'Unity fixture');
  fs.mkdirSync(path.join(h.game.prefixPath, 'dosdevices'), { recursive: true });
  fs.symlinkSync('/', path.join(h.game.prefixPath, 'dosdevices', 'z:'));
  assert.equal((await h.invoke('player:compatibility', h.game.id, { engine: 'auto', graphics: 'd3d11' })).ok, true);
  const helper = path.join(h.profile, 'resources', 'runtime', 'display-helper.dylib');
  fs.mkdirSync(path.dirname(helper), { recursive: true });
  fs.writeFileSync(helper, 'native helper fixture');
  for (const mode of ['app', 'windowed', 'fullscreen']) {
    const display = { mode, width: 1600, height: 900, hideDock: true };
    assert.equal((await h.invoke('player:display', h.game.id, display)).ok, true);
    assert.equal((await h.invoke('player:launch', h.game.id)).ok, true);
    const launch = h.calls.launch.at(-1)[0];
    const expected = ['-force-d3d11', '-logFile', require('../src/engine-launch.cjs').winePath(path.join(h.game.saveDirectory, 'unity-player.log'))];
    if (mode !== 'app') expected.push('-screen-fullscreen', mode === 'fullscreen' ? '1' : '0', '-screen-width', '1600', '-screen-height', '900');
    if (mode === 'fullscreen') expected.push('-window-mode', 'borderless');
    assert.ok(Array.isArray(launch.launchArguments));
    assert.deepEqual(Array.from(launch.launchArguments), expected);
    assert.equal(launch.exePath, h.game.exePath, 'the executable path remains a literal value');
    assert.equal(launch.workingDirectory, path.dirname(h.game.exePath));
    assert.equal(launch.displayHelperPath, helper);
    assert.equal(launch.displayOptions.hideDock, true);
    assert.equal(launch.displayOptions.mode, mode === 'fullscreen' ? 'app' : mode, 'Unity fullscreen is handled by its CLI, so the helper must not toggle native fullscreen again');
    launch.onExit({ ok: true, exitCode: 0, signal: null, error: null });
  }
  assert.equal(h.calls.launch.length, 3);
});

function engineLogMapping(h, destination = '/') {
  const directory = path.join(h.game.prefixPath, 'dosdevices');
  fs.mkdirSync(directory, { recursive: true });
  fs.symlinkSync(destination, path.join(directory, 'z:'));
}

test('new Unity imports keep graphics defaults and record an unverified launch plan and exit inside app data', async (t) => {
  const h = await harness(t);
  fs.writeFileSync(path.join(path.dirname(h.game.exePath), 'UnityPlayer.dll'), 'Unity fixture');
  engineLogMapping(h);
  assert.equal((await h.invoke('player:launch', h.game.id)).ok, true);
  const invocation = h.calls.launch.at(-1)[0];
  assert.equal(invocation.launchArguments.includes('-force-d3d11'), false);
  const reportFile = path.join(h.game.saveDirectory, 'launch-plan.json');
  const report = JSON.parse(fs.readFileSync(reportFile));
  assert.equal(report.engine.id, 'unity');
  assert.equal(report.detectedEngine.confidence, 'low');
  assert.equal(report.verification, 'awaiting-application-test');
  assert.ok(report.logFiles.every((file) => path.dirname(file.path) === h.game.saveDirectory));
  invocation.onOutput({ stream: 'stderr', text: 'fixture engine output' });
  invocation.onExit({ ok: false, exitCode: 17, signal: null, error: null });
  const finished = JSON.parse(fs.readFileSync(reportFile));
  assert.equal(finished.exit.exitCode, 17);
  assert.ok(finished.finishedAt);
  assert.match(fs.readFileSync(path.join(h.game.saveDirectory, 'runtime.log'), 'utf8'), /fixture engine output/);
  assert.equal((await h.state()).games[0].running, false);
});

test('legacy Unity DX11 choices survive migration without changing new application defaults', async (t) => {
  const h = await harness(t, { game: { engine: 'Unity · Direct3D 11' }, beforeLoad: ({ game }) => fs.writeFileSync(path.join(path.dirname(game.exePath), 'UnityPlayer.dll'), 'Unity fixture') });
  assert.deepEqual((await h.state()).games[0].compatibility, { engine: 'auto', graphics: 'd3d11' });
  fs.writeFileSync(path.join(path.dirname(h.game.exePath), 'UnityPlayer.dll'), 'Unity fixture');
  engineLogMapping(h);
  assert.equal((await h.invoke('player:launch', h.game.id)).ok, true);
  assert.ok(h.calls.launch.at(-1)[0].launchArguments.includes('-force-d3d11'));
  h.calls.launch.at(-1)[0].onExit({ ok: true, exitCode: 0 });
});

test('compatibility settings reject invalid combinations and unknown Godot versions without changing saved choices', async (t) => {
  const h = await harness(t);
  assert.equal((await h.invoke('player:compatibility', h.game.id, { engine: 'unity', graphics: 'd3d11' })).ok, true);
  const before = fs.readFileSync(path.join(h.profile, 'library.json'), 'utf8');
  for (const value of [null, [], {}, { engine: '../unreal', graphics: 'auto' }, { engine: 'auto', graphics: 'd3d11' }, { engine: 'godot', graphics: 'opengl' }]) {
    assert.equal((await h.invoke('player:compatibility', h.game.id, value)).ok, false);
    assert.equal(fs.readFileSync(path.join(h.profile, 'library.json'), 'utf8'), before);
  }
  const state = await h.state();
  assert.equal(state.games[0].compatibilityInfo.engineName, 'Unity');
  assert.match(state.games[0].compatibilityInfo.note, /待实际程序验证/);
});

test('manual Unreal preset affects only the selected app and records literal display and log arguments', async (t) => {
  const h = await harness(t);
  engineLogMapping(h);
  assert.equal((await h.invoke('player:compatibility', h.game.id, { engine: 'unreal', graphics: 'd3d11' })).ok, true);
  assert.equal((await h.invoke('player:display', h.game.id, { mode: 'windowed', width: 1366, height: 768, hideDock: false })).ok, true);
  assert.equal((await h.invoke('player:launch', h.game.id)).ok, true);
  const invocation = h.calls.launch.at(-1)[0];
  assert.deepEqual(Array.from(invocation.launchArguments), ['-dx11', `-ABSLOG=${require('../src/engine-launch.cjs').winePath(path.join(h.game.saveDirectory, 'unreal-player.log'))}`, '-windowed', '-ResX=1366', '-ResY=768']);
  assert.equal(invocation.exePath, h.game.exePath);
  assert.equal((await h.invoke('player:compatibility', h.game.id, { engine: 'auto', graphics: 'auto' })).ok, false);
  invocation.onExit({ ok: true, exitCode: 0 });
  const output = path.join(h.profile, 'export.json');
  h.behavior.showSaveDialog = async () => ({ canceled: false, filePath: output });
  assert.equal((await h.invoke('player:export-log')).ok, true);
  const exported = JSON.parse(fs.readFileSync(output));
  assert.equal(JSON.parse(exported.apps[0].launchPlan).engine.id, 'unreal');
  assert.equal(exported.apps[0].unrealLog, null, 'Shipping builds may omit an engine log');
});

test('redirected engine log mapping fails before game launch and remains retryable', async (t) => {
  const h = await harness(t);
  fs.writeFileSync(path.join(path.dirname(h.game.exePath), 'UnityPlayer.dll'), 'Unity fixture');
  engineLogMapping(h, h.profile);
  const result = await h.invoke('player:launch', h.game.id);
  assert.equal(result.ok, false);
  assert.match(result.error, /Z:/);
  assert.equal(h.calls.launch.length, 0);
  assert.equal((await h.state()).games[0].launching, false);
  fs.unlinkSync(path.join(h.game.prefixPath, 'dosdevices', 'z:'));
  fs.symlinkSync('/', path.join(h.game.prefixPath, 'dosdevices', 'z:'));
  assert.equal((await h.invoke('player:launch', h.game.id)).ok, true);
  h.calls.launch.at(-1)[0].onExit({ ok: true, exitCode: 0 });
});

test('compatibility save rechecks a launch that starts while process inspection is pending', async (t) => {
  const h = await harness(t);
  fs.mkdirSync(h.game.prefixPath, { recursive: true });
  const inspection = deferred();
  const probe = deferred();
  let scans = 0;
  h.behavior.scanRuntimeProcesses = () => ++scans === 1 ? inspection.promise : [];
  h.behavior.probeRuntime = () => probe.promise;
  const changing = h.invoke('player:compatibility', h.game.id, { engine: 'unreal', graphics: 'd3d11' });
  await new Promise((resolve) => setImmediate(resolve));
  const starting = h.invoke('player:launch', h.game.id);
  await new Promise((resolve) => setImmediate(resolve));
  inspection.resolve([]);
  assert.equal((await changing).ok, false);
  assert.equal((await h.state()).games[0].compatibility, undefined);
  probe.resolve(goodProbe());
  assert.equal((await starting).ok, true);
  h.calls.launch.at(-1)[0].onExit({ ok: true, exitCode: 0 });
});

test('automatic renderer choices recover when new engine evidence replaces the previous Unity layout', async (t) => {
  const h = await harness(t);
  const dll = path.join(path.dirname(h.game.exePath), 'UnityPlayer.dll');
  fs.writeFileSync(dll, 'Unity fixture');
  assert.equal((await h.invoke('player:compatibility', h.game.id, { engine: 'auto', graphics: 'd3d11' })).ok, true);
  fs.unlinkSync(dll);
  const pck = Buffer.alloc(20);
  pck.write('GDPC'); pck.writeUInt32LE(2, 4); pck.writeUInt32LE(4, 8); pck.writeUInt32LE(2, 12);
  fs.writeFileSync(h.game.exePath.replace(/\.exe$/i, '.pck'), pck);
  assert.equal((await h.invoke('player:launch', h.game.id)).ok, true);
  const game = (await h.state()).games[0];
  assert.equal(game.engineProfile.id, 'godot');
  assert.deepEqual(game.compatibility, { engine: 'auto', graphics: 'auto' });
  assert.match(game.compatibilityNotice, /已恢复自动适配/);
  assert.deepEqual(Array.from(h.calls.launch.at(-1)[0].launchArguments), []);
  h.calls.launch.at(-1)[0].onExit({ ok: true, exitCode: 0 });
});

test('invalid new entries do not leave half-updated titles, paths or engine profiles in memory or on disk', async (t) => {
  const h = await harness(t);
  const before = (await h.state()).games[0];
  const target = path.join(h.profile, 'target.exe');
  const link = path.join(h.profile, 'redirected.exe');
  fs.writeFileSync(target, 'target fixture'); fs.symlinkSync(target, link);
  h.behavior.showOpenDialog = async () => ({ canceled: false, filePaths: [link] });
  const saved = fs.readFileSync(path.join(h.profile, 'library.json'), 'utf8');
  assert.equal((await h.invoke('player:entry', h.game.id)).ok, false);
  const after = (await h.state()).games[0];
  assert.equal(after.exePath, before.exePath);
  assert.equal(after.title, before.title);
  assert.deepEqual(after.engineProfile, before.engineProfile);
  assert.equal(fs.readFileSync(path.join(h.profile, 'library.json'), 'utf8'), saved);
});

test('entry selection rechecks activity after the file dialog and never edits a running application', async (t) => {
  const h = await harness(t);
  const selection = deferred(); const probe = deferred();
  h.behavior.showOpenDialog = () => selection.promise;
  h.behavior.probeRuntime = () => probe.promise;
  const choosing = h.invoke('player:entry', h.game.id);
  await new Promise((resolve) => setImmediate(resolve));
  const starting = h.invoke('player:launch', h.game.id);
  await new Promise((resolve) => setImmediate(resolve));
  selection.resolve({ canceled: false, filePaths: [path.join(h.profile, 'different.exe')] });
  assert.equal((await choosing).ok, false);
  assert.equal((await h.state()).games[0].exePath, h.game.exePath);
  probe.resolve(goodProbe()); assert.equal((await starting).ok, true);
  h.calls.launch.at(-1)[0].onExit({ ok: true, exitCode: 0 });
  h.behavior.scanRuntimeProcesses = () => [{ kind: 'application' }];
  fs.mkdirSync(h.game.prefixPath, { recursive: true });
  const dialogs = h.calls.openDialog.length;
  assert.equal((await h.invoke('player:entry', h.game.id)).ok, false);
  assert.equal(h.calls.openDialog.length, dialogs);
});

test('failed library writes roll back both compatibility choices and selected entries in memory', async (t) => {
  const h = await harness(t);
  const libraryPath = path.join(h.profile, 'library.json');
  const original = fs.readFileSync(libraryPath, 'utf8');
  fs.renameSync(libraryPath, libraryPath + '.previous'); fs.mkdirSync(libraryPath);
  const before = (await h.state()).games[0];
  assert.equal((await h.invoke('player:compatibility', h.game.id, { engine: 'unreal', graphics: 'd3d11' })).ok, false);
  const alternate = path.join(h.profile, 'alternate.exe'); fs.writeFileSync(alternate, 'fixture');
  h.behavior.showOpenDialog = async () => ({ canceled: false, filePaths: [alternate] });
  assert.equal((await h.invoke('player:entry', h.game.id)).ok, false);
  const after = (await h.state()).games[0];
  assert.deepEqual(after.compatibility, before.compatibility);
  assert.equal(after.exePath, before.exePath);
  assert.equal(after.title, before.title);
  assert.deepEqual(after.engineProfile, before.engineProfile);
  assert.equal(fs.readFileSync(libraryPath + '.previous', 'utf8'), original);
});


test('changing data location copies and rebases the complete private application, preserving the original', async (t) => {
  const h = await harness(t, { executableInsideData: true });
  fs.mkdirSync(h.game.prefixPath, { recursive: true });
  fs.writeFileSync(path.join(h.game.prefixPath, 'system.reg'), 'fixture registry');
  fs.writeFileSync(path.join(h.game.saveDirectory, 'slot1.sav'), 'saved progress');
  const parent = path.join(h.profile, 'selected data location'); fs.mkdirSync(parent);
  h.behavior.showOpenDialog = async () => ({ canceled: false, filePaths: [parent] });
  const result = await h.invoke('player:relocate-data', h.game.id);
  assert.equal(result.ok, true, result.error);
  const game = (await h.state()).games[0];
  const destination = path.join(parent, 'AppBridge 数据', h.game.id);
  assert.equal(game.saveDirectory, destination);
  assert.equal(game.prefixPath, path.join(destination, 'prefix'));
  assert.equal(game.exePath, path.join(destination, 'program', 'Example.exe'));
  assert.equal(game.dataRoot, path.join(parent, 'AppBridge 数据'));
  assert.equal(fs.readFileSync(path.join(destination, 'slot1.sav'), 'utf8'), 'saved progress');
  assert.equal(fs.readFileSync(path.join(h.game.saveDirectory, 'slot1.sav'), 'utf8'), 'saved progress');
  assert.equal((await h.invoke('player:launch', h.game.id)).ok, true, 'relocated prefix is allowed to launch outside the default profile root');
});

test('data relocation cancellation and running processes cannot change the library or invoke copy', async (t) => {
  const h = await harness(t);
  const before = fs.readFileSync(path.join(h.profile, 'library.json'), 'utf8');
  assert.equal((await h.invoke('player:relocate-data', h.game.id)).value.canceled, true);
  assert.equal(h.calls.relocate.length, 0);
  fs.mkdirSync(h.game.prefixPath, { recursive: true });
  h.behavior.scanRuntimeProcesses = async () => [{ pid: 42, name: 'Example.exe', kind: 'application' }];
  const dialogCount = h.calls.openDialog.length;
  assert.equal((await h.invoke('player:relocate-data', h.game.id)).ok, false);
  assert.equal(h.calls.openDialog.length, dialogCount);
  assert.equal(h.calls.relocate.length, 0);
  assert.equal(fs.readFileSync(path.join(h.profile, 'library.json'), 'utf8'), before);
  assert.equal((await h.state()).games[0].relocating, false);
});

test('idle Wine services are stopped and checked again before data is copied', async (t) => {
  const h = await harness(t);
  fs.mkdirSync(h.game.prefixPath, { recursive: true });
  const parent = path.join(h.profile, 'chosen'); fs.mkdirSync(parent);
  h.behavior.showOpenDialog = async () => ({ canceled: false, filePaths: [parent] });
  let scans = 0;
  h.behavior.scanRuntimeProcesses = async () => ++scans <= 2 ? [{ pid: 1, name: 'services.exe', kind: 'service' }] : [];
  assert.equal((await h.invoke('player:relocate-data', h.game.id)).ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls.command.map((call) => call[1]))), [['-k'], ['-w']]);
  assert.ok(scans >= 4);
});

test('a failed library commit restores the old application location and the source data', async (t) => {
  const h = await harness(t);
  fs.writeFileSync(path.join(h.game.saveDirectory, 'slot1.sav'), 'saved progress');
  const parent = path.join(h.profile, 'chosen'); fs.mkdirSync(parent);
  h.behavior.showOpenDialog = async () => ({ canceled: false, filePaths: [parent] });
  h.behavior.relocateAppData = async (options) => {
    // Force the real atomic storage operation to reject its target type.
    fs.unlinkSync(path.join(h.profile, 'library.json'));
    fs.mkdirSync(path.join(h.profile, 'library.json'));
    return require('../src/data-location.cjs').relocateAppData(options);
  };
  assert.equal((await h.invoke('player:relocate-data', h.game.id)).ok, false);
  assert.equal((await h.state()).games[0].saveDirectory, h.game.saveDirectory);
  assert.equal(fs.readFileSync(path.join(h.game.saveDirectory, 'slot1.sav'), 'utf8'), 'saved progress');
  assert.equal(fs.existsSync(path.join(parent, 'AppBridge 数据', h.game.id)), false);
});


test('data copying locks launch, display, entry and removal until the operation finishes', async (t) => {
  const h = await harness(t);
  const parent = path.join(h.profile, 'chosen'); fs.mkdirSync(parent);
  h.behavior.showOpenDialog = async () => ({ canceled: false, filePaths: [parent] });
  const entered = deferred(), completion = deferred();
  h.behavior.relocateAppData = () => { entered.resolve(); return completion.promise; };
  const changing = h.invoke('player:relocate-data', h.game.id);
  await entered.promise;
  assert.equal((await h.state()).games[0].relocating, true);
  for (const channel of ['player:launch', 'player:entry', 'player:remove']) assert.equal((await h.invoke(channel, h.game.id)).ok, false, channel);
  assert.equal((await h.invoke('player:display', h.game.id, {mode:'app',width:1280,height:720,hideDock:true})).ok, false);
  completion.reject(new Error('copy canceled by test fixture'));
  assert.equal((await changing).ok, false);
  assert.equal((await h.state()).games[0].relocating, false);
});

test('a Windows process left by an earlier launcher blocks duplicate launch and display edits', async (t) => {
  const h = await harness(t);
  fs.mkdirSync(h.game.prefixPath, { recursive: true });
  h.behavior.scanRuntimeProcesses = async () => [{pid:42,name:'Example.exe',kind:'application'}];
  assert.equal((await h.invoke('player:launch', h.game.id)).ok, false);
  assert.equal(h.calls.launch.length, 0);
  assert.equal((await h.state()).games[0].running, true);
  assert.equal((await h.invoke('player:display', h.game.id, {mode:'app',width:1280,height:720,hideDock:true})).ok, false);
  h.behavior.scanRuntimeProcesses = async () => [];
  assert.equal((await h.invoke('player:display', h.game.id, {mode:'app',width:1280,height:720,hideDock:true})).ok, true);
  assert.equal((await h.state()).games[0].running, false);
});
