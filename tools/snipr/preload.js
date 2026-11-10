'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// In utilr every tool's channels start with its id ("snipr/snip:init"), so tools
// that share the process never hear each other. Replies from main stay plain.

const on = (channel, cb) => ipcRenderer.on(channel, (_e, ...args) => cb(...args));

contextBridge.exposeInMainWorld('snipr', {
  // settings (settings window + the gear menu in every snip)
  settings: () => ipcRenderer.invoke('snipr/settings:get'),
  setSettings: (patch) => ipcRenderer.send('snipr/settings:set', patch),
  onSettings: (cb) => on('settings:changed', cb),
  onKeyTaken: (cb) => on('settings:key-taken', cb),
  recordKey: (recording) => ipcRenderer.send('snipr/key:record', recording),
  chooseFolder: () => ipcRenderer.invoke('snipr/folder:choose'),
  openFolder: () => ipcRenderer.send('snipr/folder:open'),
  closeWindow: () => ipcRenderer.send('snipr/win:close'),
  quit: () => ipcRenderer.send('snipr/app:quit'),

  // capture overlay
  onOverlayOpen: (cb) => on('overlay:open', cb),
  onOverlayReset: (cb) => on('overlay:reset', cb),
  overlayReady: (sid) => ipcRenderer.send('snipr/overlay:ready', sid),
  overlayDone: (sid, rect) => ipcRenderer.send('snipr/overlay:done', sid, rect),
  overlayCancel: () => ipcRenderer.send('snipr/overlay:cancel'),

  // snip window
  snipInit: () => ipcRenderer.invoke('snipr/snip:init'),
  copy: (png) => ipcRenderer.invoke('snipr/snip:copy', png || null),
  copyText: (png) => ipcRenderer.invoke('snipr/snip:text', png || null),
  secure: (png, textPng) => ipcRenderer.invoke('snipr/snip:secure', png, textPng || null),
  save: (png, ask) => ipcRenderer.invoke('snipr/snip:save', png || null, !!ask),
  startDrag: (png) => ipcRenderer.send('snipr/snip:drag', png || null),
  closeSnip: () => ipcRenderer.send('snipr/snip:close'),
  newSnip: () => ipcRenderer.send('snipr/snip:new'),

  // toast
  onToast: (cb) => on('toast:show', cb),
  onToastHide: (cb) => on('toast:hide', cb),
});
