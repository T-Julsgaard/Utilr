'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// In utilr every tool's channels start with its id ("notr/note:init"), so tools
// that share the process never hear each other. Replies from main stay plain.

contextBridge.exposeInMainWorld('notr', {
  init: () => ipcRenderer.invoke('notr/note:init'),
  update: (patch) => ipcRenderer.send('notr/note:update', patch),
  newNote: () => ipcRenderer.send('notr/note:new'),
  closeNote: () => ipcRenderer.send('notr/note:close'),
  save: () => ipcRenderer.send('notr/note:save'),
  openSaved: (id) => ipcRenderer.send('notr/note:open', id),
  cycle: (dir) => ipcRenderer.send('notr/note:cycle', dir),
  setSettings: (patch) => ipcRenderer.send('notr/settings:set', patch),
  edit: (cmd) => ipcRenderer.send('notr/edit', cmd),
  kbdStart: (mode, dir) => ipcRenderer.send('notr/kbd:start', mode, dir),
  kbdStop: (dir) => ipcRenderer.send('notr/kbd:stop', dir || null),
  quit: () => ipcRenderer.send('notr/app:quit'),
  onSettings: (cb) => ipcRenderer.on('settings:changed', (_e, s) => cb(s)),
  onFocusEditor: (cb) => ipcRenderer.on('note:focus-editor', () => cb()),
  onTabs: (cb) => ipcRenderer.on('tabs:changed', (_e, tabs) => cb(tabs)),
});
