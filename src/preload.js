'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const on = (channel, cb) => ipcRenderer.on(channel, (_e, ...args) => cb(...args));

contextBridge.exposeInMainWorld('snipr', {
  // settings (settings window + the gear menu in every snip)
  settings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.send('settings:set', patch),
  onSettings: (cb) => on('settings:changed', cb),
  onKeyTaken: (cb) => on('settings:key-taken', cb),
  recordKey: (recording) => ipcRenderer.send('key:record', recording),
  chooseFolder: () => ipcRenderer.invoke('folder:choose'),
  openFolder: () => ipcRenderer.send('folder:open'),
  closeWindow: () => ipcRenderer.send('win:close'),
  quit: () => ipcRenderer.send('app:quit'),

  // capture overlay
  onOverlayOpen: (cb) => on('overlay:open', cb),
  onOverlayReset: (cb) => on('overlay:reset', cb),
  overlayReady: (sid) => ipcRenderer.send('overlay:ready', sid),
  overlayDone: (sid, rect) => ipcRenderer.send('overlay:done', sid, rect),
  overlayCancel: () => ipcRenderer.send('overlay:cancel'),

  // snip window
  snipInit: () => ipcRenderer.invoke('snip:init'),
  copy: (png) => ipcRenderer.invoke('snip:copy', png || null),
  copyText: (png) => ipcRenderer.invoke('snip:text', png || null),
  secure: (png, textPng) => ipcRenderer.invoke('snip:secure', png, textPng || null),
  save: (png, ask) => ipcRenderer.invoke('snip:save', png || null, !!ask),
  startDrag: (png) => ipcRenderer.send('snip:drag', png || null),
  closeSnip: () => ipcRenderer.send('snip:close'),
  newSnip: () => ipcRenderer.send('snip:new'),

  // toast
  onToast: (cb) => on('toast:show', cb),
  onToastHide: (cb) => on('toast:hide', cb),
});
