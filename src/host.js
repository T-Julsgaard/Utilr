'use strict';

// The tool host. Every folder in tools/ with a tool.json is a tool. Its code
// is only loaded once it's installed, so a tool you don't use costs nothing.
//
// A tool's main.js exports one function, (host) => tool:
//
//   host   { id, name, version, dir, dataDir, ipc, shortcuts, log, changed }
//            ipc        ipcMain, but every channel is "<id>/<channel>", so two
//                       tools can both have "settings:set" (their preloads
//                       send with the same prefix)
//            shortcuts  globalShortcut, but shared fairly (see shortcuts.js)
//            dataDir    %APPDATA%\utilr\tools\<id>, made before start()
//            changed()  "my keys or actions changed": the launcher refreshes
//
//   tool   { start(), stop(), open(), actions(), keys(), setKey(id, combo) }
//            start()    load state, register keys, warm up windows; no UI
//            stop()     save, close every window, let go of every key
//            open()     the main thing (quick view tile, tray click)
//            actions()  [{ id, label, run }]         tray menu, launcher
//            keys()     [{ id, label, combo, ok }]   system-wide keys
//            setKey()   -> { ok } or { ok: false, error }

const { app, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const Shortcuts = require('./shortcuts');

const TOOLS_DIR = path.join(__dirname, '..', 'tools');

let log = () => {};
let onChange = () => {};
const running = new Map(); // id -> { tool, ipc: [channels] }

// ---------------------------------------------------------------------------
// catalog
// ---------------------------------------------------------------------------

let catalog = null;
function list() {
  if (catalog) return catalog;
  catalog = [];
  let dirs = [];
  try { dirs = fs.readdirSync(TOOLS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch (_) {}
  for (const d of dirs) {
    const dir = path.join(TOOLS_DIR, d.name);
    try {
      const m = JSON.parse(fs.readFileSync(path.join(dir, 'tool.json'), 'utf8'));
      if (!m.id || m.id !== d.name) continue;
      let glyph = '';
      try { glyph = fs.readFileSync(path.join(dir, m.glyph || 'glyph.svg'), 'utf8').trim(); } catch (_) {}
      catalog.push({
        id: m.id,
        name: m.name || m.id,
        version: m.version || '0.0.0',
        description: m.description || '',
        order: Number.isFinite(m.order) ? m.order : 99,
        platforms: Array.isArray(m.platforms) ? m.platforms : null,
        import: m.import || null,
        glyph,
        dir,
        main: path.join(dir, m.main || 'main.js'),
      });
    } catch (err) {
      log(`tool ${d.name}: no usable tool.json (${err.message})`);
    }
  }
  catalog = catalog
    .filter((t) => !t.platforms || t.platforms.includes(process.platform))
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  return catalog;
}

const find = (id) => list().find((t) => t.id === id) || null;
const dataDir = (id) => path.join(app.getPath('userData'), 'tools', id);

// ---------------------------------------------------------------------------
// first install: bring the data of the stand-alone app along
// (tool.json "import": { "from": "notr", "files": ["notr-state.json"] })
// ---------------------------------------------------------------------------

function importOld(meta, dir) {
  const imp = meta.import;
  if (!imp || !imp.from || !Array.isArray(imp.files)) return false;
  const from = path.join(app.getPath('appData'), imp.from);
  let any = false;
  for (const name of imp.files) {
    const src = path.join(from, name), dst = path.join(dir, name);
    try {
      if (fs.existsSync(dst) || !fs.existsSync(src)) continue;
      fs.copyFileSync(src, dst);
      any = true;
    } catch (err) {
      log(`${meta.id}: could not import ${name}: ${err.message}`);
    }
  }
  if (any) log(`${meta.id}: brought over the data from ${from}`);
  return any;
}

// ---------------------------------------------------------------------------
// start / stop
// ---------------------------------------------------------------------------

function scopedIpc(id, channels) {
  const ch = (c) => {
    const full = `${id}/${c}`;
    channels.add(full);
    return full;
  };
  return {
    on: (c, fn) => ipcMain.on(ch(c), fn),
    once: (c, fn) => ipcMain.once(ch(c), fn),
    handle: (c, fn) => ipcMain.handle(ch(c), fn),
    removeHandler: (c) => ipcMain.removeHandler(`${id}/${c}`),
    removeAllListeners: (c) => ipcMain.removeAllListeners(`${id}/${c}`),
  };
}

function start(id, { firstRun = false } = {}) {
  if (running.has(id)) return { ok: true };
  const meta = find(id);
  if (!meta) return { ok: false, error: 'not found' };
  const dir = dataDir(id);
  const t0 = Date.now();
  const channels = new Set();
  try {
    fs.mkdirSync(dir, { recursive: true });
    const imported = firstRun ? importOld(meta, dir) : false;
    const factory = require(meta.main);
    const tool = factory({
      id,
      name: meta.name,
      version: meta.version,
      dir: meta.dir,
      dataDir: dir,
      ipc: scopedIpc(id, channels),
      shortcuts: Shortcuts.scoped(id),
      log: (msg) => log(`${id}: ${msg}`),
      changed: () => onChange(id),
    });
    running.set(id, { tool, channels });
    tool.start();
    log(`${id} ${meta.version} started in ${Date.now() - t0} ms`);
    return { ok: true, imported };
  } catch (err) {
    log(`${id} failed to start: ${err && err.stack || err}`);
    cleanup(id, channels);
    return { ok: false, error: err.message };
  }
}

function cleanup(id, channels) {
  for (const c of channels) { ipcMain.removeAllListeners(c); ipcMain.removeHandler(c); }
  Shortcuts.unregisterOwner(id);
  running.delete(id);
  const meta = find(id);
  // forget the module, so installing it again starts from a clean slate
  if (meta) for (const k of Object.keys(require.cache)) if (k.startsWith(meta.dir + path.sep)) delete require.cache[k];
}

function stop(id) {
  const r = running.get(id);
  if (!r) return;
  try { r.tool.stop(); } catch (err) { log(`${id} stop: ${err.message}`); }
  cleanup(id, r.channels);
  log(`${id} stopped`);
}

const stopAll = () => { for (const id of [...running.keys()]) stop(id); };

// ---------------------------------------------------------------------------
// what the launcher, the quick view and the tray ask of a tool
// ---------------------------------------------------------------------------

const get = (id) => (running.get(id) || {}).tool || null;
const safe = (fn, fallback) => { try { return fn(); } catch (err) { log(err.stack || err.message); return fallback; } };

function open(id) {
  const t = get(id);
  if (t) safe(() => t.open());
}

function actions(id) {
  const t = get(id);
  return t && t.actions ? safe(() => t.actions(), []) : [];
}

function run(id, actionId) {
  const a = actions(id).find((x) => x.id === actionId);
  if (a) safe(() => a.run());
}

function keys(id) {
  const t = get(id);
  return t && t.keys ? safe(() => t.keys(), []) : [];
}

function setKey(id, keyId, combo) {
  const t = get(id);
  if (!t || !t.setKey) return { ok: false, error: 'not running' };
  return safe(() => t.setKey(keyId, combo), { ok: false, error: 'failed' }) || { ok: false };
}

module.exports = {
  list, find, start, stop, stopAll, open, actions, run, keys, setKey, dataDir,
  isRunning: (id) => running.has(id),
  setLog: (fn) => { log = fn; },
  onChange: (fn) => { onChange = fn; },
};
