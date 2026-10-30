'use strict';

const { contextBridge, ipcRenderer, shell } = require('electron');
const { createRequire } = require('node:module');
const path = require('node:path');

// The main process resolves the selected game's imported archive and profile.
const gameContext = ipcRenderer.sendSync('player:game-context');
if (
  !gameContext ||
  typeof gameContext.archivePath !== 'string' ||
  !path.isAbsolute(gameContext.archivePath) ||
  typeof gameContext.saveDirectory !== 'string' ||
  !path.isAbsolute(gameContext.saveDirectory)
) {
  throw new Error('播放器没有提供有效的游戏归档和存档目录。');
}

// Resolve the dependencies shipped with the game without executing its main.js.
const gameRequire = createRequire(path.join(gameContext.archivePath, 'package.json'));
const syncChannels = new Set([
  'getAppPath',
  'getProcess',
  'doubleCheck',
  'showSelectFileDialog',
  'showSaveDialog',
]);
const eventChannels = new Set(['asynchronous-message']);

function checkChannel(allowed, channel) {
  if (typeof channel !== 'string' || !allowed.has(channel)) {
    throw new Error('游戏请求了未开放的通信通道。');
  }
}

function listen(channel, callback) {
  checkChannel(eventChannels, channel);
  if (typeof callback !== 'function') {
    throw new TypeError('游戏事件回调必须是函数。');
  }
  // Electron events contain privileged objects and must stay in this context.
  const listener = (_event, ...args) => callback({}, ...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const ipcBridge = {
  sendSync(channel, ...args) {
    checkChannel(syncChannels, channel);
    return ipcRenderer.sendSync(channel, ...args);
  },
  on(channel, callback) {
    return listen(channel, callback);
  },
};

// These names mirror this archive's original preload.js exactly. Newer Electron
// requires the IPC wrapper above instead of exposing ipcRenderer itself.
contextBridge.exposeInMainWorld('studio_api', {
  fs: gameRequire('fs-extra'),
  fs_default: require('node:fs'),
  shell: {
    openExternal(url) {
      if (typeof url !== 'string') {
        throw new TypeError('外部链接必须是字符串。');
      }
      const parsed = new URL(url);
      if (!['https:', 'http:', 'mailto:'].includes(parsed.protocol)) {
        throw new Error('播放器只允许打开网页或邮件链接。');
      }
      return shell.openExternal(url);
    },
  },
  path,
  asar: gameRequire('asar'),
  admzip: gameRequire('adm-zip'),
  csv_parse: gameRequire('csv-parse'),
  csv_stringify: gameRequire('csv-stringify'),
  ipcRenderer: ipcBridge,
  handleMainEvent(callback) {
    return listen('asynchronous-message', callback);
  },
});
