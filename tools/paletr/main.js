'use strict';

// paletr: point at any pixel on screen, its color is on your clipboard.
//
//   pick      the screens freeze under one overlay per display; the pointer is
//             a loupe. click = copy and go, shift+click = copy and keep picking.
//   palette   a small ghost window with the colors you picked, newest first.
//
// A utilr tool (see src/host.js): utilr owns the tray, the app lifecycle and
// start at login. paletr's ipc and keys are host.ipc / host.shortcuts, its data
// is one JSON file in host.dataDir.
//
// Light: start() reads that file and registers the key, nothing else. The
// overlays and the toast are made on the first pick (while the screens are
// being grabbed, so it costs little) and stay warm for a while after, so picks
// in a row are instant. Then they close, and an idle paletr has no windows.

const { BrowserWindow, screen, desktopCapturer, clipboard, app } = require('electron');
const path = require('path');
const fs = require('fs');
const Keys = require('./keys');
const Color = require('./color');

const BG = '#111111';                 // ghost --bg: no white flash
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const ICON = path.join(__dirname, 'assets', IS_WIN ? 'paletr.ico' : 'paletr-256.png');
const MAX_COLORS = 30;                // the palette keeps this many
const WARM_MS = 10 * 60 * 1000;       // overlays stay ready this long after a pick
const PALETTE = { width: 300, height: 268, minWidth: 200, minHeight: 150 };
const TOAST = { width: 300, height: 40 };

module.exports = function paletr(host) {
  const { ipc, shortcuts } = host;
  const log = (msg) => host.log(msg);

  // ---------------------------------------------------------------------------
  // data  (paletr.json in host.dataDir, written atomically, one .bak)
  // ---------------------------------------------------------------------------

  const FILE = path.join(host.dataDir, 'paletr.json');

  // key      the system-wide pick key
  // format   what's copied: hex / rgb / hsl
  // colors   the palette, newest first, as "#rrggbb"
  // bounds   where the palette window was
  const defaults = () => ({ version: 1, key: Keys.DEFAULT, format: 'hex', colors: [], bounds: null });
  let data = defaults();
  let saveTimer = null;

  function load() {
    for (const file of [FILE, FILE + '.bak']) {
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!raw || typeof raw !== 'object') continue;
        data = { ...defaults(), ...raw };
        data.key = Keys.normalize(data.key) || Keys.DEFAULT;
        if (!Color.FORMATS.includes(data.format)) data.format = 'hex';
        data.colors = (Array.isArray(data.colors) ? data.colors : [])
          .map((c) => Color.parse(c)).filter(Boolean).map(Color.hex)
          .filter((c, i, a) => a.indexOf(c) === i).slice(0, MAX_COLORS);
        const b = data.bounds;
        data.bounds = b && [b.x, b.y, b.width, b.height].every(Number.isFinite) ? b : null;
        return;
      } catch (_) { /* missing or unreadable: try the next one */ }
    }
  }

  function saveNow() {
    clearTimeout(saveTimer);
    saveTimer = null;
    const json = JSON.stringify(data, null, 1);
    try {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      if (fs.existsSync(FILE)) { try { fs.copyFileSync(FILE, FILE + '.bak'); } catch (_) {} }
      const tmp = FILE + '.tmp';
      fs.writeFileSync(tmp, json, 'utf8');
      try { fs.renameSync(tmp, FILE); } catch (_) { fs.writeFileSync(FILE, json, 'utf8'); }
    } catch (err) {
      log('could not save: ' + err.message);
    }
  }
  const save = () => { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 300); };

  const publicState = () => ({
    key: data.key,
    keyOk: registered !== null || keyPaused,
    format: data.format,
    colors: data.colors,
    max: MAX_COLORS,
    platform: process.platform,
    version: host.version,
    hosted: true, // utilr starts paletr at login and quits it: no rows for those
  });

  // a picked color goes to the front (once: picking it again moves it up)
  function remember(hex) {
    data.colors = [hex, ...data.colors.filter((c) => c !== hex)].slice(0, MAX_COLORS);
    save();
    sendState();
  }

  // Electron 45's clipboard may hand back a promise: fine either way
  async function copy(text) {
    try { await clipboard.writeText(text); return true; } catch (err) { log('copy failed: ' + err.message); return false; }
  }

  // ---------------------------------------------------------------------------
  // motion (same easing as utilr, notr and snipr)
  // ---------------------------------------------------------------------------

  const easeOut = (t) => 1 - Math.pow(1 - t, 3);
  const fades = new Map();

  function fade(win, to, ms, done) {
    if (!win || win.isDestroyed()) return;
    clearTimeout(fades.get(win));
    const from = win.getOpacity();
    const t0 = Date.now();
    const step = () => {
      if (win.isDestroyed()) { fades.delete(win); return; }
      const t = Math.min(1, (Date.now() - t0) / ms);
      win.setOpacity(from + (to - from) * easeOut(t));
      if (t < 1) fades.set(win, setTimeout(step, 8));
      else { fades.delete(win); if (done) done(); }
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
  // the screens, frozen
  // ---------------------------------------------------------------------------

  const physSize = (d) => ({ width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) });

  // One getSources call per distinct screen size, so no screen is scaled (a
  // scaled screen would give you a blend of pixels, not the color you saw).
  async function grabScreens(displays) {
    const shots = new Map(); // display.id -> nativeImage at physical resolution
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

  // ---------------------------------------------------------------------------
  // overlays: one per display, made on the first pick, kept warm for a while
  // ---------------------------------------------------------------------------

  const overlays = new Map(); // display.id -> BrowserWindow
  let session = null;         // the pick in progress
  let seq = 0;
  let coolTimer = null;
  let quitting = false;

  const displayKey = (d) => JSON.stringify([d.bounds, d.scaleFactor]);

  function makeOverlay(d) {
    const win = new BrowserWindow({
      ...d.bounds,
      frame: false,
      show: false,
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
      title: 'paletr',
      icon: ICON,
      webPreferences: webPrefs({ backgroundThrottling: false }),
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    if (IS_MAC) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.loadFile(path.join(__dirname, 'overlay.html'));
    lockDown(win);
    win.on('close', (e) => { if (!quitting) { e.preventDefault(); cancel(); } });
    win.on('closed', () => { if (overlays.get(d.id) === win) overlays.delete(d.id); });
    // a crashed overlay is made again on the next pick; this one ends now
    win.webContents.on('render-process-gone', () => {
      if (!win.isDestroyed()) win.destroy();
      if (session) cancel();
    });
    win.displayKey = displayKey(d);
    win.loaded = new Promise((res) => win.webContents.once('did-finish-load', res));
    return win;
  }

  // Drop overlays whose screen is gone or changed; make the missing ones only
  // when a pick asks for them.
  function syncOverlays(make) {
    const displays = screen.getAllDisplays();
    for (const [id, win] of overlays) {
      const d = displays.find((x) => x.id === id);
      if (!d || win.displayKey !== displayKey(d)) {
        overlays.delete(id);
        if (!win.isDestroyed()) win.destroy();
      }
    }
    if (make) for (const d of displays) if (!overlays.has(d.id)) overlays.set(d.id, makeOverlay(d));
  }
  const onDisplays = () => { if (!session) syncOverlays(false); };

  // after WARM_MS without a pick, the overlays and the toast close
  function warm() {
    clearTimeout(coolTimer);
    coolTimer = setTimeout(() => {
      if (session) return;
      for (const win of overlays.values()) if (!win.isDestroyed()) win.destroy();
      overlays.clear();
      if (toastWin && !toastWin.isDestroyed() && !toastWin.isVisible()) { toastWin.destroy(); toastWin = null; }
      log('overlays closed (idle)');
    }, WARM_MS);
  }

  // origin: key / tray / launch / palette
  async function pick(origin = 'key') {
    if (session) { if (origin === 'key' && session.shots) cancel(); return; } // the key again: never mind
    clearTimeout(coolTimer);
    const sid = ++seq;
    session = { sid, origin, shots: null, bitmaps: new Map(), ready: new Set(), picked: 0, last: null };
    const t0 = Date.now();
    try {
      hideToast(true);
      syncOverlays(true);
      ensureToast();
      const displays = screen.getAllDisplays();
      const cursor = screen.getCursorScreenPoint();
      const active = screen.getDisplayNearestPoint(cursor);
      const shots = await grabScreens(displays);
      if (!session || session.sid !== sid) return;
      if (!shots.size) throw new Error('no screens captured');
      session.shots = shots;
      const t1 = Date.now();

      await Promise.all([...overlays.values()].map((w) => w.loaded));
      if (!session || session.sid !== sid) return;
      for (const d of displays) {
        const win = overlays.get(d.id);
        const img = shots.get(d.id);
        if (!win || win.isDestroyed() || !img) continue;
        const { width, height } = img.getSize();
        const bitmap = img.toBitmap(); // BGRA, the same bytes the overlay paints
        session.bitmaps.set(d.id, { bitmap, width, height });
        win.webContents.send('overlay:open', {
          sid, width, height, bitmap,
          scale: d.scaleFactor,
          active: d.id === active.id,
          cursor: { x: cursor.x - d.bounds.x, y: cursor.y - d.bounds.y },
          format: data.format,
        });
      }
      // shown invisible first (a hidden window doesn't paint), then made opaque
      // once every overlay has drawn its screen, so nothing stale ever flashes
      const ready = new Promise((res) => {
        session.onReady = () => { if (!session || session.sid !== sid || session.ready.size >= session.bitmaps.size) res(); };
        setTimeout(res, 500);
      });
      for (const d of displays) {
        const win = overlays.get(d.id);
        if (!win || win.isDestroyed()) continue;
        win.setOpacity(0);
        win.setBounds(d.bounds);
        win.setBounds(d.bounds); // twice: Windows can rescale a window moved between DPIs
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
      log(`pick (${origin}) ${displays.length} screen(s): grab ${t1 - t0} ms, shown ${Date.now() - t0} ms`);
    } catch (err) {
      log('pick failed: ' + (err && err.stack || err));
      end();
      toast(IS_MAC ? 'allow screen recording for utilr' : 'could not see the screen', '', '', 2600);
    }
  }

  function hideOverlays() {
    for (const win of overlays.values()) {
      if (win.isDestroyed() || !win.isVisible()) continue;
      win.setOpacity(0);
      win.hide();
      win.webContents.send('overlay:reset'); // the frozen screen leaves memory too
    }
  }

  // the pick is over (copied, cancelled or failed)
  function end() {
    const s = session;
    session = null;
    hideOverlays();
    warm();
    if (s && s.origin === 'palette') showPalette();
    return s;
  }

  function cancel() {
    if (!session) return;
    const s = end();
    // after shift+clicks: say what's on the clipboard now
    if (s.picked > 0) toast(Color.format(s.last, data.format), s.picked === 1 ? 'copied' : `${s.picked} picked`, s.last);
  }

  // The overlay sends a pixel in its screen's own (physical) pixels. The color
  // is read here, from the grab itself, not taken from the window's word.
  function pickAt(win, px, keep) {
    if (!session || !session.shots) return;
    const entry = [...overlays.entries()].find(([, w]) => w === win);
    const shot = entry && session.bitmaps.get(entry[0]);
    if (!shot) return;
    const x = Math.max(0, Math.min(shot.width - 1, Math.floor(px.x)));
    const y = Math.max(0, Math.min(shot.height - 1, Math.floor(px.y)));
    const i = (y * shot.width + x) * 4;
    const hex = Color.hex({ r: shot.bitmap[i + 2], g: shot.bitmap[i + 1], b: shot.bitmap[i] });
    const text = Color.format(hex, data.format);
    copy(text);
    remember(hex);
    session.picked += 1;
    session.last = hex;
    if (keep) {
      win.webContents.send('overlay:picked', { hex, text });
      return;
    }
    end();
    toast(text, 'copied', hex);
  }

  // ---------------------------------------------------------------------------
  // toast: "■ #1e90ff   copied", in the corner
  // ---------------------------------------------------------------------------

  let toastWin = null;
  let toastTimer = null;

  function ensureToast() {
    if (toastWin && !toastWin.isDestroyed()) return toastWin;
    const win = toastWin = new BrowserWindow({
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
      title: 'paletr',
      webPreferences: webPrefs(),
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setIgnoreMouseEvents(true);
    win.loadFile(path.join(__dirname, 'toast.html'));
    lockDown(win);
    win.loaded = new Promise((res) => win.webContents.once('did-finish-load', res));
    win.on('closed', () => { if (toastWin === win) toastWin = null; });
    return win;
  }

  async function toast(text, detail = '', swatch = '', ms = 1600) {
    const win = ensureToast();
    await win.loaded;
    if (win.isDestroyed()) return;
    clearTimeout(toastTimer);
    const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    win.setBounds({ x: wa.x + wa.width - TOAST.width - 16, y: wa.y + wa.height - TOAST.height - 16, ...TOAST });
    win.webContents.send('toast:show', { text, detail, swatch });
    win.setOpacity(1);
    win.showInactive();
    if (ms) toastTimer = setTimeout(() => hideToast(), ms);
  }

  function hideToast(now) {
    clearTimeout(toastTimer);
    const win = toastWin;
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    if (now) { win.hide(); return; }
    win.webContents.send('toast:hide');
    toastTimer = setTimeout(() => { if (!win.isDestroyed()) win.hide(); }, 180);
  }

  // ---------------------------------------------------------------------------
  // the palette window
  // ---------------------------------------------------------------------------

  let paletteWin = null;

  function paletteBounds() {
    const b = data.bounds;
    if (b) {
      // only where it was if that's still on a screen
      const wa = screen.getDisplayMatching(b).workArea;
      const w = Math.max(PALETTE.minWidth, Math.min(b.width, wa.width));
      const h = Math.max(PALETTE.minHeight, Math.min(b.height, wa.height));
      const onScreen = b.x < wa.x + wa.width - 40 && b.x + w > wa.x + 40 && b.y >= wa.y - 10 && b.y < wa.y + wa.height - 40;
      if (onScreen) return { x: b.x, y: b.y, width: w, height: h };
    }
    const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    return {
      x: Math.round(wa.x + (wa.width - PALETTE.width) / 2),
      y: Math.round(wa.y + (wa.height - PALETTE.height) / 3),
      width: PALETTE.width,
      height: PALETTE.height,
    };
  }

  function openPalette() {
    if (paletteWin && !paletteWin.isDestroyed()) { showPalette(); return; }
    const win = paletteWin = new BrowserWindow({
      ...paletteBounds(),
      minWidth: PALETTE.minWidth,
      minHeight: PALETTE.minHeight,
      frame: false,
      resizable: true,
      maximizable: false,
      fullscreenable: false,
      show: false,
      opacity: 0,
      title: 'paletr',
      icon: ICON,
      backgroundColor: BG,
      webPreferences: webPrefs(),
    });
    win.loadFile(path.join(__dirname, 'palette.html'));
    lockDown(win);
    win.once('ready-to-show', () => { win.show(); win.focus(); fade(win, 1, 220); });
    const keep = () => { if (!win.isDestroyed() && win.isVisible()) { data.bounds = win.getBounds(); save(); } };
    win.on('moved', keep);
    win.on('resized', keep);
    win.on('closed', () => {
      if (paletteWin === win) paletteWin = null;
      if (keyPaused) { keyPaused = false; registerKey(); }
    });
    win.webContents.on('render-process-gone', () => { if (!win.isDestroyed()) win.reload(); });
  }

  function showPalette() {
    const win = paletteWin;
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) { win.setOpacity(0); win.show(); fade(win, 1, 160); }
    win.focus();
  }

  function closePalette() {
    const win = paletteWin;
    if (!win || win.isDestroyed()) return;
    fade(win, 0, 140, () => { if (!win.isDestroyed()) win.destroy(); });
  }

  // "+" in the palette: it steps aside so it isn't in the picture, and comes
  // back when the pick is over
  function pickFromPalette() {
    const win = paletteWin;
    if (session) return;
    if (!win || win.isDestroyed() || !win.isVisible()) { pick('palette'); return; }
    fade(win, 0, 90, () => {
      if (!win.isDestroyed()) win.hide();
      setTimeout(() => pick('palette'), 60);
    });
  }

  // Every window paletr has open. Other tools share the process, so paletr
  // only ever talks to these.
  const ownWindows = () => [...overlays.values(), toastWin, paletteWin].filter((w) => w && !w.isDestroyed());
  const isOwn = (e) => ownWindows().some((w) => w.webContents === e.sender);
  const fromPalette = (e) => paletteWin && !paletteWin.isDestroyed() && e.sender === paletteWin.webContents;
  const overlayOf = (e) => [...overlays.values()].find((w) => !w.isDestroyed() && w.webContents === e.sender) || null;

  function sendState() {
    if (paletteWin && !paletteWin.isDestroyed()) paletteWin.webContents.send('state', publicState());
  }

  // ---------------------------------------------------------------------------
  // the pick key (system-wide)
  // ---------------------------------------------------------------------------

  let registered = null; // the accelerator paletr holds, or null
  let keyPaused = false;  // the palette is recording a new key

  function registerKey() {
    if (registered) { shortcuts.unregister(registered); registered = null; }
    if (keyPaused) return true;
    const accel = Keys.toAccelerator(data.key);
    if (shortcuts.register(accel, () => pick('key'))) {
      registered = accel;
      log(`pick key ready: ${accel}`);
      return true;
    }
    log(`pick key NOT available: ${accel}`);
    return false;
  }

  // -> { ok } or { ok: false, error }; the launcher's keys page and the palette both use it
  function setKey(id, raw) {
    if (id !== 'pick') return { ok: false, error: 'unknown key' };
    const combo = Keys.normalize(raw);
    if (!combo) return { ok: false, error: 'not a shortcut' };
    if (combo === data.key && registered) return { ok: true };
    const old = data.key;
    data.key = combo;
    if (!registerKey()) {
      data.key = old;
      registerKey();
      sendState();
      return { ok: false, error: 'another program has it' };
    }
    save();
    sendState();
    return { ok: true };
  }

  // ---------------------------------------------------------------------------
  // IPC  (every channel is really "paletr/<channel>")
  // ---------------------------------------------------------------------------

  // overlays
  ipc.on('overlay:ready', (e, sid) => {
    if (!session || session.sid !== sid || !overlayOf(e)) return;
    session.ready.add(e.sender.id);
    if (session.onReady) session.onReady();
  });
  ipc.on('overlay:pick', (e, sid, px, keep) => {
    const win = overlayOf(e);
    if (!win || !session || session.sid !== sid || !px) return;
    const p = { x: +px.x, y: +px.y };
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return;
    pickAt(win, p, !!keep);
  });
  ipc.on('overlay:cancel', (e) => { if (overlayOf(e)) cancel(); });
  // keys go to the overlay under the pointer
  ipc.on('overlay:focus', (e) => {
    const win = overlayOf(e);
    if (win && session && !win.isFocused()) win.focus();
  });
  // tab in an overlay: the format changes everywhere
  ipc.on('overlay:format', (e, fmt) => {
    if (!overlayOf(e) || !Color.FORMATS.includes(fmt)) return;
    data.format = fmt;
    save();
    for (const w of overlays.values()) if (!w.isDestroyed()) w.webContents.send('overlay:format', fmt);
    sendState();
  });

  // palette
  ipc.handle('state:get', (e) => (isOwn(e) ? publicState() : null));
  ipc.on('pick', (e) => { if (fromPalette(e)) pickFromPalette(); });
  ipc.handle('copy', async (e, hex, fmt) => {
    if (!fromPalette(e) || !Color.parse(hex)) return null;
    const text = Color.format(hex, Color.FORMATS.includes(fmt) ? fmt : data.format);
    return (await copy(text)) ? text : null;
  });
  ipc.on('remove', (e, hex) => {
    if (!fromPalette(e)) return;
    data.colors = data.colors.filter((c) => c !== hex);
    save();
    sendState();
  });
  ipc.on('clear', (e) => {
    if (!fromPalette(e)) return;
    data.colors = [];
    save();
    sendState();
  });
  ipc.on('settings:set', (e, patch) => {
    if (!fromPalette(e) || !patch || typeof patch !== 'object') return;
    if (Color.FORMATS.includes(patch.format)) { data.format = patch.format; save(); }
    if (typeof patch.key === 'string') {
      const r = setKey('pick', patch.key);
      if (!r.ok) e.sender.send('key-taken', Keys.label(Keys.normalize(patch.key) || patch.key));
      host.changed();
    }
    sendState();
  });
  // while the palette records a new key, the old one must not fire
  ipc.on('key:record', (e, on) => {
    if (!fromPalette(e)) return;
    keyPaused = !!on;
    registerKey();
    if (!on) host.changed();
  });
  ipc.on('win:close', (e) => { if (fromPalette(e)) closePalette(); });
  ipc.on('win:minimize', (e) => { if (fromPalette(e)) paletteWin.minimize(); });

  // ---------------------------------------------------------------------------
  // paletr as utilr sees it
  // ---------------------------------------------------------------------------

  function start() {
    load();
    registerKey();
    screen.on('display-added', onDisplays);
    screen.on('display-removed', onDisplays);
    screen.on('display-metrics-changed', onDisplays);
  }

  // utilr quits, or paletr is removed: save, let go of the key, close everything
  function stop() {
    quitting = true;
    if (paletteWin && !paletteWin.isDestroyed() && paletteWin.isVisible()) data.bounds = paletteWin.getBounds();
    saveNow();
    clearTimeout(coolTimer);
    clearTimeout(toastTimer);
    for (const t of fades.values()) clearTimeout(t);
    fades.clear();
    session = null;
    screen.removeListener('display-added', onDisplays);
    screen.removeListener('display-removed', onDisplays);
    screen.removeListener('display-metrics-changed', onDisplays);
    if (registered) { shortcuts.unregister(registered); registered = null; }
    for (const w of ownWindows()) w.destroy();
    overlays.clear();
    toastWin = paletteWin = null;
  }

  return {
    start,
    stop,
    open: () => pick('launch'),
    actions: () => [
      { id: 'pick', label: 'pick a color', key: 'pick', run: () => pick('tray') },
      { id: 'palette', label: 'palette', run: openPalette },
    ],
    keys: () => [{ id: 'pick', label: 'pick a color', combo: data.key, ok: registered !== null || keyPaused }],
    setKey,
  };
};
