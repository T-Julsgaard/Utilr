'use strict';

// The launcher and the quick view talk to utilr through this, and only this.
// Tools have their own preloads, with their own "<id>/" channels.

const { contextBridge, ipcRenderer } = require('electron');

const send = (ch, ...a) => ipcRenderer.send('utilr/' + ch, ...a);
const invoke = (ch, ...a) => ipcRenderer.invoke('utilr/' + ch, ...a);
const on = (ch, cb) => ipcRenderer.on(ch, (_e, ...a) => cb(...a));

contextBridge.exposeInMainWorld('utilr', {
  state: () => invoke('state'),
  onState: (cb) => on('utilr:state', cb),

  // tools
  open: (id) => send('open', id),
  pin: (id, on) => send('pin', id, on),
  movePin: (id, dir) => send('pin:move', id, dir),

  // keys
  setKey: (owner, keyId, combo) => invoke('key:set', owner, keyId, combo),
  recordKeys: (on) => send('key:record', on),

  // utilr
  setSettings: (patch) => send('settings', patch),
  previewQuick: () => send('quick:preview'),
  openData: () => send('data'),
  close: () => send('close'),
  minimize: () => send('minimize'),
  quit: () => send('quit'),
  onTab: (cb) => on('utilr:tab', cb),

  // quick view
  onShow: (cb) => on('quick:show', cb),
  hideQuick: () => send('quick:hide'),
  openLauncher: (tab) => send('launcher', tab || null),
});
