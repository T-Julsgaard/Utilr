'use strict';

const {
  app, BrowserWindow, ipcMain, screen, Menu, Tray, nativeImage, globalShortcut,
  desktopCapturer, clipboard, ClipboardItem, dialog, shell,
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Keys = require('./keys');
const Fonts = require('./fonts/list');

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

const BG = '#111111';          // ghost --bg, so windows never flash white
const BAR_H = 30;              // ghost --bar-h
const STATUS_H = 22;           // ghost --status-h
const SNIP_MIN = { width: 310, height: 150 };
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const ASSETS = path.join(__dirname, 'assets');
const ICON = path.join(ASSETS, IS_WIN ? 'snipr.ico' : 'snipr-256.png');
const INKS = ['ghost', 'red', 'black'];

function trayImage() {
  if (IS_WIN) return nativeImage.createFromPath(ICON);
  if (IS_MAC) {
    const img = nativeImage.createFromPath(path.join(ASSETS, 'trayTemplate.png'));
    img.setTemplateImage(true);
    return img;
  }
  return nativeImage.createFromPath(ICON).resize({ width: 24, height: 24 });
}

// Dev / test hook: keep a separate data folder (e.g. SNIPR_USER_DATA=C:\tmp\snipr).
if (process.env.SNIPR_USER_DATA) app.setPath('userData', process.env.SNIPR_USER_DATA);

// ---------------------------------------------------------------------------
// log + settings  (one JSON file in %APPDATA%\snipr)
// ---------------------------------------------------------------------------

function logLine(msg) {
  try {
    const file = path.join(app.getPath('userData'), 'snipr.log');
    let old = '';
    try { old = fs.readFileSync(file, 'utf8'); } catch (_) {}
    if (old.length > 50000) old = old.slice(-20000);
    fs.writeFileSync(file, old + new Date().toISOString() + ' ' + msg + '\n', 'utf8');
  } catch (_) {}
}

const SETTINGS_VERSION = 2;
const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'snipr-settings.json');
const defaultFolder = () => path.join(app.getPath('pictures'), 'snipr');

// key:          the system-wide "snip" shortcut
// copy:         every snip goes to the clipboard right away
// open:         show the snip in its own window after capture
// autoSave:     also save every snip to the folder right away
// folder:       where snips are saved (null = Pictures/snipr)
// closeAfterCopy: a snip window closes once you copy it
// ink:          annotation colour: ghost (white, dark halo), red, black
// font:         the font text marks are written in (notr's font list)
// onTop:        snip windows stay in front of other programs
// confirmDiscard: ask before closing a snip with unsaved marks
// startup:      start (in the tray) when you log in
const defaults = () => ({
  key: Keys.DEFAULT,
  copy: true,
  open: true,
  autoSave: false,
  closeAfterCopy: false,
  folder: null,
  ink: 'ghost',
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
        if (!INKS.includes(settings.ink)) settings.ink = 'ghost';
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
  copy: settings.copy,
  open: settings.open,
  autoSave: settings.autoSave,
  closeAfterCopy: settings.closeAfterCopy,
  folder: shortPath(folder()),
  ink: settings.ink,
  font: settings.font,
  onTop: settings.onTop,
  confirmDiscard: settings.confirmDiscard,
  startup: settings.startup,
  keyOk: registeredKey !== null || keyPaused,
  platform: process.platform,
  version: app.getVersion(),
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

// Keep one hidden overlay per display, ready to show; rebuilt when screens change.
function syncOverlays() {
  const displays = screen.getAllDisplays();
  const ids = new Set(displays.map((d) => d.id));
  for (const [id, win] of overlays) {
    const d = displays.find((x) => x.id === id);
    if (!ids.has(id) || !d || win.displayKey !== JSON.stringify([d.bounds, d.scaleFactor])) {
      overlays.delete(id);
      if (!win.isDestroyed()) win.destroy();
    }
  }
  for (const d of displays) if (!overlays.has(d.id)) overlays.set(d.id, makeOverlay(d));
}

async function startCapture(origin = 'key') {
  if (session) return;
  const sid = ++sessionSeq;
  session = { sid, origin, shots: null, displays: null, ready: new Set() };
  const t0 = Date.now();
  try {
    hideToast();
    syncOverlays();
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
}

function cancelCapture() {
  if (!session) return;
  const { origin } = session;
  endSession();
  hideOverlays(false);
  if (origin === 'launch' && !settings.welcomed) welcome();
}

// The overlay sends back a rectangle in its own window (DIP) coordinates.
async function finishCapture(win, rect) {
  if (!session || !session.shots) return;
  const entry = [...overlays.entries()].find(([, w]) => w === win);
  if (!entry) return;
  const d = session.displays.find((x) => x.id === entry[0]);
  const shot = session.shots.get(entry[0]);
  if (!d || !shot) return;
  endSession();

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

  const done = [];
  if (settings.copy) { copyPng(png); done.push('copied'); } // not awaited: the snip opens at once
  if (settings.autoSave) {
    try { snip.savedTo = saveBuffer(png, snip.at); done.push('saved'); } catch (err) { logLine('auto save failed: ' + err.message); }
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


const pad = (n) => String(n).padStart(2, '0');
const stamp = (t) => `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}-${pad(t.getHours())}${pad(t.getMinutes())}${pad(t.getSeconds())}`;

function freeName(dir, base) {
  let name = base + '.png', n = 2;
  while (fs.existsSync(path.join(dir, name))) name = `${base}-${n++}.png`;
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
  const maxW = Math.floor(wa.width * 0.9);
  const maxH = Math.floor(wa.height * 0.9) - BAR_H - STATUS_H;
  const k = Math.min(1, maxW / rect.width, maxH / rect.height);
  const iw = Math.round(rect.width * k), ih = Math.round(rect.height * k);
  const width = Math.max(SNIP_MIN.width, iw);
  const height = Math.max(SNIP_MIN.height, ih + BAR_H + STATUS_H);
  let x, y;
  if (k === 1) {
    // the image stays exactly where it was on screen; the chrome grows around it
    x = Math.round(d.bounds.x + rect.x - (width - iw) / 2);
    y = Math.round(d.bounds.y + rect.y - BAR_H - (height - BAR_H - STATUS_H - ih) / 2);
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

function welcome() {
  settings.welcomed = true;
  scheduleSave();
  toast('snipr is in the tray', Keys.label(settings.key), 4200);
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
// settings window (tray → settings); the same menu also drops from a snip's gear
// ---------------------------------------------------------------------------

let settingsWin = null;

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.show(); settingsWin.focus(); return; }
  const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const width = 320, height = 548;
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

function broadcast(channel, ...args) {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, ...args);
}

// ---------------------------------------------------------------------------
// the snip key (system-wide)
// ---------------------------------------------------------------------------

let registeredKey = null;
let keyPaused = false;

function registerKey() {
  if (registeredKey) {
    try { globalShortcut.unregister(registeredKey); } catch (_) {}
    registeredKey = null;
  }
  if (keyPaused) return true;
  const accel = Keys.toAccelerator(settings.key);
  try {
    if (globalShortcut.register(accel, () => startCapture('key'))) {
      registeredKey = accel;
      logLine(`snip key ready: ${accel}`);
      return true;
    }
    logLine(`snip key NOT available (another program has it): ${accel}`);
  } catch (err) {
    logLine(`snip key failed: ${accel} ${err.message}`);
  }
  return false;
}

// ---------------------------------------------------------------------------
// tray, app menu, start at login
// ---------------------------------------------------------------------------

let tray = null;

function trayMenu() {
  return Menu.buildFromTemplate([
    { label: 'Snip', accelerator: Keys.toAccelerator(settings.key), registerAccelerator: false, click: () => setTimeout(() => startCapture('tray'), 180) },
    { label: 'Snip in 3 seconds', click: () => delayedCapture(3) },
    { type: 'separator' },
    { label: 'Open folder', click: openFolder },
    { label: 'Settings', click: openSettings },
    { type: 'separator' },
    { label: 'Quit snipr', click: quitApp },
  ]);
}

function createTray() {
  try { tray = new Tray(trayImage()); } catch (_) { return; }
  tray.setToolTip('snipr');
  tray.setContextMenu(trayMenu());
  // a click on the tray icon takes a snip (on macOS a click opens the menu)
  if (!IS_MAC) tray.on('click', () => setTimeout(() => startCapture('tray'), 180));
}

function setAppMenu() {
  if (!IS_MAC) { Menu.setApplicationMenu(null); return; }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'snipr',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Snip', click: () => startCapture('menu') },
        { label: 'Settings…', accelerator: 'Cmd+,', click: openSettings },
        { type: 'separator' },
        { role: 'hide' },
        { type: 'separator' },
        { label: 'Quit snipr', accelerator: 'Cmd+Q', click: quitApp },
      ],
    },
    { role: 'editMenu' },
  ]));
}

function syncLoginItem() {
  if (!app.isPackaged || process.env.SNIPR_SMOKE) return; // never for a dev checkout or a test run
  try {
    if (process.platform === 'linux') syncLinuxAutostart();
    else if (IS_MAC) app.setLoginItemSettings({ openAtLogin: !!settings.startup });
    else app.setLoginItemSettings({ openAtLogin: !!settings.startup, path: process.execPath, args: ['--hidden'], name: 'snipr' });
  } catch (err) {
    logLine('could not update start at login: ' + err.message);
  }
}

function syncLinuxAutostart() {
  const dir = path.join(app.getPath('appData'), 'autostart');
  const file = path.join(dir, 'snipr.desktop');
  if (!settings.startup) { try { fs.unlinkSync(file); } catch (_) {} return; }
  const exec = process.env.APPIMAGE || process.execPath;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, ['[Desktop Entry]', 'Type=Application', 'Name=snipr', `Exec="${exec}" --hidden`, 'X-GNOME-Autostart-enabled=true', ''].join('\n'));
}

function startedHidden() {
  if (process.argv.includes('--hidden')) return true;
  try { return IS_MAC && app.getLoginItemSettings().wasOpenedAtLogin; } catch (_) { return false; }
}

function quitApp() {
  if (quitting) return;
  quitting = true;
  writeSettingsNow();
  app.quit();
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
  if (typeof patch.onTop === 'boolean' && patch.onTop !== s.onTop) {
    s.onTop = patch.onTop;
    for (const { win } of snips.values()) applyOnTop(win);
  }
  if (typeof patch.startup === 'boolean' && patch.startup !== s.startup) { s.startup = patch.startup; syncLoginItem(); }
  if (typeof patch.key === 'string') {
    const combo = Keys.normalize(patch.key);
    if (combo && combo !== s.key) {
      const old = s.key;
      s.key = combo;
      if (!registerKey()) { s.key = old; registerKey(); broadcast('settings:key-taken', Keys.label(combo)); }
      if (tray) tray.setContextMenu(trayMenu());
    }
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
ipcMain.on('app:quit', quitApp);
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
  await copyPng(toBuffer(s, png));
  return true;
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

// ---------------------------------------------------------------------------
// app lifecycle
// ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // starting snipr again while it runs = take a snip
  app.on('second-instance', () => startCapture('launch'));
  let readyAt = Infinity;
  app.on('ready', () => { readyAt = Date.now(); });
  app.on('activate', () => { if (Date.now() - readyAt > 1500) startCapture('launch'); });

  app.whenReady().then(() => {
    if (IS_WIN) app.setAppUserModelId('app.snipr');
    setAppMenu();
    loadSettings();
    logLine(`start ${app.getVersion()} ${process.platform} args=${JSON.stringify(process.argv.slice(1))}`);
    ensureFolder();
    registerKey();
    createTray();
    syncLoginItem();
    syncOverlays();
    ensureToast();
    screen.on('display-added', syncOverlays);
    screen.on('display-removed', syncOverlays);
    screen.on('display-metrics-changed', () => { if (!session) syncOverlays(); });

    // test hook: scripts/smoke.js drives the real windows
    if (process.env.SNIPR_SMOKE) {
      require(process.env.SNIPR_SMOKE)({ startCapture, overlays, snips, toast, openSettings, logLine,
        settings: () => settings, session: () => session, settingsWin: () => settingsWin, toastWin: () => toastWin });
    }
    // Opening snipr gives you a snip. At login it waits in the tray.
    else if (!startedHidden()) setTimeout(() => startCapture('launch'), 250);
  });

  app.on('before-quit', () => { quitting = true; writeSettingsNow(); });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('window-all-closed', () => {}); // snipr lives in the tray
}
