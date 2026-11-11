'use strict';

// utilr's own state: one JSON file in %APPDATA%\utilr (tools keep theirs in
// %APPDATA%\utilr\tools\<id>). Written the way notr and snipr write theirs:
// to a .tmp first, the previous version kept as .bak.

const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const Keys = require('./keys');

const VERSION = 1;
const MAX_PINNED = 8;           // 1–8 open a tool in the quick view
const PLACES = ['center', 'cursor', 'left', 'right'];

const file = () => path.join(app.getPath('userData'), 'utilr.json');

// installed: tool ids, in the order they were installed
// pinned:    tool ids on the quick view, top to bottom
// keys:      utilr's own system-wide keys (quick view, open utilr); '' = none
// quickAt:   where the quick view appears
// startup:   start (in the tray) when you log in
const defaults = () => ({
  version: VERSION,
  installed: [],
  pinned: [],
  keys: { ...Keys.DEFAULTS },
  quickAt: 'center',
  startup: true,
});

let state = defaults();
let timer = null;
let fresh = true; // no utilr.json yet: the very first start

function load() {
  for (const f of [file(), file() + '.bak']) {
    try {
      const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (!raw || typeof raw !== 'object') continue;
      fresh = false;
      const d = defaults();
      const ids = (a) => (Array.isArray(a) ? [...new Set(a.filter((x) => typeof x === 'string'))] : []);
      state = {
        ...d,
        ...raw,
        version: VERSION,
        installed: ids(raw.installed),
        pinned: ids(raw.pinned).slice(0, MAX_PINNED),
        keys: { ...d.keys, ...(raw.keys || {}) },
      };
      for (const k of Object.keys(d.keys)) {
        const v = state.keys[k];
        state.keys[k] = v === '' ? '' : Keys.normalize(v) || d.keys[k];
      }
      if (!PLACES.includes(state.quickAt)) state.quickAt = d.quickAt;
      state.startup = state.startup !== false;
      return state;
    } catch (_) { /* missing or unreadable: try the next one */ }
  }
  return state;
}

function saveNow() {
  clearTimeout(timer);
  timer = null;
  const f = file();
  const json = JSON.stringify(state, null, 1);
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    if (fs.existsSync(f)) { try { fs.copyFileSync(f, f + '.bak'); } catch (_) {} }
    fs.writeFileSync(f + '.tmp', json, 'utf8');
    try { fs.renameSync(f + '.tmp', f); } catch (_) { fs.writeFileSync(f, json, 'utf8'); }
  } catch (err) {
    console.error('utilr: could not save', err);
  }
}

const save = () => { clearTimeout(timer); timer = setTimeout(saveNow, 250); };

module.exports = { load, save, saveNow, get: () => state, fresh: () => fresh, MAX_PINNED, PLACES };
