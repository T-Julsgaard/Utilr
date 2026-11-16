'use strict';

// snipr, as a utilr tool. This is snipr's own main process and it does what it
// always did; only the parts that belonged to a stand-alone app moved out to
// utilr: the tray, start at login, the single-instance lock, the app menu and
// the app lifecycle. utilr hands in `host` (src/host.js): its ipc and
// shortcuts look like Electron's ipcMain and globalShortcut but are snipr's
// own, and snipr's settings live in host.dataDir (the tools/snipr folder in
// utilr's data). Snips still go to Pictures/snipr.

const {
  app, BrowserWindow, screen, nativeImage,
  desktopCapturer, clipboard, ClipboardItem, dialog, shell,
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const Keys = require('./keys');
const Fonts = require('./fonts/list');
const Ocr = require('./ocr');

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

const BG = '#111111';          // ghost --bg, so windows never flash white
const BAR_H = 30;              // ghost --bar-h
const STATUS_H = 22;           // ghost --status-h
const BORDERS = [0, 12, 24, 48]; // the snip border choices, px round the image (settings.border)
const SNIP_MIN = { width: 310, height: 150 };
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const ASSETS = path.join(__dirname, 'assets');
const ICON = path.join(ASSETS, IS_WIN ? 'snipr.ico' : 'snipr-256.png');
const INKS = ['ghost', 'red', 'black'];
const GIF = {
  fps: 15,               // frames a second while recording
  maxSide: 1920,         // a gif wider or taller than this is scaled down (a 4k screen stays sane)
  maxMs: 2 * 60 * 1000,  // a recording stops by itself after this long
  bar: { width: 236, height: 34 }, // the recording bar
  edge: 6,               // px round the recorded area for its frame (outside it, so never recorded)
};
const KEY_FIELDS = ['key', 'textKey', 'gifKey'];

module.exports = function snipr(host) {
  const { ipc: ipcMain, shortcuts: globalShortcut } = host;

  // ---------------------------------------------------------------------------
  // log + settings  (one JSON file in host.dataDir)
  // ---------------------------------------------------------------------------

  function logLine(msg) {
    try {
      const file = path.join(host.dataDir, 'snipr.log');
      let old = '';
      try { old = fs.readFileSync(file, 'utf8'); } catch (_) {}
      if (old.length > 50000) old = old.slice(-20000);
      fs.writeFileSync(file, old + new Date().toISOString() + ' ' + msg + '\n', 'utf8');
    } catch (_) {}
  }

  const SETTINGS_VERSION = 2;
  const SETTINGS_FILE = () => path.join(host.dataDir, 'snipr-settings.json');
  const defaultFolder = () => path.join(app.getPath('pictures'), 'snipr');

  // key:          the system-wide "snip" shortcut
  // textKey:      the system-wide "snip text" shortcut (windows): drag, and the text is on the clipboard
  // gifKey:       the system-wide "record gif" shortcut: drag, rec, and again to stop
  // copy:        every snip goes to the clipboard right away
  // open:         show the snip in its own window after capture
  // autoSave:     also save every snip to the folder right away
  // folder:       where snips are saved (null = Pictures/snipr)
  // closeAfterCopy: a snip window closes once you copy it
  // ink:          annotation colour: ghost (white, dark halo), red, black
  // border:       px of window round a snip's image (0 = the image edge to edge)
  // font:         the font text marks are written in (notr's font list)
  // onTop:        snip windows stay in front of other programs
  // confirmDiscard: ask before closing a snip with unsaved marks
  const defaults = () => ({
    key: Keys.DEFAULT,
    textKey: Keys.TEXT_DEFAULT,
    gifKey: Keys.GIF_DEFAULT,
    copy: true,
    open: true,
    autoSave: false,
    closeAfterCopy: false,
    folder: null,
    ink: 'ghost',
    border: 0,
    font: Fonts.DEFAULT,
    onTop: false,
    confirmDiscard: true,
    startup: true,
    welcomed: false,
    version: SETTINGS_VERSION,
  });

  let settings = defaults();
  let saveTimer = null;

  function loadSettings() {
    for (const file of [SETTINGS_FILE(), SETTINGS_FILE() + '.bak']) {
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (raw && typeof raw === 'object') {
          settings = { ...defaults(), ...raw };
          settings.key = Keys.normalize(settings.key) || Keys.DEFAULT;
          settings.textKey = Keys.normalize(settings.textKey) || Keys.TEXT_DEFAULT;
          if (settings.textKey === settings.key) settings.textKey = settings.key === Keys.TEXT_DEFAULT ? Keys.DEFAULT : Keys.TEXT_DEFAULT;
          settings.gifKey = Keys.normalize(settings.gifKey) || Keys.GIF_DEFAULT;
          if (settings.gifKey === settings.key || settings.gifKey === settings.textKey) {
            settings.gifKey = [Keys.GIF_DEFAULT, 'alt+shift+r', 'ctrl+alt+shift+g'].find((k) => k !== settings.key && k !== settings.textKey);
          }
          if (!INKS.includes(settings.ink)) settings.ink = 'ghost';
          if (!BORDERS.includes(settings.border)) settings.border = 0;
          if (!Fonts.FONTS.includes(settings.font)) settings.font = Fonts.DEFAULT;
          // v2: snips no longer stay on top unless you turn it on
          if ((raw.version || 1) < 2) settings.onTop = false;
          settings.version = SETTINGS_VERSION;
          if (settings.folder && typeof settings.folder !== 'string') settings.folder = null;
          return;
        }
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
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, json, 'utf8');
      try { fs.renameSync(tmp, file); } catch (_) { fs.writeFileSync(file, json, 'utf8'); }
    } catch (err) {
      logLine('could not save settings: ' + err.message);
    }
  }
  const scheduleSave = () => { clearTimeout(saveTimer); saveTimer = setTimeout(writeSettingsNow, 300); };

  const folder = () => settings.folder || defaultFolder();

  // The snip folder is made up front, so it's there before the first save.
  function ensureFolder() {
    try { fs.mkdirSync(folder(), { recursive: true }); } catch (err) { logLine('could not create the folder: ' + err.message); }
  }

  // "C:\Users\me\Pictures\snipr" -> "~\pictures\snipr" (lowercase, like the rest of the UI)
  function shortPath(p) {
    const home = os.homedir();
    let s = p.startsWith(home) ? '~' + p.slice(home.length) : p;
    return s.toLowerCase();
  }

  const publicSettings = () => ({
    key: settings.key,
    textKey: settings.textKey,
    textKeyOk: registered.textKey !== null || keyPaused || !Ocr.available,
    gifKey: settings.gifKey,
    gifKeyOk: registered.gifKey !== null || keyPaused,
    ocr: Ocr.available,
    copy: settings.copy,
    open: settings.open,
    autoSave: settings.autoSave,
    closeAfterCopy: settings.closeAfterCopy,
    folder: shortPath(folder()),
    ink: settings.ink,
    border: settings.border,
    font: settings.font,
    onTop: settings.onTop,
    confirmDiscard: settings.confirmDiscard,
    startup: settings.startup,
    keyOk: registered.key !== null || keyPaused,
    platform: process.platform,
    version: host.version,
    hosted: true, // utilr starts snipr at login and quits it: those rows go
  });

  // ---------------------------------------------------------------------------
  // animation (window opacity / position), same easing as notr
  // ---------------------------------------------------------------------------

  const easeOut = (t) => 1 - Math.pow(1 - t, 3);

  function animate(win, from, to, ms, done) {
    const start = Date.now();
    const step = () => {
      if (win.isDestroyed()) return;
      const t = Math.min(1, (Date.now() - start) / ms);
      const k = easeOut(t);
      const lerp = (a, b) => a + (b - a) * k;
      if (from.x !== undefined) {
        win.setBounds({ x: Math.round(lerp(from.x, to.x)), y: Math.round(lerp(from.y, to.y)), width: to.width, height: to.height });
      }
      if (from.opacity !== undefined) win.setOpacity(lerp(from.opacity, to.opacity));
      if (t < 1) setTimeout(step, 8);
      else if (done) done();
    };
    step();
  }

  function fadeOutAndDestroy(win, ms = 140) {
    if (!win || win.isDestroyed()) return;
    animate(win, { opacity: win.getOpacity() }, { opacity: 0 }, ms, () => { if (!win.isDestroyed()) win.destroy(); });
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
  // up and back down (thumbnails are fitted into the requested box).
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

  const overlays = new Map(); // display.id -> BrowserWindow
  let session = null;         // the capture in progress
  let sessionSeq = 0;

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
      title: 'snipr',
      icon: ICON,
      webPreferences: webPrefs({ backgroundThrottling: false }),
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    if (IS_MAC) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.loadFile(path.join(__dirname, 'overlay.html'));
    lockDown(win);
    win.on('close', (e) => { if (!quitting) { e.preventDefault(); cancelCapture(); } });
    win.on('closed', () => { if (overlays.get(d.id) === win) overlays.delete(d.id); });
    win.displayKey = JSON.stringify([d.bounds, d.scaleFactor]);
    win.loaded = new Promise((res) => win.webContents.once('did-finish-load', res));
    return win;
  }

  // Keep one hidden overlay per display, ready to show; rebuilt when screens
  // change. With utilr's RAM saver on, they're only made when you snip
  // (make), and closed after a few minutes unused (cool).
  const saving = () => !!(host.ramSaver && host.ramSaver());
  function syncOverlays(make = !saving()) {
    const displays = screen.getAllDisplays();
    const ids = new Set(displays.map((d) => d.id));
    for (const [id, win] of overlays) {
      const d = displays.find((x) => x.id === id);
      if (!ids.has(id) || !d || win.displayKey !== JSON.stringify([d.bounds, d.scaleFactor])) {
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
      if (session || quitting) return;
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
    ensureToast();
  }

  // mode 'image': the snip (clipboard, window, folder, as set); 'text': only its text, to the clipboard;
  // 'gif': the area to record
  async function startCapture(origin = 'key', mode = 'image') {
    if (session) return;
    if (mode === 'text' && !Ocr.available) return;
    if (mode === 'gif' && rec) return;
    const sid = ++sessionSeq;
    session = { sid, origin, mode, shots: null, displays: null, ready: new Set() };
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
      session.shots = shots;
      session.displays = displays;
      const t1 = Date.now();

      await Promise.all([...overlays.values()].map((w) => w.loaded));
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
          key: Keys.label(settings.key),
          mode,
        });
      }
      // Shown invisible first (a hidden window doesn't paint), then made opaque
      // once every overlay has drawn its screen, so nothing stale ever flashes.
      const ready = new Promise((res) => {
        const check = () => { if (!session || session.sid !== sid || session.ready.size >= shots.size) res(); };
        session.onReady = check;
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
      logLine(`capture ${displays.length} screen(s): grab ${t1 - t0} ms, shown ${Date.now() - t0} ms`);
    } catch (err) {
      logLine('capture failed: ' + (err && err.stack || err));
      endSession();
      toast(IS_MAC ? 'allow screen recording for snipr' : 'could not capture the screen', '', 2600);
    }
  }

  function hideOverlays(fade) {
    for (const win of overlays.values()) {
      if (win.isDestroyed() || !win.isVisible()) continue;
      const done = () => {
        if (win.isDestroyed()) return;
        win.setOpacity(0);
        win.hide();
        win.webContents.send('overlay:reset');
      };
      if (fade) animate(win, { opacity: 1 }, { opacity: 0 }, 130, done);
      else done();
    }
  }

  function endSession() {
    session = null;
    cool();
  }

  function cancelCapture() {
    if (!session) return;
    endSession();
    hideOverlays(false);
  }

  // The overlay sends back a rectangle in its own window (DIP) coordinates.
  async function finishCapture(win, rect) {
    if (!session || !session.shots) return;
    const entry = [...overlays.entries()].find(([, w]) => w === win);
    if (!entry) return;
    const d = session.displays.find((x) => x.id === entry[0]);
    const shot = session.shots.get(entry[0]);
    if (!d || !shot) return;
    const { mode } = session;
    endSession();

    // gif: nothing is cut out of the frozen screen; the live one is recorded
    if (mode === 'gif') {
      hideOverlays(false);
      startRecording(d, rect);
      return;
    }

    const s = d.scaleFactor;
    const full = shot.getSize();
    const px = {
      x: Math.max(0, Math.min(full.width - 1, Math.round(rect.x * s))),
      y: Math.max(0, Math.min(full.height - 1, Math.round(rect.y * s))),
    };
    px.width = Math.max(1, Math.min(full.width - px.x, Math.round(rect.width * s)));
    px.height = Math.max(1, Math.min(full.height - px.y, Math.round(rect.height * s)));
    const img = shot.crop(px);
    const png = img.toPNG();
    const snip = { png, width: px.width, height: px.height, scale: s, at: new Date() };

    // snip text: no window, no image on the clipboard, nothing saved; just the text
    if (mode === 'text') {
      hideOverlays(false);
      const slow = setTimeout(() => toast('reading text…', '', 0), 250);
      const r = await copyText(png, snip);
      clearTimeout(slow);
      if (r.lines) toast('text copied', r.lines === 1 ? '1 line' : `${r.lines} lines`);
      else toast(r.error ? textError(r.error) : 'no text found', '', 2200);
      return;
    }

    const done = [];
    if (settings.copy) { copyPng(png); snip.clipHash = pixelHash(img); done.push('copied'); } // not awaited: the snip opens at once
    if (settings.autoSave) {
      try { snip.savedTo = saveBuffer(png, snip.at); snip.autoSaved = true; done.push('saved'); } catch (err) { logLine('auto save failed: ' + err.message); }
    }

    if (settings.open) {
      openSnip(snip, d, rect, done);
      hideOverlays(true);
    } else {
      hideOverlays(false);
      toast(done.length ? done.join(' · ') : 'snipped', `${px.width} × ${px.height}`);
    }
  }

  // ---------------------------------------------------------------------------
  // clipboard + saving
  // ---------------------------------------------------------------------------

  // A fingerprint of an image's pixels (not its png bytes, which differ per encoder).
  const pixelHash = (img) => crypto.createHash('sha256').update(img.toBitmap()).digest('hex');

  // fingerprint of the image on the clipboard, or null when there is none
  async function clipboardHash() {
    try {
      const items = await clipboard.read();
      const item = items.find((i) => i.types.includes('image/png'));
      if (!item) return null;
      const blob = await item.getType('image/png');
      return pixelHash(nativeImage.createFromBuffer(Buffer.from(await blob.arrayBuffer())));
    } catch (_) {
      return null;
    }
  }

  // Electron's clipboard is the async, W3C-shaped one: a PNG blob goes in as an image.
  async function copyPng(buf) {
    try {
      await clipboard.write([new ClipboardItem({ 'image/png': new Blob([buf], { type: 'image/png' }) })]);
      return true;
    } catch (err) {
      logLine('copy failed: ' + err.message);
      return false;
    }
  }

  // The text in a png, laid out like it was on screen, onto the clipboard.
  // -> { lines, text } (lines 0 = none found) or { error }
  async function copyText(png, size) {
    const t0 = Date.now();
    try {
      const r = await Ocr.textOf(png, size);
      logLine(`text ${size.width}×${size.height}: ${r.lines} lines in ${Date.now() - t0} ms`);
      if (!r.lines) return { lines: 0 };
      await clipboard.writeText(r.text);
      return { lines: r.lines, text: r.text };
    } catch (err) {
      logLine('text failed: ' + err.message);
      return { error: err.message };
    }
  }

  const textError = (msg) => (msg === 'no-language' ? 'no ocr language in windows' : 'could not read the text');


  const pad = (n) => String(n).padStart(2, '0');
  const stamp = (t) => `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}-${pad(t.getHours())}${pad(t.getMinutes())}${pad(t.getSeconds())}`;

  function freeName(dir, base, ext = '.png') {
    let name = base + ext, n = 2;
    while (fs.existsSync(path.join(dir, name))) name = `${base}-${n++}${ext}`;
    return path.join(dir, name);
  }

  function saveBuffer(buf, at) {
    const dir = folder();
    fs.mkdirSync(dir, { recursive: true });
    const file = freeName(dir, 'snip-' + stamp(at));
    fs.writeFileSync(file, buf);
    return file;
  }

  function openFolder() {
    const dir = folder();
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    shell.openPath(dir);
  }

  // ---------------------------------------------------------------------------
  // snip windows: the capture, lifted off the screen where it was taken
  // ---------------------------------------------------------------------------

  const snips = new Map(); // webContents.id -> { win, snip }
  let quitting = false;

  function snipBounds(d, rect) {
    const wa = d.workArea;
    const m = settings.border;
    const padW = 2 * m, padH = BAR_H + STATUS_H + 2 * m;
    const maxW = Math.floor(wa.width * 0.9) - padW;
    const maxH = Math.floor(wa.height * 0.9) - padH;
    const k = Math.min(1, maxW / rect.width, maxH / rect.height);
    const iw = Math.round(rect.width * k), ih = Math.round(rect.height * k);
    const width = Math.max(SNIP_MIN.width, iw + padW);
    const height = Math.max(SNIP_MIN.height, ih + padH);
    let x, y;
    if (k === 1) {
      // the image stays exactly where it was on screen; the border and chrome grow around it
      x = Math.round(d.bounds.x + rect.x - (width - iw) / 2);
      y = Math.round(d.bounds.y + rect.y - BAR_H - m - (height - padH - ih) / 2);
    } else {
      x = Math.round(wa.x + (wa.width - width) / 2);
      y = Math.round(wa.y + (wa.height - height) / 2);
    }
    x = Math.max(wa.x, Math.min(wa.x + wa.width - width, x));
    y = Math.max(wa.y, Math.min(wa.y + wa.height - height, y));
    return { x, y, width, height };
  }

  function applyOnTop(win) {
    if (win.isDestroyed()) return;
    if (settings.onTop) win.setAlwaysOnTop(true, 'floating');
    else win.setAlwaysOnTop(false);
  }

  function openSnip(snip, d, rect, done) {
    const b = snipBounds(d, rect);
    const win = new BrowserWindow({
      ...b,
      minWidth: SNIP_MIN.width,
      minHeight: SNIP_MIN.height,
      frame: false,
      resizable: true,
      maximizable: false,
      fullscreenable: false,
      show: false,
      opacity: 0,
      title: 'snipr',
      icon: ICON,
      backgroundColor: BG,
      webPreferences: webPrefs(),
    });
    applyOnTop(win);
    snips.set(win.webContents.id, { win, snip, done });
    const wcId = win.webContents.id;
    win.loadFile(path.join(__dirname, 'snip.html'));
    lockDown(win);
    win.once('ready-to-show', () => {
      win.setBounds(b);
      win.show();
      win.focus();
      animate(win, { opacity: 0 }, { opacity: 1 }, 220);
    });
    win.on('closed', () => snips.delete(wcId));
    win.webContents.on('render-process-gone', () => { if (!win.isDestroyed()) win.reload(); });
  }

  const snipOf = (e) => snips.get(e.sender.id);

  // ---------------------------------------------------------------------------
  // toast: a small ghost panel in the corner ("copied  1280 × 720")
  // ---------------------------------------------------------------------------

  let toastWin = null;
  let toastTimer = null;
  const TOAST = { width: 300, height: 40 };

  function ensureToast() {
    if (toastWin && !toastWin.isDestroyed()) return toastWin;
    toastWin = new BrowserWindow({
      width: TOAST.width,
      height: TOAST.height,
      frame: false,
      show: false,
      transparent: true,
      resizable: false,
      movable: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      title: 'snipr',
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

  // "snip in 3 s": counts down in the toast, which is gone before the capture.
  let delayTimer = null;
  function delayedCapture(seconds = 3) {
    clearTimeout(delayTimer);
    let left = seconds;
    const tick = () => {
      if (left === 0) { hideToast(); delayTimer = setTimeout(() => startCapture('delay'), 260); return; }
      toast(`snip in ${left}`, '', 0);
      left -= 1;
      delayTimer = setTimeout(tick, 1000);
    };
    tick();
  }

  // ---------------------------------------------------------------------------
  // gif: record an area of the screen
  //
  // You drag the area on the frozen screen like a snip. Then the live screen is
  // back with a thin frame just outside the area (so the frame is never in the
  // gif) and a small bar beside it: rec, rec in 3, cancel. The bar is the
  // recorder: it streams the screen, crops each frame to the area and hands it
  // to the encoder (gif-worker.js). The bar never takes the focus, so the app
  // you're recording keeps it. The gif shortcut again: rec now / cancel the
  // countdown / stop. The gif goes to the folder and opens in a gif window.
  // ---------------------------------------------------------------------------

  let rec = null; // { d, rect, sourceId, state: 'starting'|'ready'|'count'|'rec'|'saving', at, bar, frame }

  const recAbs = (r) => ({ x: r.d.bounds.x + r.rect.x, y: r.d.bounds.y + r.rect.y, width: r.rect.width, height: r.rect.height });

  // under the area, right-aligned; above it when there's no room; inside it
  // (and kept out of the recording, where Windows allows) when neither fits
  function recBarBounds(r) {
    const a = recAbs(r), b = r.d.bounds, { width, height } = GIF.bar, gap = 12;
    let x = a.x + a.width - width, y = a.y + a.height + gap, inside = false;
    if (y + height > b.y + b.height) {
      y = a.y - height - gap;
      if (y < b.y) { y = a.y + a.height - height - gap; x -= gap; inside = true; }
    }
    x = Math.max(b.x, Math.min(b.x + b.width - width, x));
    y = Math.max(b.y, Math.min(b.y + b.height - height, y));
    return { bounds: { x, y, width, height }, inside };
  }

  async function startRecording(d, rect) {
    if (rec) return;
    // whole DIPs, at least 8 × 8, inside the display
    const W = d.bounds.width, H = d.bounds.height;
    const x = Math.max(0, Math.min(W - 8, Math.round(rect.x)));
    const y = Math.max(0, Math.min(H - 8, Math.round(rect.y)));
    const r = {
      x, y,
      width: Math.max(8, Math.min(W - x, Math.round(rect.width))),
      height: Math.max(8, Math.min(H - y, Math.round(rect.height))),
    };
    rec = { d, rect: r, sourceId: null, state: 'starting', at: new Date(), bar: null, frame: null };
    const mine = rec;
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
      const i = screen.getAllDisplays().findIndex((x) => x.id === d.id);
      const src = sources.find((s) => s.display_id && s.display_id === String(d.id)) || sources[i] || sources[0];
      if (!src) throw new Error('no screen source');
      mine.sourceId = src.id;
    } catch (err) {
      if (rec === mine) rec = null;
      logLine('gif: no source: ' + err.message);
      toast(IS_MAC ? 'allow screen recording for snipr' : 'could not record the screen', '', 2600);
      return;
    }
    if (rec !== mine || quitting) return;
    mine.state = 'ready';
    mine.frame = makeRecFrame(mine);
    mine.bar = makeRecBar(mine);
    host.changed();
    logLine(`gif: area ${r.width}×${r.height} at ${r.x},${r.y} (scale ${d.scaleFactor})`);
  }

  function makeRecFrame(r) {
    const a = recAbs(r), m = GIF.edge;
    const b = { x: a.x - m, y: a.y - m, width: a.width + 2 * m, height: a.height + 2 * m };
    const win = new BrowserWindow({
      ...b,
      frame: false,
      show: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      enableLargerThanScreen: true,
      alwaysOnTop: true,
      title: 'snipr',
      webPreferences: webPrefs(),
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setIgnoreMouseEvents(true);
    if (IS_MAC) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.loadFile(path.join(__dirname, 'frame.html'));
    lockDown(win);
    win.once('ready-to-show', () => {
      if (win.isDestroyed()) return;
      win.setBounds(b); // twice: Windows can rescale a window moved between DPIs
      win.setBounds(b);
      win.showInactive();
    });
    return win;
  }

  function makeRecBar(r) {
    const { bounds, inside } = recBarBounds(r);
    const win = new BrowserWindow({
      ...bounds,
      frame: false,
      show: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false, // clicks work, but the app being recorded keeps the focus
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      title: 'snipr',
      icon: ICON,
      backgroundColor: BG,
      webPreferences: webPrefs({ backgroundThrottling: false }),
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    if (inside) win.setContentProtection(true); // over the area: kept out of the gif where the system allows
    if (IS_MAC) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.loadFile(path.join(__dirname, 'rec.html'));
    lockDown(win);
    win.once('ready-to-show', () => {
      if (win.isDestroyed()) return;
      win.setBounds(bounds);
      win.setBounds(bounds);
      win.showInactive();
    });
    // closed some other way (alt+f4): the recording goes with it
    win.on('closed', () => { if (rec && rec.bar === win) endRec(); });
    win.webContents.on('render-process-gone', () => { if (rec && rec.bar === win) { endRec(); toast('recording stopped', '', 2200); } });
    return win;
  }

  function endRec() {
    const r = rec;
    rec = null;
    if (!r) return;
    for (const w of [r.frame, r.bar]) if (w && !w.isDestroyed()) w.destroy();
    host.changed();
  }

  const recFrom = (e) => rec && rec.bar && !rec.bar.isDestroyed() && e.sender === rec.bar.webContents;

  // the gif shortcut / action: start one, or tell the bar (rec now, cancel the countdown, stop)
  function gifKey(origin = 'key') {
    if (rec) {
      if (rec.bar && !rec.bar.isDestroyed()) rec.bar.webContents.send('rec:key');
      return;
    }
    startCapture(origin, 'gif');
  }

  // the tray / launcher row follows the recording
  function gifLabel() {
    if (!rec) return 'record gif';
    return { ready: 'start recording', count: 'cancel recording', rec: 'stop recording' }[rec.state] || 'saving gif…';
  }

  const kb = (n) => (n < 1024 * 1024 ? Math.max(1, Math.round(n / 1024)) + ' kb' : (n / 1024 / 1024).toFixed(1) + ' mb');
  const secs = (ms) => (ms / 1000).toFixed(1) + ' s';

  // ---------------------------------------------------------------------------
  // gif windows: the recording, lifted off the screen where it was made
  // ---------------------------------------------------------------------------

  const gifs = new Map(); // webContents.id -> { win, gif }

  function openGif(gif, d, rect) {
    const b = snipBounds(d, rect);
    const win = new BrowserWindow({
      ...b,
      minWidth: SNIP_MIN.width,
      minHeight: SNIP_MIN.height,
      frame: false,
      resizable: true,
      maximizable: false,
      fullscreenable: false,
      show: false,
      opacity: 0,
      title: 'snipr',
      icon: ICON,
      backgroundColor: BG,
      webPreferences: webPrefs(),
    });
    applyOnTop(win);
    const wcId = win.webContents.id;
    gifs.set(wcId, { win, gif });
    win.loadFile(path.join(__dirname, 'gif.html'));
    lockDown(win);
    win.once('ready-to-show', () => {
      win.setBounds(b);
      win.show();
      win.focus();
      animate(win, { opacity: 0 }, { opacity: 1 }, 220);
    });
    win.on('closed', () => gifs.delete(wcId));
    win.webContents.on('render-process-gone', () => { if (!win.isDestroyed()) win.reload(); });
  }

  const gifOf = (e) => gifs.get(e.sender.id);

  // ---------------------------------------------------------------------------
  // settings window (tray → settings); the same menu also drops from a snip's gear
  // ---------------------------------------------------------------------------

  let settingsWin = null;

  function openSettings() {
    if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.show(); settingsWin.focus(); return; }
    const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    // + the text key row; + the gif key row; - start at login and quit, which are utilr's in utilr
    const width = 320, height = 582 + (Ocr.available ? 34 : 0) + 34 - 2 * 34;
    settingsWin = new BrowserWindow({
      x: Math.round(wa.x + (wa.width - width) / 2),
      y: Math.round(wa.y + (wa.height - height) / 3),
      width, height,
      frame: false,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      show: false,
      opacity: 0,
      title: 'snipr',
      icon: ICON,
      backgroundColor: BG,
      webPreferences: webPrefs(),
    });
    settingsWin.loadFile(path.join(__dirname, 'settings.html'));
    lockDown(settingsWin);
    const win = settingsWin;
    win.once('ready-to-show', () => { win.show(); animate(win, { opacity: 0 }, { opacity: 1 }, 220); });
    win.on('closed', () => { if (settingsWin === win) settingsWin = null; });
  }

  // Every window snipr has open. Other tools share the process, so snipr only
  // ever talks to these.
  const ownWindows = () => [
    ...overlays.values(),
    ...[...snips.values()].map((x) => x.win),
    ...[...gifs.values()].map((x) => x.win),
    rec && rec.bar,
    rec && rec.frame,
    toastWin,
    settingsWin,
  ].filter((w) => w && !w.isDestroyed());

  function broadcast(channel, ...args) {
    for (const w of ownWindows()) w.webContents.send(channel, ...args);
  }

  // ---------------------------------------------------------------------------
  // the snip key (system-wide)
  // ---------------------------------------------------------------------------

  // three keys: key = snip, textKey = snip text (windows only), gifKey = record gif
  const registered = { key: null, textKey: null, gifKey: null };
  const KEY_NAMES = { key: 'snip shortcut', textKey: 'text shortcut', gifKey: 'gif shortcut' };
  const KEY_ACTIONS = { key: () => startCapture('key'), textKey: () => startCapture('key', 'text'), gifKey: () => gifKey('key') };
  // which of snipr's other keys already has this combo (null = none)
  const holder = (field, combo) => KEY_FIELDS.find((f) => f !== field && settings[f] === combo) || null;
  let keyPaused = false;

  // (re)registers one of the keys; false when another program has it
  function registerOne(field) {
    if (registered[field]) {
      try { globalShortcut.unregister(registered[field]); } catch (_) {}
      registered[field] = null;
    }
    if (keyPaused || (field === 'textKey' && !Ocr.available)) return true;
    const accel = Keys.toAccelerator(settings[field]);
    try {
      if (globalShortcut.register(accel, KEY_ACTIONS[field])) {
        registered[field] = accel;
        logLine(`${KEY_NAMES[field]} ready: ${accel}`);
        return true;
      }
      logLine(`${KEY_NAMES[field]} NOT available (another program has it): ${accel}`);
    } catch (err) {
      logLine(`${KEY_NAMES[field]} failed: ${accel} ${err.message}`);
    }
    return false;
  }

  function registerKey() {
    const ok = registerOne('key');
    registerOne('textKey');
    registerOne('gifKey');
    return ok;
  }

  // ---------------------------------------------------------------------------
  // IPC
  // ---------------------------------------------------------------------------

  ipcMain.handle('settings:get', () => publicSettings());

  ipcMain.on('settings:set', (_e, patch) => {
    if (!patch || typeof patch !== 'object') return;
    const s = settings;
    for (const k of ['copy', 'open', 'autoSave', 'closeAfterCopy', 'confirmDiscard']) if (typeof patch[k] === 'boolean') s[k] = patch[k];
    if (INKS.includes(patch.ink)) s.ink = patch.ink;
    if (Fonts.FONTS.includes(patch.font)) s.font = patch.font;
    if (BORDERS.includes(patch.border) && patch.border !== s.border) {
      // open snips grow or shrink round their image, which stays where it is
      const d = patch.border - s.border;
      s.border = patch.border;
      for (const { win } of snips.values()) {
        if (win.isDestroyed()) continue;
        const b = win.getBounds();
        win.setBounds({ x: b.x - d, y: b.y - d, width: b.width + 2 * d, height: b.height + 2 * d });
      }
    }
    if (typeof patch.onTop === 'boolean' && patch.onTop !== s.onTop) {
      s.onTop = patch.onTop;
      for (const { win } of snips.values()) applyOnTop(win);
    }
    for (const field of KEY_FIELDS) {
      if (typeof patch[field] !== 'string') continue;
      const combo = Keys.normalize(patch[field]);
      if (!combo || combo === s[field]) continue;
      if (holder(field, combo)) { broadcast('settings:key-taken', Keys.label(combo), field); continue; } // another snipr key has it
      const old = s[field];
      s[field] = combo;
      if (!registerOne(field)) { s[field] = old; registerOne(field); broadcast('settings:key-taken', Keys.label(combo), field); }
    }
    broadcast('settings:changed', publicSettings());
    scheduleSave();
  });

  // while the settings menu records a new key, the old one must not fire
  ipcMain.on('key:record', (_e, on) => { keyPaused = !!on; registerKey(); });

  ipcMain.handle('folder:choose', async (e) => {
    const parent = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showOpenDialog(parent, { title: 'snipr folder', defaultPath: folder(), properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    settings.folder = r.filePaths[0] === defaultFolder() ? null : r.filePaths[0];
    ensureFolder();
    scheduleSave();
    broadcast('settings:changed', publicSettings());
    return shortPath(folder());
  });
  ipcMain.on('folder:open', openFolder);
  ipcMain.on('win:close', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    fadeOutAndDestroy(win);
  });

  // overlay
  ipcMain.on('overlay:ready', (_e, sid) => {
    if (!session || session.sid !== sid) return;
    session.ready.add(sid + ':' + _e.sender.id);
    if (session.onReady) session.onReady();
  });
  ipcMain.on('overlay:done', (e, sid, rect) => {
    if (!session || session.sid !== sid || !rect) return;
    const win = BrowserWindow.fromWebContents(e.sender);
    const r = { x: +rect.x, y: +rect.y, width: +rect.width, height: +rect.height };
    if (![r.x, r.y, r.width, r.height].every(Number.isFinite) || r.width < 1 || r.height < 1) return;
    finishCapture(win, r);
  });
  ipcMain.on('overlay:cancel', () => cancelCapture());

  // snip window
  ipcMain.handle('snip:init', (e) => {
    const s = snipOf(e);
    if (!s) return null;
    return {
      png: s.snip.png,
      width: s.snip.width,
      height: s.snip.height,
      scale: s.snip.scale,
      done: s.done || [],
      name: 'snip-' + stamp(s.snip.at),
      settings: publicSettings(),
    };
  });

  const toBuffer = (s, png) => (png && png.length ? Buffer.from(png) : s.snip.png);

  ipcMain.handle('snip:copy', async (e, png) => {
    const s = snipOf(e);
    if (!s) return false;
    const buf = toBuffer(s, png);
    await copyPng(buf);
    s.snip.clipHash = pixelHash(nativeImage.createFromBuffer(buf));
    return true;
  });

  // copy text: png is the snip with only its blurs (null = no blurs, the original),
  // so blurred text stays unreadable and drawn marks don't garble the rest
  ipcMain.handle('snip:text', async (e, png) => {
    const s = snipOf(e);
    if (!s) return { error: 'gone' };
    const r = await copyText(toBuffer(s, png), s.snip);
    if (r.text) s.snip.textClip = r.text;
    return { lines: r.lines || 0, error: r.error && textError(r.error) };
  });

  ipcMain.handle('snip:save', async (e, png, ask) => {
    const s = snipOf(e);
    if (!s) return null;
    const buf = toBuffer(s, png);
    try {
      if (ask) {
        const dir = folder();
        try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
        const r = await dialog.showSaveDialog(s.win, {
          title: 'save snip',
          defaultPath: freeName(dir, 'snip-' + stamp(s.snip.at)),
          filters: [{ name: 'PNG', extensions: ['png'] }],
        });
        if (r.canceled || !r.filePath) return null;
        fs.writeFileSync(r.filePath, buf);
        return shortPath(r.filePath);
      }
      // save again = update this snip's file (no -2, -3 copies of the same snip)
      if (s.snip.savedTo && fs.existsSync(path.dirname(s.snip.savedTo))) fs.writeFileSync(s.snip.savedTo, buf);
      else s.snip.savedTo = saveBuffer(buf, s.snip.at);
      return shortPath(s.snip.savedTo);
    } catch (err) {
      logLine('save failed: ' + err.message);
      return { error: err.message };
    }
  });

  // drag the snip out of its window, into a chat, a folder, a document…
  // After a blur, the unblurred original must not be left behind. snipr put it
  // on the clipboard (auto copy) and maybe in the folder (auto save) the moment
  // the snip was taken; both get the blurred version. The clipboard only if it
  // still holds exactly what this snip put there (compared pixel for pixel), so
  // anything you copied since is left alone. The same goes for text copied from
  // the snip: it is read again from the blurred version (textPng: only the blurs).
  ipcMain.handle('snip:secure', async (e, png, textPng) => {
    const s = snipOf(e);
    if (!s || !png || !png.length) return [];
    const buf = Buffer.from(png);
    const done = [];
    if (s.snip.clipHash && (await clipboardHash()) === s.snip.clipHash) {
      if (await copyPng(buf)) {
        s.snip.clipHash = pixelHash(nativeImage.createFromBuffer(buf));
        done.push('clipboard');
      }
    } else if (s.snip.textClip && textPng && textPng.length) {
      let now = null;
      try { now = await clipboard.readText(); } catch (_) {}
      if (now === s.snip.textClip) {
        const r = await copyText(Buffer.from(textPng), s.snip);
        if (r.text) s.snip.textClip = r.text;
        else { await clipboard.writeText(''); s.snip.textClip = null; } // nothing readable left
        done.push('clipboard');
      }
    }
    if (s.snip.autoSaved && s.snip.savedTo && fs.existsSync(s.snip.savedTo)) {
      try { fs.writeFileSync(s.snip.savedTo, buf); done.push('file'); } catch (err) { logLine('could not update the saved snip: ' + err.message); }
    }
    return done;
  });

  ipcMain.on('snip:drag', (e, png) => {
    const s = snipOf(e);
    if (!s) return;
    try {
      const dir = path.join(os.tmpdir(), 'snipr');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'snip-' + stamp(s.snip.at) + '.png');
      fs.writeFileSync(file, toBuffer(s, png));
      const img = nativeImage.createFromPath(file);
      const { width } = img.getSize();
      const icon = width > 96 ? img.resize({ width: 96, quality: 'good' }) : img;
      e.sender.startDrag({ file, icon: icon.isEmpty() ? nativeImage.createFromPath(ICON) : icon });
    } catch (err) {
      logLine('drag failed: ' + err.message);
    }
  });

  ipcMain.on('snip:close', (e) => {
    const s = snipOf(e);
    if (s) fadeOutAndDestroy(s.win);
  });

  ipcMain.on('snip:new', () => startCapture('snip'));

  // the recording bar
  ipcMain.handle('rec:init', (e) => {
    if (!recFrom(e)) return null;
    const { d, rect } = rec;
    return {
      sourceId: rec.sourceId,
      crop: rect,                                              // DIPs, in the display
      display: { width: d.bounds.width, height: d.bounds.height },
      scale: d.scaleFactor,
      fps: GIF.fps,
      maxSide: GIF.maxSide,
      maxMs: GIF.maxMs,
      key: Keys.label(settings.gifKey),
    };
  });

  ipcMain.on('rec:state', (e, state) => {
    if (!recFrom(e) || !['ready', 'count', 'rec', 'saving'].includes(state)) return;
    rec.state = state;
    const fr = rec.frame;
    if (fr && !fr.isDestroyed()) {
      if (state === 'saving') { fr.destroy(); rec.frame = null; } // done recording: the area is free again
      else fr.webContents.send('rec:frame', state);
    }
    host.changed();
  });

  ipcMain.on('rec:cancel', (e) => { if (recFrom(e)) endRec(); });

  ipcMain.on('rec:fail', (e, msg) => {
    if (!recFrom(e)) return;
    logLine('gif failed: ' + msg);
    endRec();
    toast(IS_MAC ? 'allow screen recording for snipr' : 'could not record the screen', '', 2600);
  });

  // the finished gif: to the folder, then its window (or just a notice)
  ipcMain.handle('rec:done', async (e, bytes, meta) => {
    if (!recFrom(e) || !bytes || !bytes.length) return false;
    const { d, rect, at } = rec;
    endRec();
    const m = meta || {};
    const gif = {
      bytes: Buffer.from(bytes),
      width: m.width | 0,
      height: m.height | 0,
      ms: Math.max(0, +m.ms || 0),
      frames: m.frames | 0,
      lw: rect.width,  // the area's size on screen (DIPs): the window shows the gif at that size
      lh: rect.height,
      at,
      file: null,
    };
    try {
      const dir = folder();
      fs.mkdirSync(dir, { recursive: true });
      gif.file = freeName(dir, 'gif-' + stamp(at), '.gif');
      fs.writeFileSync(gif.file, gif.bytes);
    } catch (err) {
      logLine('gif: save failed: ' + err.message);
      toast('could not save the gif', '', 2600);
      return false;
    }
    logLine(`gif: ${gif.width}×${gif.height}, ${gif.frames} frames, ${secs(gif.ms)}, ${kb(gif.bytes.length)} -> ${gif.file}`);
    if (settings.open) openGif(gif, d, rect);
    else toast('gif saved', `${secs(gif.ms)} · ${kb(gif.bytes.length)}`);
    return true;
  });

  // gif window
  ipcMain.handle('gif:init', (e) => {
    const g = gifOf(e);
    if (!g) return null;
    const { gif } = g;
    return {
      bytes: gif.bytes,
      width: gif.width,
      height: gif.height,
      lw: gif.lw,
      lh: gif.lh,
      ms: gif.ms,
      size: kb(gif.bytes.length),
      name: gif.file ? path.basename(gif.file) : '',
      saved: gif.file ? shortPath(gif.file) : null,
      settings: publicSettings(),
    };
  });

  ipcMain.handle('gif:save-as', async (e) => {
    const g = gifOf(e);
    if (!g) return null;
    const r = await dialog.showSaveDialog(g.win, {
      title: 'save gif',
      defaultPath: g.gif.file || path.join(folder(), 'gif-' + stamp(g.gif.at) + '.gif'),
      filters: [{ name: 'GIF', extensions: ['gif'] }],
    });
    if (r.canceled || !r.filePath) return null;
    try {
      fs.writeFileSync(r.filePath, g.gif.bytes);
      return shortPath(r.filePath);
    } catch (err) {
      logLine('gif: save as failed: ' + err.message);
      return { error: err.message };
    }
  });

  ipcMain.on('gif:show', (e) => {
    const g = gifOf(e);
    if (g && g.gif.file && fs.existsSync(g.gif.file)) shell.showItemInFolder(g.gif.file);
    else openFolder();
  });

  // to the recycle bin (it can come back from there), and the window closes
  ipcMain.handle('gif:delete', async (e) => {
    const g = gifOf(e);
    if (!g) return false;
    if (g.gif.file && fs.existsSync(g.gif.file)) {
      try { await shell.trashItem(g.gif.file); } catch (err) {
        logLine('gif: delete failed: ' + err.message);
        return false;
      }
    }
    g.gif.file = null;
    fadeOutAndDestroy(g.win);
    toast('gif in the recycle bin');
    return true;
  });

  // drag the gif out of its window: the saved file itself (a temp copy if it's gone)
  ipcMain.on('gif:drag', (e, thumb) => {
    const g = gifOf(e);
    if (!g) return;
    try {
      let file = g.gif.file;
      if (!file || !fs.existsSync(file)) {
        const dir = path.join(os.tmpdir(), 'snipr');
        fs.mkdirSync(dir, { recursive: true });
        file = path.join(dir, 'gif-' + stamp(g.gif.at) + '.gif');
        fs.writeFileSync(file, g.gif.bytes);
      }
      // the window sends a small png of the gif for the drag icon (nativeImage can't read a gif)
      const img = thumb && thumb.length ? nativeImage.createFromBuffer(Buffer.from(thumb)) : null;
      e.sender.startDrag({ file, icon: img && !img.isEmpty() ? img : nativeImage.createFromPath(ICON) });
    } catch (err) {
      logLine('gif: drag failed: ' + err.message);
    }
  });

  ipcMain.on('gif:new', () => gifKey('gif'));

  // ---------------------------------------------------------------------------
  // snipr as utilr sees it
  // ---------------------------------------------------------------------------

  const onMetrics = () => { if (!session) syncOverlays(); };

  // Ready for the key: the overlays and the toast are made up front, hidden, so
  // a snip opens at once (with utilr's RAM saver on: when you snip). No window
  // shows until you snip.
  function start() {
    loadSettings();
    logLine(`start ${host.version} in utilr ${process.platform}`);
    ensureFolder();
    registerKey();
    if (!saving()) { syncOverlays(); ensureToast(); }
    screen.on('display-added', onDisplays);
    screen.on('display-removed', onDisplays);
    screen.on('display-metrics-changed', onMetrics);
  }

  // utilr quits, or snipr is removed: save, let go of the keys, close everything.
  function stop() {
    quitting = true;
    writeSettingsNow();
    clearTimeout(delayTimer);
    clearTimeout(toastTimer);
    endSession();
    endRec(); // a recording in progress is dropped
    clearTimeout(coolTimer);
    screen.removeListener('display-added', onDisplays);
    screen.removeListener('display-removed', onDisplays);
    screen.removeListener('display-metrics-changed', onMetrics);
    for (const field of Object.keys(registered)) {
      if (registered[field]) { try { globalShortcut.unregister(registered[field]); } catch (_) {} registered[field] = null; }
    }
    for (const w of ownWindows()) w.destroy();
  }

  // A key from utilr's keys page, with the same rules as the settings menu:
  // no two of snipr's keys can be the same.
  function setKey(field, raw) {
    if (!(field in registered) || (field === 'textKey' && !Ocr.available)) return { ok: false, error: 'unknown shortcut' };
    const combo = Keys.normalize(raw);
    if (!combo) return { ok: false, error: 'not a shortcut' };
    if (combo === settings[field]) return { ok: true };
    const other = holder(field, combo);
    if (other) return { ok: false, error: `${KEY_NAMES[other]} has it` };
    const old = settings[field];
    settings[field] = combo;
    if (!registerOne(field)) {
      settings[field] = old;
      registerOne(field);
      return { ok: false, error: 'another program has it' };
    }
    broadcast('settings:changed', publicSettings());
    scheduleSave();
    return { ok: true };
  }

  return {
    start,
    stop,
    open: () => startCapture('launch'),
    actions: () => [
      { id: 'snip', label: 'snip', key: 'key', run: () => startCapture('tray') },
      ...(Ocr.available ? [{ id: 'text', label: 'snip text', key: 'textKey', run: () => startCapture('tray', 'text') }] : []),
      { id: 'delay', label: 'snip in 3 seconds', run: () => delayedCapture(3) },
      { id: 'gif', label: gifLabel(), key: 'gifKey', run: () => gifKey('tray') },
      { id: 'folder', label: 'open folder', run: openFolder },
      { id: 'settings', label: 'settings', run: openSettings },
    ],
    keys: () => [
      { id: 'key', label: 'snip', combo: settings.key, ok: registered.key !== null || keyPaused },
      ...(Ocr.available ? [{ id: 'textKey', label: 'snip text', combo: settings.textKey, ok: registered.textKey !== null || keyPaused }] : []),
      { id: 'gifKey', label: 'record gif', combo: settings.gifKey, ok: registered.gifKey !== null || keyPaused },
    ],
    setKey,
    ramSaver: setRamSaver,
  };
};
