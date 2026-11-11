'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// In utilr every tool's channels start with its id ("paletr/copy"), so tools
// that share the process never hear each other. Messages from main stay plain.

const on = (channel, cb) => ipcRenderer.on(channel, (_e, ...args) => cb(...args));

contextBridge.exposeInMainWorld('paletr', {
  // overlay
  onOverlayOpen: (cb) => on('overlay:open', cb),
  onOverlayReset: (cb) => on('overlay:reset', cb),
  onOverlayPicked: (cb) => on('overlay:picked', cb),
  onOverlayFormat: (cb) => on('overlay:format', cb),
  overlayReady: (sid) => ipcRenderer.send('paletr/overlay:ready', sid),
  overlayPick: (sid, px, keep) => ipcRenderer.send('paletr/overlay:pick', sid, px, !!keep),
  overlayCancel: () => ipcRenderer.send('paletr/overlay:cancel'),
  overlayFocus: () => ipcRenderer.send('paletr/overlay:focus'),
  overlayFormat: (fmt) => ipcRenderer.send('paletr/overlay:format', fmt),

  // palette
  state: () => ipcRenderer.invoke('paletr/state:get'),
  onState: (cb) => on('state', cb),
  onKeyTaken: (cb) => on('key-taken', cb),
  pick: () => ipcRenderer.send('paletr/pick'),
  copy: (hex, fmt) => ipcRenderer.invoke('paletr/copy', hex, fmt || null),
  remove: (hex) => ipcRenderer.send('paletr/remove', hex),
  clear: () => ipcRenderer.send('paletr/clear'),
  setSettings: (patch) => ipcRenderer.send('paletr/settings:set', patch),
  recordKey: (on) => ipcRenderer.send('paletr/key:record', !!on),
  close: () => ipcRenderer.send('paletr/win:close'),
  minimize: () => ipcRenderer.send('paletr/win:minimize'),

  // toast
  onToast: (cb) => on('toast:show', cb),
  onToastHide: (cb) => on('toast:hide', cb),
});
