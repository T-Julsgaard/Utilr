'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// In utilr every tool's channels start with its id ("clipr/list"), so tools
// that share the process never hear each other. Messages from main stay plain.

const on = (channel, cb) => ipcRenderer.on(channel, (_e, ...args) => cb(...args));

contextBridge.exposeInMainWorld('clipr', {
  list: (q) => ipcRenderer.invoke('clipr/list', String(q || '')),
  pick: (id, mode) => ipcRenderer.invoke('clipr/pick', id, mode),
  remove: (id) => ipcRenderer.send('clipr/remove', id),
  clear: () => ipcRenderer.send('clipr/clear'),
  hide: () => ipcRenderer.send('clipr/hide'),

  settings: () => ipcRenderer.invoke('clipr/settings:get'),
  setSettings: (patch) => ipcRenderer.send('clipr/settings:set', patch),
  recordKey: (recording) => ipcRenderer.send('clipr/key:record', !!recording),

  onShow: (cb) => on('popup:show', cb),
  onHide: (cb) => on('popup:hide', cb),
  onChanged: (cb) => on('clips:changed', cb),
  onSettings: (cb) => on('settings:changed', cb),
  onKeyTaken: (cb) => on('settings:key-taken', cb),
});
