'use strict';

// utilr: one tray icon, one process, every tool.
//
//   launcher    a small ghost window: install tools, pin them, set their keys
//   quick view  a narrow column of pinned tools, on a key from anywhere
//   tray        the only tray icon; every tool's actions are in its menu
//
// The tools themselves live in tools/<id>, each in its own folder with its own
// windows, preload and data (see host.js).

const { app, BrowserWindow, ipcMain, screen, Menu, Tray, nativeImage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const Keys = require('./keys');
const Store = require('./store');
const Host = require('./host');
const Shortcuts = require('./shortcuts');

const BG = '#111111';           // ghost --bg: no white flash, ever
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const ASSETS = path.join(__dirname, 'assets');
const ICON = path.join(ASSETS, IS_WIN ? 'utilr.ico' : 'utilr-256.png');
const LAUNCHER = { width: 440, height: 520 };
const QUICK = { tile: 56, gap: 10, pad: 14, label: 30 }; // keep in step with quick.css
const KEY_LABELS = { quick: 'quick view', launcher: 'open utilr' };
const VERSION = require('../package.json').version; // not app.getVersion(): right in a dev run too

// Dev / test hook: keep a separate data folder (e.g. UTILR_USER_DATA=C:\tmp\utilr).
if (process.env.UTILR_USER_DATA) app.setPath('userData', process.env.UTILR_USER_DATA);

// ---------------------------------------------------------------------------
// log  (%APPDATA%\utilr\utilr.log, trimmed when it grows)
// ---------------------------------------------------------------------------

function logLine(msg) {
  try {
    const file = path.join(app.getPath('userData'), 'utilr.log');
    let old = '';
    try { old = fs.readFileSync(file, 'utf8'); } catch (_) {}
    if (old.length > 80000) old = old.slice(-30000);
    fs.writeFileSync(file, old + new Date().toISOString() + ' ' + msg + '\n', 'utf8');
  } catch (_) {}
}
Host.setLog(logLine);

function trayImage() {
  if (IS_MAC) {
    const img = nativeImage.createFromPath(path.join(ASSETS, 'trayTemplate.png'));
    img.setTemplateImage(true);
    return img;
  }
  if (IS_WIN) return nativeImage.createFromPath(ICON);
  return nativeImage.createFromPath(ICON).resize({ width: 24, height: 24 });
}

// ---------------------------------------------------------------------------
// motion (same easing as notr and snipr)
// ---------------------------------------------------------------------------

const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const fades = new Map(); // win -> timer, so a new fade replaces the old one

function fade(win, to, ms, done) {
  if (!win || win.isDestroyed()) return;
  clearTimeout(fades.get(win));
  const from = win.getOpacity();
  const start = Date.now();
  const step = () => {
    if (win.isDestroyed()) { fades.delete(win); return; }
    const t = Math.min(1, (Date.now() - start) / ms);
    win.setOpacity(from + (to - from) * easeOut(t));
    if (t < 1) fades.set(win, setTimeout(step, 8));
    else { fades.delete(win); if (done) done(); }
  };
  step();
}

const webPrefs = () => ({
  preload: path.join(__dirname, 'preload.js'),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  spellcheck: false,
});

function lockDown(win) {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

// ---------------------------------------------------------------------------
// state for the windows
// ---------------------------------------------------------------------------

const S = () => Store.get();
const isInstalled = (id) => S().installed.includes(id);

function publicState() {
  const s = S();
  return {
    version: VERSION,
    platform: process.platform,
    maxPinned: Store.MAX_PINNED,
    pinned: s.pinned.filter((id) => Host.isRunning(id)),
    settings: { startup: s.startup, quickAt: s.quickAt },
    keys: Object.keys(KEY_LABELS).map((id) => ({
      id,
      label: KEY_LABELS[id],
      combo: s.keys[id] || '',
      ok: !s.keys[id] || Shortcuts.isSuspended() || Shortcuts.ownerOf(Keys.toAccelerator(s.keys[id])) === 'utilr',
    })),
    tools: Host.list().map((t) => ({
      id: t.id,
      name: t.name,
      version: t.version,
      description: t.description,
      glyph: t.glyph,
      installed: isInstalled(t.id),
      running: Host.isRunning(t.id),
      keys: Host.keys(t.id),
      actions: Host.actions(t.id).map(({ id, label, key }) => ({ id, label, key })),
    })),
  };
}

// Tools change their keys from their own settings too: the launcher, the
// quick view and the tray follow, a moment later, in one go.
let refreshTimer = null;
function refresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    const st = publicState();
    for (const w of [launcherWin, quickWin]) if (w && !w.isDestroyed()) w.webContents.send('utilr:state', st);
    updateTray();
  }, 30);
}
Host.onChange(refresh);
Shortcuts.onChange(refresh);

// ---------------------------------------------------------------------------
// launcher window
// ---------------------------------------------------------------------------

let launcherWin = null;

function openLauncher(tab) {
  if (launcherWin && !launcherWin.isDestroyed()) {
    if (launcherWin.isMinimized()) launcherWin.restore();
    launcherWin.show();
    launcherWin.focus();
    if (tab) launcherWin.webContents.send('utilr:tab', tab);
    return;
  }
  const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const win = launcherWin = new BrowserWindow({
    x: Math.round(wa.x + (wa.width - LAUNCHER.width) / 2),
    y: Math.round(wa.y + (wa.height - LAUNCHER.height) / 3),
    ...LAUNCHER,
    frame: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    opacity: 0,
    title: 'utilr',
    icon: ICON,
    backgroundColor: BG,
    webPreferences: webPrefs(),
  });
  win.loadFile(path.join(__dirname, 'launcher.html'), { query: tab ? { tab } : {} });
  lockDown(win);
  win.once('ready-to-show', () => {
    win.show();
    win.focus();
    fade(win, 1, 220);
  });
  // a key being recorded must never stay silenced
  win.on('blur', () => Shortcuts.suspend(false));
  win.on('closed', () => {
    Shortcuts.suspend(false);
    if (launcherWin === win) launcherWin = null;
  });
}

function closeLauncher() {
  const win = launcherWin;
  if (!win || win.isDestroyed()) return;
  // Closed, not hidden: a launcher you're not looking at costs no memory.
  fade(win, 0, 140, () => { if (!win.isDestroyed()) win.destroy(); });
}

function toggleLauncher() {
  if (launcherWin && !launcherWin.isDestroyed() && launcherWin.isVisible() && launcherWin.isFocused()) closeLauncher();
  else openLauncher();
}

// ---------------------------------------------------------------------------
// quick view: kept loaded and hidden, so the key opens it at once
// ---------------------------------------------------------------------------

let quickWin = null;
let quickShown = false;
let quickShownAt = 0;

function quickSize() {
  const pinned = S().pinned.filter((id) => Host.isRunning(id)).length;
  const n = Math.max(pinned, 1); // nothing pinned: just the "pin a tool" tile
  return {
    width: QUICK.tile + QUICK.pad * 2,
    height: QUICK.pad + n * QUICK.tile + (n - 1) * QUICK.gap + QUICK.label,
  };
}

function quickBounds() {
  const { width, height } = quickSize();
  const cur = screen.getCursorScreenPoint();
  const wa = screen.getDisplayNearestPoint(cur).workArea;
  const midY = Math.round(wa.y + (wa.height - height) / 2);
  let x, y;
  switch (S().quickAt) {
    case 'left': x = wa.x + 16; y = midY; break;
    case 'right': x = wa.x + wa.width - width - 16; y = midY; break;
    case 'cursor': x = cur.x + 14; y = Math.round(cur.y - height / 2); break;
    default: x = Math.round(wa.x + (wa.width - width) / 2); y = midY;
  }
  x = Math.max(wa.x, Math.min(wa.x + wa.width - width, x));
  y = Math.max(wa.y, Math.min(wa.y + wa.height - height, y));
  return { x, y, width, height };
}

function ensureQuick() {
  if (quickWin && !quickWin.isDestroyed()) return quickWin;
  const win = quickWin = new BrowserWindow({
    ...quickSize(),
    frame: false,
    show: false,
    opacity: 0,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    title: 'utilr',
    icon: ICON,
    backgroundColor: BG,
    webPreferences: { ...webPrefs(), backgroundThrottling: false },
  });
  win.setAlwaysOnTop(true, 'pop-up-menu');
  if (IS_MAC) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, 'quick.html'));
  lockDown(win);
  // Click anywhere else and it goes. A blur in its first moments is focus
  // settling (a window closing as it opens, Windows' foreground rules), not you.
  win.on('blur', () => {
    if (!quickShown) return;
    if (Date.now() - quickShownAt < 350) { setTimeout(() => { if (quickShown && !win.isDestroyed()) win.focus(); }, 30); return; }
    hideQuick();
  });
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); hideQuick(); } });
  win.on('closed', () => { if (quickWin === win) quickWin = null; quickShown = false; });
  win.webContents.on('render-process-gone', () => { if (!win.isDestroyed()) win.reload(); });
  return win;
}

function showQuick() {
  const win = ensureQuick();
  quickShown = true;
  quickShownAt = Date.now();
  win.webContents.send('utilr:state', publicState());
  win.webContents.send('quick:show');
  const b = quickBounds();
  win.setBounds(b);
  win.setBounds(b); // twice: Windows can rescale a window moved between DPIs
  win.setOpacity(0);
  win.show();
  if (IS_MAC) app.focus({ steal: true });
  win.focus();
  fade(win, 1, 120);
}

function hideQuick(done) {
  const win = quickWin;
  if (!win || win.isDestroyed() || !quickShown) { if (done) done(); return; }
  quickShown = false;
  fade(win, 0, 90, () => {
    if (!win.isDestroyed()) win.hide();
    if (done) done();
  });
}

const toggleQuick = () => (quickShown ? hideQuick() : showQuick());

// A tool opened from the quick view starts once the column is gone, so a
// screenshot tool never catches it on screen.
function launchFromQuick(id) {
  hideQuick(() => setTimeout(() => Host.open(id), 60));
}

// Opening a tool from the launcher puts the launcher away first, like any
// launcher: the tool gets the screen (and a snip never has the launcher in it).
function launchFromLauncher(fn) {
  if (!launcherWin || launcherWin.isDestroyed()) { fn(); return; }
  closeLauncher();
  setTimeout(fn, 170);
}

// ---------------------------------------------------------------------------
// utilr's own system-wide keys
// ---------------------------------------------------------------------------

const KEY_RUN = { quick: toggleQuick, launcher: toggleLauncher };
const ownAccel = {}; // key id -> accelerator it holds

function registerOwn(id) {
  if (ownAccel[id]) { Shortcuts.unregister('utilr', ownAccel[id]); delete ownAccel[id]; }
  const combo = S().keys[id];
  if (!combo) return true;
  const accel = Keys.toAccelerator(combo);
  if (Shortcuts.register('utilr', accel, KEY_RUN[id])) {
    ownAccel[id] = accel;
    logLine(`${KEY_LABELS[id]} ready: ${accel}`);
    return true;
  }
  logLine(`${KEY_LABELS[id]} NOT available: ${accel} (${Shortcuts.ownerOf(accel) || 'another program'} has it)`);
  return false;
}

// Who has a combo already, as a word for the launcher: a tool's name, or
// "utilr" for one of its own keys. null when it's free (as far as we know).
function holder(combo, except) {
  const owner = Shortcuts.ownerOf(Keys.toAccelerator(combo));
  if (!owner || owner === except) return null;
  if (owner === 'utilr') return 'utilr';
  const t = Host.find(owner);
  return t ? t.name : owner;
}

// owner: 'utilr' or a tool id; combo '' clears (utilr's own keys only)
function setKey(owner, keyId, raw) {
  Shortcuts.suspend(false);
  const combo = raw === '' ? '' : Keys.normalize(raw);
  if (combo === null) return { ok: false, error: 'not a shortcut' };

  if (owner === 'utilr') {
    if (!(keyId in KEY_RUN)) return { ok: false, error: 'unknown key' };
    const s = S();
    if (combo === s.keys[keyId]) return { ok: true };
    if (combo) {
      const other = Object.keys(KEY_RUN).find((k) => k !== keyId && s.keys[k] === combo);
      if (other) return { ok: false, error: `${KEY_LABELS[other]} has it` };
      const who = holder(combo, 'utilr');
      if (who) return { ok: false, error: `${who} has it` };
    }
    const old = s.keys[keyId];
    s.keys[keyId] = combo;
    if (!registerOwn(keyId)) {
      s.keys[keyId] = old;
      registerOwn(keyId);
      refresh();
      return { ok: false, error: 'another program has it' };
    }
    Store.save();
    refresh();
    return { ok: true };
  }

  if (!Host.isRunning(owner)) return { ok: false, error: 'not installed' };
  if (!combo) return { ok: false, error: 'needs a key' };
  const who = holder(combo, owner);
  if (who) return { ok: false, error: `${who} has it` };
  const r = Host.setKey(owner, keyId, combo);
  refresh();
  return r;
}

// ---------------------------------------------------------------------------
// install / remove / pin
// ---------------------------------------------------------------------------

function install(id) {
  if (!Host.find(id)) return { ok: false, error: 'not found' };
  if (isInstalled(id) && Host.isRunning(id)) return { ok: true };
  const r = Host.start(id, { firstRun: !isInstalled(id) });
  if (!r.ok) { refresh(); return r; }
  const s = S();
  if (!s.installed.includes(id)) s.installed.push(id);
  if (!s.pinned.includes(id) && s.pinned.length < Store.MAX_PINNED) s.pinned.push(id);
  Store.saveNow();
  syncQuickSize();
  refresh();
  return r;
}

// The tool's data stays in %APPDATA%\utilr\tools\<id>: install it again and
// everything is where you left it.
function remove(id) {
  Host.stop(id);
  const s = S();
  s.installed = s.installed.filter((x) => x !== id);
  s.pinned = s.pinned.filter((x) => x !== id);
  Store.saveNow();
  syncQuickSize();
  refresh();
  return { ok: true };
}

function pin(id, on) {
  const s = S();
  if (on) {
    if (!isInstalled(id) || s.pinned.includes(id) || s.pinned.length >= Store.MAX_PINNED) return;
    s.pinned.push(id);
  } else {
    s.pinned = s.pinned.filter((x) => x !== id);
  }
  Store.save();
  syncQuickSize();
  refresh();
}

function movePin(id, dir) {
  const s = S();
  const i = s.pinned.indexOf(id);
  const j = i + (dir < 0 ? -1 : 1);
  if (i < 0 || j < 0 || j >= s.pinned.length) return;
  [s.pinned[i], s.pinned[j]] = [s.pinned[j], s.pinned[i]];
  Store.save();
  refresh();
}

function syncQuickSize() {
  if (quickWin && !quickWin.isDestroyed() && quickShown) quickWin.setBounds(quickBounds());
}

// ---------------------------------------------------------------------------
// tray
// ---------------------------------------------------------------------------

let tray = null;
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function trayMenu() {
  const s = S();
  const keyAccel = (combo) => (combo ? { accelerator: Keys.toAccelerator(combo), registerAccelerator: false } : {});
  const tools = Host.list().filter((t) => Host.isRunning(t.id));
  const toolItems = tools.map((t) => {
    const acts = Host.actions(t.id);
    const keys = Host.keys(t.id);
    return {
      label: t.name,
      submenu: acts.length
        ? acts.map((a) => {
          const k = keys.find((x) => x.id === a.key);
          // a short pause first, so the menu is gone before a snip is taken
          return { label: cap(a.label), ...(k ? keyAccel(k.combo) : {}), click: () => setTimeout(() => Host.run(t.id, a.id), 180) };
        })
        : [{ label: 'Open', click: () => Host.open(t.id) }],
    };
  });
  return Menu.buildFromTemplate([
    { label: 'Quick view', ...keyAccel(s.keys.quick), click: showQuick },
    { label: 'Open utilr', ...keyAccel(s.keys.launcher), click: () => openLauncher() },
    ...(toolItems.length ? [{ type: 'separator' }, ...toolItems] : []),
    { type: 'separator' },
    { label: 'Quit utilr', click: quitApp },
  ]);
}

function createTray() {
  try { tray = new Tray(trayImage()); } catch (_) { return; }
  tray.setToolTip('utilr');
  tray.setContextMenu(trayMenu());
  if (!IS_MAC) tray.on('click', toggleLauncher); // on macOS a click opens the menu
}

function updateTray() {
  if (tray && !tray.isDestroyed()) tray.setContextMenu(trayMenu());
}

// macOS needs an app menu, or cmd+c / cmd+v / cmd+z stop working in tools.
function setAppMenu() {
  if (!IS_MAC) { Menu.setApplicationMenu(null); return; }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'utilr',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Open utilr', click: () => openLauncher() },
        { label: 'Quick view', click: showQuick },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { type: 'separator' },
        { label: 'Quit utilr', accelerator: 'Cmd+Q', click: quitApp },
      ],
    },
    { role: 'editMenu' },
  ]));
}

// ---------------------------------------------------------------------------
// start at login  (installed app only, never a dev checkout)
// ---------------------------------------------------------------------------

function syncLoginItem() {
  if (!app.isPackaged || process.env.UTILR_SMOKE) return;
  const on = !!S().startup;
  try {
    if (process.platform === 'linux') {
      const dir = path.join(app.getPath('appData'), 'autostart');
      const file = path.join(dir, 'utilr.desktop');
      if (!on) { try { fs.unlinkSync(file); } catch (_) {} return; }
      const exec = process.env.APPIMAGE || process.execPath;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, ['[Desktop Entry]', 'Type=Application', 'Name=utilr', `Exec="${exec}" --hidden`, 'X-GNOME-Autostart-enabled=true', ''].join('\n'));
    } else if (IS_MAC) {
      app.setLoginItemSettings({ openAtLogin: on });
    } else {
      app.setLoginItemSettings({ openAtLogin: on, path: process.execPath, args: ['--hidden'], name: 'utilr' });
    }
  } catch (err) {
    logLine('could not update start at login: ' + err.message);
  }
}

function startedHidden() {
  if (process.argv.includes('--hidden')) return true;
  try { return IS_MAC && app.getLoginItemSettings().wasOpenedAtLogin; } catch (_) { return false; }
}

let quitting = false;
function quitApp() {
  if (quitting) return;
  quitting = true;
  app.quit();
}

// ---------------------------------------------------------------------------
// IPC  (launcher + quick view; tools have their own, prefixed, channels)
// ---------------------------------------------------------------------------

const fromLauncher = (e) => launcherWin && !launcherWin.isDestroyed() && e.sender === launcherWin.webContents;
const fromQuick = (e) => quickWin && !quickWin.isDestroyed() && e.sender === quickWin.webContents;
const fromUs = (e) => fromLauncher(e) || fromQuick(e);

ipcMain.handle('utilr/state', (e) => (fromUs(e) ? publicState() : null));
ipcMain.handle('utilr/install', (e, id) => (fromLauncher(e) ? install(String(id)) : null));
ipcMain.handle('utilr/remove', (e, id) => (fromLauncher(e) ? remove(String(id)) : null));
ipcMain.handle('utilr/key:set', (e, owner, keyId, combo) => (fromLauncher(e) ? setKey(String(owner), String(keyId), String(combo)) : null));
ipcMain.on('utilr/key:record', (e, on) => { if (fromLauncher(e)) { Shortcuts.suspend(!!on); if (!on) refresh(); } });
ipcMain.on('utilr/pin', (e, id, on) => { if (fromLauncher(e)) pin(String(id), !!on); });
ipcMain.on('utilr/pin:move', (e, id, dir) => { if (fromLauncher(e)) movePin(String(id), +dir); });
ipcMain.on('utilr/open', (e, id) => {
  if (fromQuick(e)) launchFromQuick(String(id));
  else if (fromLauncher(e)) launchFromLauncher(() => Host.open(String(id)));
});
ipcMain.on('utilr/action', (e, id, actionId) => {
  if (fromLauncher(e)) launchFromLauncher(() => Host.run(String(id), String(actionId)));
});
ipcMain.on('utilr/settings', (e, patch) => {
  if (!fromLauncher(e) || !patch || typeof patch !== 'object') return;
  const s = S();
  if (typeof patch.startup === 'boolean' && patch.startup !== s.startup) { s.startup = patch.startup; syncLoginItem(); }
  if (Store.PLACES.includes(patch.quickAt)) s.quickAt = patch.quickAt;
  Store.save();
  refresh();
});
ipcMain.on('utilr/launcher', (e, tab) => {
  if (!fromQuick(e)) return;
  hideQuick(() => openLauncher(typeof tab === 'string' ? tab : null));
});
ipcMain.on('utilr/quick:hide', (e) => { if (fromQuick(e)) hideQuick(); });
ipcMain.on('utilr/quick:preview', (e) => { if (fromLauncher(e)) showQuick(); });
ipcMain.on('utilr/close', (e) => { if (fromLauncher(e)) closeLauncher(); });
ipcMain.on('utilr/minimize', (e) => { if (fromLauncher(e)) launcherWin.minimize(); });
ipcMain.on('utilr/data', (e) => { if (fromLauncher(e)) shell.openPath(app.getPath('userData')); });
ipcMain.on('utilr/quit', (e) => { if (fromLauncher(e)) quitApp(); });

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // starting utilr again while it runs opens the launcher
  app.on('second-instance', () => openLauncher());
  let readyAt = Infinity;
  app.on('ready', () => { readyAt = Date.now(); });
  app.on('activate', () => { if (Date.now() - readyAt > 1500) openLauncher(); });

  app.whenReady().then(() => {
    const t0 = Date.now();
    if (IS_WIN) app.setAppUserModelId('app.utilr');
    setAppMenu();
    Store.load();
    logLine(`start ${VERSION} ${process.platform} args=${JSON.stringify(process.argv.slice(1))}`);

    // One download, every tool: the very first start (no utilr.json yet)
    // installs and pins every tool there is. Remove what you don't want on
    // the launcher's tools page. (Not in the smoke test, which installs each
    // tool itself.)
    const firstRun = Store.fresh() && !process.env.UTILR_SMOKE;
    if (firstRun) {
      const s = S();
      for (const t of Host.list()) {
        s.installed.push(t.id);
        if (s.pinned.length < Store.MAX_PINNED) s.pinned.push(t.id);
      }
      logLine(`first start: installing ${s.installed.join(', ')}`);
    }

    // every installed tool, in the background (no windows until you ask)
    for (const id of [...S().installed]) {
      if (!Host.find(id)) continue; // a tool that's no longer shipped
      const r = Host.start(id, { firstRun });
      if (!r.ok) {
        logLine(`${id} did not start: ${r.error}`);
        if (firstRun) { S().installed = S().installed.filter((x) => x !== id); S().pinned = S().pinned.filter((x) => x !== id); }
      }
    }
    if (firstRun) Store.saveNow();
    for (const id of Object.keys(KEY_RUN)) registerOwn(id);
    createTray();
    syncLoginItem();
    ensureQuick();
    logLine(`ready in ${Date.now() - t0} ms`);

    // test hook: scripts/smoke.js drives the real windows
    if (process.env.UTILR_SMOKE) {
      require(process.env.UTILR_SMOKE)({
        Host, Store, Shortcuts, install, remove, pin, movePin, setKey, publicState,
        openLauncher, closeLauncher, showQuick, hideQuick, launchFromQuick,
        launcherWin: () => launcherWin, quickWin: () => quickWin, logLine,
      });
    } else if (!startedHidden()) {
      openLauncher(firstRun || !S().installed.length ? 'tools' : null);
    }

    screen.on('display-removed', () => { if (quickShown) hideQuick(); });
  });

  app.on('before-quit', () => {
    quitting = true;
    Host.stopAll(); // every tool saves and closes its windows
    Store.saveNow();
  });
  app.on('will-quit', () => Shortcuts.releaseAll());
  app.on('window-all-closed', () => {}); // utilr lives in the tray
}
