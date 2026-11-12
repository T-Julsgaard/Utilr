'use strict';

// measr, a utilr tool: measure anything on screen in pixels.
//
// Press the key and the screen holds still: one overlay per display shows a
// frozen copy of it, and measr reads that copy pixel by pixel. Everything
// clever (edges, snapping, gaps, padding) happens in the overlay (overlay.js);
// this file captures the screens, shows and hides the overlays, owns the
// settings, the clipboard and the key.

const { BrowserWindow, screen, desktopCapturer, clipboard, ClipboardItem, app } = require('electron');
const path = require('path');
const fs = require('fs');
const Keys = require('./keys');

const BG = '#111111';          // ghost --bg, so windows never flash white
const IS_MAC = process.platform === 'darwin';
const UNITS = ['css', 'screen'];
const FORMATS = ['plain', 'css', 'tailwind'];
const EDGES = ['exact', 'soft', 'loose'];
const LOUPES = ['auto', 'always', 'off'];

module.exports = function measr(host) {
  const { ipc, shortcuts } = host;

  // ---------------------------------------------------------------------------
  // log + settings  (one JSON file in host.dataDir)
  // ---------------------------------------------------------------------------

  function logLine(msg) {
    try {
      const file = path.join(host.dataDir, 'measr.log');
      let old = '';
      try { old = fs.readFileSync(file, 'utf8'); } catch (_) {}
      if (old.length > 50000) old = old.slice(-20000);
      fs.writeFileSync(file, old + new Date().toISOString() + ' ' + msg + '\n', 'utf8');
    } catch (_) {}
  }

  const SETTINGS_FILE = () => path.join(host.dataDir, 'measr-settings.json');

  // key:     the system-wide "measure" key
  // units:   css (screen px ÷ the display's scale, what you write in code) or screen
  // format:  what ctrl+c puts on the clipboard: plain "240 × 48", css, tailwind
  // edges:   how different a pixel must be to count as an edge
  // loupe:   the magnifier: auto (when you hold still), always, off
  // hints:   the key hint at the top when measr opens
  const defaults = () => ({
    key: Keys.DEFAULT,
    units: 'css',
    format: 'plain',
    edges: 'soft',
    loupe: 'auto',
    hints: true,
    version: 1,
  });

  let settings = defaults();
  let saveTimer = null;

  function loadSettings() {
    for (const file of [SETTINGS_FILE(), SETTINGS_FILE() + '.bak']) {
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!raw || typeof raw !== 'object') continue;
        const d = defaults();
        settings = { ...d, ...raw };
        settings.key = Keys.normalize(settings.key) || d.key;
        if (!UNITS.includes(settings.units)) settings.units = d.units;
        if (!FORMATS.includes(settings.format)) settings.format = d.format;
        if (!EDGES.includes(settings.edges)) settings.edges = d.edges;
        if (!LOUPES.includes(settings.loupe)) settings.loupe = d.loupe;
        settings.hints = settings.hints !== false;
        return;
      } catch (_) { /* missing or unreadable: try the next one */ }
    }
  }

  function writeSettingsNow() {
    clearTimeout(saveTimer);
    saveTimer = null;
    const file = SETTINGS_FILE();
    const json = JSON.stringify(settings, null, 1);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (fs.existsSync(file)) { try { fs.copyFileSync(file, file + '.bak'); } catch (_) {} }
      fs.writeFileSync(file + '.tmp', json, 'utf8');
      try { fs.renameSync(file + '.tmp', file); } catch (_) { fs.writeFileSync(file, json, 'utf8'); }
    } catch (err) {
      logLine('could not save settings: ' + err.message);
    }
  }
  const scheduleSave = () => { clearTimeout(saveTimer); saveTimer = setTimeout(writeSettingsNow, 300); };

  const publicSettings = () => ({
    key: settings.key,
    keyOk: registered !== null || keyPaused,
    units: settings.units,
    format: settings.format,
    edges: settings.edges,
    loupe: settings.loupe,
    hints: settings.hints,
    platform: process.platform,
    version: host.version,
    hosted: true, // utilr starts measr at login and quits it: no such rows here
  });

  // ---------------------------------------------------------------------------
  // windows: motion and lock-down, the same as snipr and notr
  // ---------------------------------------------------------------------------

  const easeOut = (t) => 1 - Math.pow(1 - t, 3);

  function fade(win, from, to, ms, done) {
    const start = Date.now();
    const step = () => {
      if (win.isDestroyed()) return;
      const t = Math.min(1, (Date.now() - start) / ms);
      win.setOpacity(from + (to - from) * easeOut(t));
      if (t < 1) setTimeout(step, 8);
      else if (done) done();
    };
    step();
  }

  const webPrefs = (extra = {}) => ({
    preload: path.join(__dirname, 'preload.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    spellcheck: false,
    ...extra,
  });

  function lockDown(win) {
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
  }

  // ---------------------------------------------------------------------------
  // capture: grab every screen, then show one overlay per display
  // ---------------------------------------------------------------------------

  const physSize = (d) => ({ width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) });

  // One getSources call per distinct screen size, so no screen is ever scaled
  // (a measuring tool must see the real pixels, not a resampled thumbnail).
  async function grabScreens(displays) {
    const shots = new Map();
    const groups = new Map();
    for (const d of displays) {
      const s = physSize(d);
      const k = s.width + 'x' + s.height;
      if (!groups.has(k)) groups.set(k, { size: s, displays: [] });
      groups.get(k).displays.push(d);
    }
    for (const { size, displays: ds } of groups.values()) {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
      for (const d of ds) {
        const i = displays.indexOf(d);
        const src = sources.find((s) => s.display_id && s.display_id === String(d.id)) || sources[i] || sources[0];
        if (!src) continue;
        let img = src.thumbnail;
        const got = img.getSize();
        if (got.width !== size.width || got.height !== size.height) img = img.resize({ ...size, quality: 'best' });
        shots.set(d.id, img);
      }
    }
    return shots;
  }

  const overlays = new Map(); // display.id -> BrowserWindow
  let session = null;         // the measuring in progress
  let sessionSeq = 0;
  let stopping = false;

  function makeOverlay(d) {
    const win = new BrowserWindow({
      ...d.bounds,
      frame: false,
      show: false,
      transparent: false,
      backgroundColor: BG,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      enableLargerThanScreen: true,
      alwaysOnTop: true,
      title: 'measr',
      webPreferences: webPrefs({ backgroundThrottling: false }),
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    if (IS_MAC) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.loadFile(path.join(__dirname, 'overlay.html'));
    lockDown(win);
    win.on('close', (e) => { if (!stopping) { e.preventDefault(); endMeasure(); } });
    win.on('closed', () => { if (overlays.get(d.id) === win) overlays.delete(d.id); });
    win.webContents.on('render-process-gone', () => { if (!win.isDestroyed()) win.reload(); });
    win.displayKey = JSON.stringify([d.bounds, d.scaleFactor]);
    win.loaded = new Promise((res) => win.webContents.once('did-finish-load', res));
    return win;
  }

  // One hidden overlay per display, ready to show; rebuilt when screens
  // change. With utilr's RAM saver on, they're only made when you measure
  // (make), and closed after a few minutes unused (cool).
  const saving = () => !!(host.ramSaver && host.ramSaver());
  function syncOverlays(make = !saving()) {
    const displays = screen.getAllDisplays();
    for (const [id, win] of overlays) {
      const d = displays.find((x) => x.id === id);
      if (!d || win.displayKey !== JSON.stringify([d.bounds, d.scaleFactor])) {
        overlays.delete(id);
        if (!win.isDestroyed()) win.destroy();
      }
    }
    if (make) for (const d of displays) if (!overlays.has(d.id)) overlays.set(d.id, makeOverlay(d));
  }
  const onDisplays = () => syncOverlays(); // (not the event's arguments)

  let coolTimer = null;
  function cool() {
    clearTimeout(coolTimer);
    if (!saving()) return;
    coolTimer = setTimeout(() => {
      if (session || stopping) return;
      for (const win of overlays.values()) if (!win.isDestroyed()) win.destroy();
      overlays.clear();
      if (toastWin && !toastWin.isDestroyed() && !toastWin.isVisible()) { toastWin.destroy(); toastWin = null; }
      logLine('overlays closed (ram saver)');
    }, host.ramSaverMs ? host.ramSaverMs() : 5 * 60 * 1000);
  }

  function setRamSaver(on) {
    if (on) { cool(); return; }
    clearTimeout(coolTimer);
    syncOverlays(true);
  }

  async function startMeasure(origin = 'key') {
    if (session) { if (origin === 'key') endMeasure(); return; } // the key again closes it
    const sid = ++sessionSeq;
    session = { sid, origin, ready: new Set() };
    const t0 = Date.now();
    try {
      clearTimeout(coolTimer);
      hideToast();
      syncOverlays(true);
      const displays = screen.getAllDisplays();
      const cursor = screen.getCursorScreenPoint();
      const active = screen.getDisplayNearestPoint(cursor);
      const shots = await grabScreens(displays);
      if (!session || session.sid !== sid) return;
      if (!shots.size) throw new Error('no screens captured');
      const t1 = Date.now();

      await Promise.all([...overlays.values()].map((w) => w.loaded));
      if (!session || session.sid !== sid) return;
      for (const d of displays) {
        const win = overlays.get(d.id);
        const img = shots.get(d.id);
        if (!win || !img) continue;
        const { width, height } = img.getSize();
        win.webContents.send('overlay:open', {
          sid,
          width,
          height,
          bitmap: img.toBitmap(),
          scale: d.scaleFactor,
          active: d.id === active.id,
          cursor: { x: cursor.x - d.bounds.x, y: cursor.y - d.bounds.y },
          settings: publicSettings(),
          keyLabel: Keys.label(settings.key),
        });
      }
      // Shown invisible first (a hidden window doesn't paint), then made opaque
      // once every overlay has drawn its screen, so nothing stale ever flashes.
      const ready = new Promise((res) => {
        session.onReady = () => { if (!session || session.sid !== sid || session.ready.size >= shots.size) res(); };
        setTimeout(res, 500);
      });
      for (const d of displays) {
        const win = overlays.get(d.id);
        if (!win || win.isDestroyed()) continue;
        win.setOpacity(0);
        win.setBounds(d.bounds); // twice: Windows can rescale a window moved between DPIs
        win.setBounds(d.bounds);
        win.showInactive();
        win.setAlwaysOnTop(true, 'screen-saver');
      }
      const activeWin = overlays.get(active.id);
      if (activeWin && !activeWin.isDestroyed()) {
        if (IS_MAC) app.focus({ steal: true });
        activeWin.moveTop();
        activeWin.focus();
      }
      await ready;
      if (!session || session.sid !== sid) return;
      for (const win of overlays.values()) if (!win.isDestroyed() && win.isVisible()) win.setOpacity(1);
      logLine(`measure ${displays.length} screen(s): grab ${t1 - t0} ms, shown ${Date.now() - t0} ms`);
    } catch (err) {
      logLine('capture failed: ' + (err && err.stack || err));
      endMeasure();
      toast(IS_MAC ? 'allow screen recording for utilr' : 'could not see the screen', '', 2600);
    }
  }

  function endMeasure() {
    session = null;
    cool();
    for (const win of overlays.values()) {
      if (win.isDestroyed() || !win.isVisible()) continue;
      win.setOpacity(0);
      win.hide();
      win.webContents.send('overlay:reset');
    }
  }

  // ---------------------------------------------------------------------------
  // clipboard
  // ---------------------------------------------------------------------------

  async function copyText(text) {
    try { await clipboard.writeText(String(text)); return true; } catch (err) { logLine('copy failed: ' + err.message); return false; }
  }

  async function copyPng(buf) {
    try {
      await clipboard.write([new ClipboardItem({ 'image/png': new Blob([buf], { type: 'image/png' }) })]);
      return true;
    } catch (err) {
      logLine('copy image failed: ' + err.message);
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // toast: "copied  240 × 48", in the corner, after measr has closed.
  // Made the first time it's needed, then kept (hidden).
  // ---------------------------------------------------------------------------

  let toastWin = null;
  let toastTimer = null;
  const TOAST = { width: 300, height: 40 };

  function ensureToast() {
    if (toastWin && !toastWin.isDestroyed()) return toastWin;
    toastWin = new BrowserWindow({
      ...TOAST,
      frame: false,
      show: false,
      transparent: true,
      resizable: false,
      movable: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      title: 'measr',
      webPreferences: webPrefs(),
    });
    toastWin.setAlwaysOnTop(true, 'screen-saver');
    toastWin.setIgnoreMouseEvents(true);
    toastWin.loadFile(path.join(__dirname, 'toast.html'));
    lockDown(toastWin);
    toastWin.loaded = new Promise((res) => toastWin.webContents.once('did-finish-load', res));
    return toastWin;
  }

  async function toast(text, detail = '', ms = 1600) {
    if (stopping) return;
    const win = ensureToast();
    await win.loaded;
    if (win.isDestroyed()) return;
    clearTimeout(toastTimer);
    const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    win.setBounds({ x: wa.x + wa.width - TOAST.width - 16, y: wa.y + wa.height - TOAST.height - 16, ...TOAST });
    win.webContents.send('toast:show', { text, detail });
    win.setOpacity(1);
    win.showInactive();
    if (ms) toastTimer = setTimeout(hideToast, ms);
  }

  function hideToast() {
    clearTimeout(toastTimer);
    if (!toastWin || toastWin.isDestroyed() || !toastWin.isVisible()) return;
    toastWin.webContents.send('toast:hide');
    const win = toastWin;
    toastTimer = setTimeout(() => { if (!win.isDestroyed()) win.hide(); }, 180);
  }

  // "measure in 3 seconds": time to open the menu or hover the button you want
  // to measure. Counts down in the toast, which is gone before the capture.
  let delayTimer = null;
  function delayedMeasure(seconds = 3) {
    clearTimeout(delayTimer);
    if (session) endMeasure();
    let left = seconds;
    const tick = () => {
      if (left === 0) { hideToast(); delayTimer = setTimeout(() => startMeasure('delay'), 260); return; }
      toast(`measure in ${left}`, '', 0);
      left -= 1;
      delayTimer = setTimeout(tick, 1000);
    };
    tick();
  }

  // ---------------------------------------------------------------------------
  // settings window (tray → settings); the overlay's right-click menu has the same rows
  // ---------------------------------------------------------------------------

  let settingsWin = null;

  function openSettings() {
    if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.show(); settingsWin.focus(); return; }
    const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const width = 320, height = 30 + 22 + 8 + 6 * 34 + 2 * 13 + 10;
    const win = settingsWin = new BrowserWindow({
      x: Math.round(wa.x + (wa.width - width) / 2),
      y: Math.round(wa.y + (wa.height - height) / 3),
      width, height,
      frame: false,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      show: false,
      opacity: 0,
      title: 'measr',
      backgroundColor: BG,
      webPreferences: webPrefs(),
    });
    win.loadFile(path.join(__dirname, 'settings.html'));
    lockDown(win);
    win.once('ready-to-show', () => { win.show(); fade(win, 0, 1, 220); });
    win.on('closed', () => { if (settingsWin === win) settingsWin = null; if (keyPaused) { keyPaused = false; registerKey(); } });
  }

  // Every window measr has open. Other tools share the process, so measr only
  // ever talks to these.
  const ownWindows = () => [...overlays.values(), toastWin, settingsWin].filter((w) => w && !w.isDestroyed());
  const isOverlay = (e) => [...overlays.values()].some((w) => !w.isDestroyed() && w.webContents === e.sender);
  const isOwn = (e) => ownWindows().some((w) => w.webContents === e.sender);

  function broadcast(channel, ...args) {
    for (const w of ownWindows()) w.webContents.send(channel, ...args);
  }

  // ---------------------------------------------------------------------------
  // the measure key (system-wide)
  // ---------------------------------------------------------------------------

  let registered = null; // the accelerator measr holds
  let keyPaused = false; // while the settings window records a new key

  function registerKey() {
    if (registered) { try { shortcuts.unregister(registered); } catch (_) {} registered = null; }
    if (keyPaused) return true;
    const accel = Keys.toAccelerator(settings.key);
    try {
      if (shortcuts.register(accel, () => startMeasure('key'))) {
        registered = accel;
        logLine(`measure key ready: ${accel}`);
        return true;
      }
      logLine(`measure key NOT available (someone else has it): ${accel}`);
    } catch (err) {
      logLine(`measure key failed: ${accel} ${err.message}`);
    }
    return false;
  }

  // -> { ok } or { ok: false, error }
  function setKeyCombo(raw) {
    const combo = Keys.normalize(raw);
    if (!combo) return { ok: false, error: 'not a shortcut' };
    if (combo === settings.key) return { ok: true };
    const old = settings.key;
    settings.key = combo;
    if (!registerKey()) {
      settings.key = old;
      registerKey();
      return { ok: false, error: 'another program has it' };
    }
    scheduleSave();
    broadcast('settings:changed', publicSettings());
    host.changed();
    return { ok: true };
  }

  // ---------------------------------------------------------------------------
  // IPC  (every channel is "measr/…"; only measr's own windows are listened to)
  // ---------------------------------------------------------------------------

  ipc.handle('settings:get', (e) => (isOwn(e) ? publicSettings() : null));

  ipc.on('settings:set', (e, patch) => {
    if (!isOwn(e) || !patch || typeof patch !== 'object') return;
    if (UNITS.includes(patch.units)) settings.units = patch.units;
    if (FORMATS.includes(patch.format)) settings.format = patch.format;
    if (EDGES.includes(patch.edges)) settings.edges = patch.edges;
    if (LOUPES.includes(patch.loupe)) settings.loupe = patch.loupe;
    if (typeof patch.hints === 'boolean') settings.hints = patch.hints;
    if (typeof patch.key === 'string') {
      const r = setKeyCombo(patch.key);
      if (!r.ok) broadcast('settings:key-taken', Keys.label(Keys.normalize(patch.key) || patch.key), r.error);
    }
    broadcast('settings:changed', publicSettings());
    scheduleSave();
  });

  ipc.on('key:record', (e, on) => { if (isOwn(e)) { keyPaused = !!on; registerKey(); } });
  ipc.on('win:close', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (win && win === settingsWin) fade(win, win.getOpacity(), 0, 140, () => { if (!win.isDestroyed()) win.destroy(); });
  });

  ipc.on('overlay:ready', (e, sid) => {
    if (!session || session.sid !== sid || !isOverlay(e)) return;
    session.ready.add(e.sender.id);
    if (session.onReady) session.onReady();
  });
  // the pointer moved onto another display: its overlay takes the keys
  ipc.on('overlay:focus', (e) => {
    if (!session || !isOverlay(e)) return;
    const win = BrowserWindow.fromWebContents(e.sender);
    if (win && !win.isFocused()) win.focus();
  });
  // done measuring; with a notice when something was just copied
  ipc.on('overlay:close', (e, notice) => {
    if (!isOverlay(e)) return;
    endMeasure();
    if (notice && typeof notice.text === 'string') toast(notice.text.slice(0, 40), String(notice.detail || '').slice(0, 40));
  });
  ipc.handle('copy:text', (e, text) => (isOverlay(e) && typeof text === 'string' ? copyText(text.slice(0, 4000)) : false));
  ipc.handle('copy:png', (e, png) => (isOverlay(e) && png && png.byteLength ? copyPng(Buffer.from(png)) : false));

  // ---------------------------------------------------------------------------
  // measr as utilr sees it
  // ---------------------------------------------------------------------------

  const onMetrics = () => { if (!session) syncOverlays(); };

  // Ready for the key: the overlays are made up front, hidden, so measr opens
  // at once (with utilr's RAM saver on: when you measure). No window shows
  // until you measure.
  function start() {
    loadSettings();
    logLine(`start ${host.version} in utilr ${process.platform}`);
    registerKey();
    if (!saving()) syncOverlays();
    screen.on('display-added', onDisplays);
    screen.on('display-removed', onDisplays);
    screen.on('display-metrics-changed', onMetrics);
  }

  // utilr quits, or measr is removed: save, let go of the key, close everything.
  function stop() {
    stopping = true;
    writeSettingsNow();
    clearTimeout(delayTimer);
    clearTimeout(toastTimer);
    session = null;
    clearTimeout(coolTimer);
    screen.removeListener('display-added', onDisplays);
    screen.removeListener('display-removed', onDisplays);
    screen.removeListener('display-metrics-changed', onMetrics);
    if (registered) { try { shortcuts.unregister(registered); } catch (_) {} registered = null; }
    for (const w of ownWindows()) w.destroy();
    overlays.clear();
    toastWin = settingsWin = null;
  }

  return {
    start,
    stop,
    open: () => startMeasure('launch'),
    actions: () => [
      { id: 'measure', label: 'measure', key: 'key', run: () => startMeasure('tray') },
      { id: 'delay', label: 'measure in 3 seconds', run: () => delayedMeasure(3) },
      { id: 'settings', label: 'settings', run: openSettings },
    ],
    keys: () => [{ id: 'key', label: 'measure', combo: settings.key, ok: registered !== null || keyPaused }],
    setKey: (id, combo) => (id === 'key' ? setKeyCombo(combo) : { ok: false, error: 'unknown shortcut' }),
    ramSaver: setRamSaver,
  };
};
