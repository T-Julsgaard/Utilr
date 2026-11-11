'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// In utilr every tool's channels start with its id ("measr/settings:get"), so
// tools that share the process never hear each other. Replies from main stay plain.

const on = (channel, cb) => ipcRenderer.on(channel, (_e, ...args) => cb(...args));

contextBridge.exposeInMainWorld('measr', {
  // settings (settings window + the overlay's right-click menu)
  settings: () => ipcRenderer.invoke('measr/settings:get'),
  setSettings: (patch) => ipcRenderer.send('measr/settings:set', patch),
  onSettings: (cb) => on('settings:changed', cb),
  onKeyTaken: (cb) => on('settings:key-taken', cb),
  recordKey: (recording) => ipcRenderer.send('measr/key:record', recording),
  closeWindow: () => ipcRenderer.send('measr/win:close'),

  // overlay
  onOpen: (cb) => on('overlay:open', cb),
  onReset: (cb) => on('overlay:reset', cb),
  ready: (sid) => ipcRenderer.send('measr/overlay:ready', sid),
  focus: () => ipcRenderer.send('measr/overlay:focus'),
  close: (notice) => ipcRenderer.send('measr/overlay:close', notice || null),
  copyText: (text) => ipcRenderer.invoke('measr/copy:text', text),
  copyPng: (png) => ipcRenderer.invoke('measr/copy:png', png),

  // toast
  onToast: (cb) => on('toast:show', cb),
  onToastHide: (cb) => on('toast:hide', cb),
});
