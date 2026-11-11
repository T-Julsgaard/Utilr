'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// In utilr every tool's channels start with its id ("findr/search"), so tools
// that share the process never hear each other. Messages from main stay plain.

const on = (channel, cb) => ipcRenderer.on(channel, (_e, ...args) => cb(...args));

contextBridge.exposeInMainWorld('findr', {
  search: (q) => ipcRenderer.invoke('findr/search', String(q || '')),
  open: (i, how) => ipcRenderer.invoke('findr/open', i, how),     // how: open | folder | copy
  details: (i) => ipcRenderer.invoke('findr/details', i),
  forget: (i) => ipcRenderer.send('findr/forget', i),
  rescan: () => ipcRenderer.send('findr/rescan'),
  hide: () => ipcRenderer.send('findr/hide'),

  settings: () => ipcRenderer.invoke('findr/settings:get'),
  setSettings: (patch) => ipcRenderer.send('findr/settings:set', patch),
  recordKey: (recording) => ipcRenderer.send('findr/key:record', !!recording),

  onShow: (cb) => on('popup:show', cb),
  onHide: (cb) => on('popup:hide', cb),
  onStatus: (cb) => on('index:status', cb),
  onSettings: (cb) => on('settings:changed', cb),
  onKeyTaken: (cb) => on('settings:key-taken', cb),
});
