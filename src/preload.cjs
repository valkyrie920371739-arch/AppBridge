'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('player', {
  state: () => ipcRenderer.invoke('player:state'),
  importGame: () => ipcRenderer.invoke('player:import'),
  launch: (id) => ipcRenderer.invoke('player:launch', id),
  saves: (id) => ipcRenderer.invoke('player:saves', id),
  relocateData: (id) => ipcRenderer.invoke('player:relocate-data', id),
  remove: (id) => ipcRenderer.invoke('player:remove', id),
  exportLog: () => ipcRenderer.invoke('player:export-log'),
  runtime: () => ipcRenderer.invoke('player:runtime'),
  detectRuntime: () => ipcRenderer.invoke('player:detect-runtime'),
  testRuntime: () => ipcRenderer.invoke('player:test-runtime'),
  entry: (id) => ipcRenderer.invoke('player:entry', id),
  display: (id, options) => ipcRenderer.invoke('player:display', id, options),
  workspace: (section = 'root') => ipcRenderer.invoke('player:workspace', section),
  onChange: (callback) => ipcRenderer.on('player:changed', (_event, state) => callback(state)),
});
