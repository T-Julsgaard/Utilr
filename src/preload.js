'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('notr', {
  init: () => ipcRenderer.invoke('note:init'),
  update: (patch) => ipcRenderer.send('note:update', patch),
  newNote: () => ipcRenderer.send('note:new'),
  closeNote: () => ipcRenderer.send('note:close'),
  save: () => ipcRenderer.send('note:save'),
  openSaved: (id) => ipcRenderer.send('note:open', id),
  cycle: (dir) => ipcRenderer.send('note:cycle', dir),
  setSettings: (patch) => ipcRenderer.send('settings:set', patch),
  edit: (cmd) => ipcRenderer.send('edit', cmd),
  kbdStart: (mode, dir) => ipcRenderer.send('kbd:start', mode, dir),
  kbdStop: (dir) => ipcRenderer.send('kbd:stop', dir || null),
  quit: () => ipcRenderer.send('app:quit'),
  onSettings: (cb) => ipcRenderer.on('settings:changed', (_e, s) => cb(s)),
  onFocusEditor: (cb) => ipcRenderer.on('note:focus-editor', () => cb()),
  onTabs: (cb) => ipcRenderer.on('tabs:changed', (_e, tabs) => cb(tabs)),
});
