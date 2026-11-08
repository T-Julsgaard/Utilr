'use strict';

const { app, BrowserWindow, ipcMain, screen, Menu, Tray, nativeImage, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const Keys = require('./shortcuts');

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

const THEME_BG = {
  ghost: '#111111',
  mono: '#000000',
  paper: '#f4f4f0',
  dots: '#101010',
  gutter: '#0c0c0e',
  green: '#0f1311',
  amber: '#140d02',
};
const DEFAULT_THEME = 'ghost';
const DOTS = ['green', 'amber', 'blue'];
const DEFAULT_SIZE = { width: 300, height: 300 };
const MIN_SIZE = { width: 200, height: 150 };
const GAP = 14; // space between notes when a new one is placed
const ICON = path.join(__dirname, 'assets', 'notr.ico');
const TRAY_ICON = ICON; // the .ico carries the chunkier 16/24 px mark for small sizes

// Dev / test hook: keep a separate data folder (e.g. NOTR_USER_DATA=C:\tmp\notr).
if (process.env.NOTR_USER_DATA) app.setPath('userData', process.env.NOTR_USER_DATA);

// ---------------------------------------------------------------------------
// state  (one JSON file in %APPDATA%\Notr)
// ---------------------------------------------------------------------------

const STATE_FILE = () => path.join(app.getPath('userData'), 'notr-state.json');

// Small diagnostic log (%APPDATA%\notr\notr.log), trimmed when it grows.
function logLine(msg) {
  try {
    const file = path.join(app.getPath('userData'), 'notr.log');
    let old = '';
    try { old = fs.readFileSync(file, 'utf8'); } catch (_) {}
    if (old.length > 50000) old = old.slice(-20000);
    fs.writeFileSync(file, old + new Date().toISOString() + ' ' + msg + '\n', 'utf8');
  } catch (_) {}
}

// settings.fonts:     per theme, { family, size, bold, italic } (null = theme default)
// settings.status:    which status-line items are shown
// settings.shortcuts: { add, del, open } combos, see shortcuts.js
// settings.onTop:     notes stay in front of other programs
// settings.confirmDelete: ask "delete note?" before removing a note with text
// settings.startup:   start (in the background) when you log in to Windows
const defaultSettings = () => ({
  theme: DEFAULT_THEME,
  seq: 0,
  fonts: {},
  status: { pos: false, chars: true },
  shortcuts: { ...Keys.DEFAULTS },
  onTop: true,
  confirmDelete: true,
  startup: true,
});

const STATE_VERSION = 4;
let state = { version: STATE_VERSION, settings: defaultSettings(), notes: [] };
let saveTimer = null;

function loadState() {
  for (const file of [STATE_FILE(), STATE_FILE() + '.bak']) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (raw && Array.isArray(raw.notes)) {
        const s = raw.settings || {};
        const d = defaultSettings();
        state = {
          version: STATE_VERSION,
          settings: {
            ...d,
            ...s,
            fonts: { ...(s.fonts || {}) },
            status: { ...d.status, ...(s.status || {}) },
            shortcuts: { ...d.shortcuts, ...(s.shortcuts || {}) },
          },
          notes: raw.notes.filter((n) => n && n.id),
        };
        // v1 defaulted to green; move those setups onto the new default.
        if ((raw.version || 1) < 2 && state.settings.theme === 'green') state.settings.theme = DEFAULT_THEME;
        if (!THEME_BG[state.settings.theme]) state.settings.theme = DEFAULT_THEME;
        for (const a of Keys.ACTIONS) {
          state.settings.shortcuts[a] = Keys.normalize(state.settings.shortcuts[a]) || Keys.DEFAULTS[a];
        }
        // v4: "add note" moved to ctrl+s (unless another action already uses it)
        const sc = state.settings.shortcuts;
        if ((raw.version || 1) < 4 && sc.del !== 'ctrl+s' && sc.open !== 'ctrl+s') sc.add = 'ctrl+s';
        return;
      }
    } catch (_) { /* missing or unreadable: try the next one */ }
  }
}

const publicSettings = () => {
  const { theme, fonts, status, shortcuts, onTop, confirmDelete, startup } = state.settings;
  return { theme, fonts, status, shortcuts, onTop, confirmDelete, startup };
};

// On: above every other program. Off: ordinary windows that go behind
// whatever you click.
function applyOnTop(win) {
  if (win.isDestroyed()) return;
  if (state.settings.onTop) win.setAlwaysOnTop(true, 'screen-saver');
  else win.setAlwaysOnTop(false);
}

function writeStateNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const file = STATE_FILE();
  const json = JSON.stringify(state, null, 1);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) {
      try { fs.copyFileSync(file, file + '.bak'); } catch (_) {}
    }
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, json, 'utf8');
    try { fs.renameSync(tmp, file); } catch (_) { fs.writeFileSync(file, json, 'utf8'); }
  } catch (err) {
    console.error('notr: could not save', err);
  }
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeStateNow, 300);
}

const findNote = (id) => state.notes.find((n) => n.id === id);

function newNoteData(bounds) {
  state.settings.seq = (state.settings.seq || 0) + 1;
  const note = {
    id: 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    seq: state.settings.seq,
    html: '',
    bounds,
    dot: DOTS[(state.settings.seq - 1) % DOTS.length],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  state.notes.push(note);
  return note;
}

// ---------------------------------------------------------------------------
// geometry: where new notes go
// ---------------------------------------------------------------------------

function overlaps(a, b) {
  const g = GAP - 1;
  return a.x < b.x + b.width + g && b.x < a.x + a.width + g &&
         a.y < b.y + b.height + g && b.y < a.y + a.height + g;
}
function fits(r, wa) {
  return r.x >= wa.x && r.y >= wa.y && r.x + r.width <= wa.x + wa.width && r.y + r.height <= wa.y + wa.height;
}
function isFree(r, wa, others) {
  return fits(r, wa) && !others.some((o) => overlaps(r, o));
}

// Beside the source note: right, left, below, above. If all of those are
// taken, the nearest free spot on screen. If the screen is full, cascade.
function findSpotNextTo(src) {
  const others = [...windows.values()].filter((w) => !w.isDestroyed()).map((w) => w.getBounds());
  const width = src.width, height = src.height;
  const wa = screen.getDisplayMatching(src).workArea;

  const candidates = [
    { x: src.x + src.width + GAP, y: src.y },
    { x: src.x - width - GAP, y: src.y },
    { x: src.x, y: src.y + src.height + GAP },
    { x: src.x, y: src.y - height - GAP },
  ];
  for (const c of candidates) {
    const r = { ...c, width, height };
    if (isFree(r, wa, others)) return r;
  }

  let best = null, bestD = Infinity;
  const tx = src.x + src.width + GAP, ty = src.y;
  for (let y = wa.y + GAP; y + height <= wa.y + wa.height; y += 16) {
    for (let x = wa.x + GAP; x + width <= wa.x + wa.width; x += 16) {
      const r = { x, y, width, height };
      if (!isFree(r, wa, others)) continue;
      const d = (x - tx) ** 2 + (y - ty) ** 2 * 1.5;
      if (d < bestD) { bestD = d; best = r; }
    }
  }
  if (best) return best;

  return {
    x: Math.min(src.x + 28, wa.x + wa.width - width),
    y: Math.min(src.y + 28, wa.y + wa.height - height),
    width, height,
  };
}

function firstNoteBounds() {
  const wa = screen.getPrimaryDisplay().workArea;
  return {
    x: Math.round(wa.x + (wa.width - DEFAULT_SIZE.width) / 2),
    y: Math.round(wa.y + (wa.height - DEFAULT_SIZE.height) / 3),
    ...DEFAULT_SIZE,
  };
}

// Pull a note back on screen if its monitor is gone.
function ensureVisible(b) {
  const width = Math.max(MIN_SIZE.width, b.width || DEFAULT_SIZE.width);
  const height = Math.max(MIN_SIZE.height, b.height || DEFAULT_SIZE.height);
  const r = { x: b.x | 0, y: b.y | 0, width, height };
  const visible = screen.getAllDisplays().some(({ workArea: wa }) => {
    const ix = Math.min(r.x + r.width, wa.x + wa.width) - Math.max(r.x, wa.x);
    const iy = Math.min(r.y + 34, wa.y + wa.height) - Math.max(r.y, wa.y);
    return ix >= 80 && iy >= 20; // title bar must be reachable
  });
  if (visible) return r;
  const wa = screen.getPrimaryDisplay().workArea;
  const w = Math.min(width, wa.width), h = Math.min(height, wa.height);
  return { x: Math.round(wa.x + (wa.width - w) / 2), y: Math.round(wa.y + (wa.height - h) / 3), width: w, height: h };
}

// ---------------------------------------------------------------------------
// animation (window position / opacity)
// ---------------------------------------------------------------------------

const animating = new Set();
const easeOut = (t) => 1 - Math.pow(1 - t, 3);

function animate(win, from, to, ms, done) {
  const start = Date.now();
  animating.add(win);
  const step = () => {
    if (win.isDestroyed()) { animating.delete(win); return; }
    const t = Math.min(1, (Date.now() - start) / ms);
    const k = easeOut(t);
    const lerp = (a, b) => a + (b - a) * k;
    if (from.x !== undefined) {
      // Always pass width/height so fractional DPI scaling can't drift the size.
      win.setBounds({
        x: Math.round(lerp(from.x, to.x)),
        y: Math.round(lerp(from.y, to.y)),
        width: to.width,
        height: to.height,
      });
    }
    if (from.opacity !== undefined) win.setOpacity(lerp(from.opacity, to.opacity));
    if (t < 1) setTimeout(step, 8);
    else { animating.delete(win); if (done) done(); }
  };
  step();
}

// ---------------------------------------------------------------------------
// windows
// ---------------------------------------------------------------------------

const windows = new Map(); // noteId -> BrowserWindow
const byContents = new Map(); // webContents.id -> noteId
const deleting = new Set();
let quitting = false;
let lastFocused = null;
let tray = null;

function createWindow(note, { slideFrom = null, focus = false } = {}) {
  const target = note.bounds;
  const start = slideFrom
    ? {
        x: Math.round(slideFrom.x + (target.x - slideFrom.x) * 0.3),
        y: Math.round(slideFrom.y + (target.y - slideFrom.y) * 0.3),
      }
    : { x: target.x, y: target.y };

  const win = new BrowserWindow({
    x: start.x,
    y: start.y,
    width: target.width,
    height: target.height,
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    frame: false,
    resizable: true, // drag any edge or corner
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: state.settings.onTop,
    show: false,
    opacity: 0,
    title: 'notr',
    icon: ICON,
    backgroundColor: THEME_BG[state.settings.theme],
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  applyOnTop(win);
  windows.set(note.id, win);
  byContents.set(win.webContents.id, note.id);

  win.loadFile(path.join(__dirname, 'note.html'));

  // Bounds are only tracked once the opening animation has finished, so the
  // in-between positions never get saved.
  let settled = false;
  const settle = () => {
    settled = true;
    if (!win.isDestroyed()) win.setBounds(target);
  };

  win.once('ready-to-show', () => {
    if (focus) win.show(); else win.showInactive();
    if (slideFrom) {
      animate(win, { ...start, opacity: 0 }, { ...target, opacity: 1 }, 280, settle);
    } else {
      animate(win, { opacity: 0 }, { opacity: 1 }, 220, settle);
    }
    if (focus) win.webContents.send('note:focus-editor');
  });

  const track = () => {
    if (!settled || animating.has(win) || win.isDestroyed() || win.isMinimized()) return;
    const n = findNote(note.id);
    if (!n) return;
    n.bounds = win.getBounds();
    scheduleSave();
  };
  win.on('move', track);
  win.on('resize', track);
  // Among themselves notes behave like normal windows: the one you click
  // comes to the front.
  win.on('focus', () => {
    lastFocused = note.id;
    if (!win.isDestroyed()) win.moveTop();
  });

  // Closing a window any other way than the note's own X (Alt+F4, taskbar
  // "close window") closes notr: every note is kept for next time, and notr
  // stays in the tray so the "open notr" shortcut can bring them back.
  win.on('close', (e) => {
    if (quitting || deleting.has(note.id)) return;
    e.preventDefault();
    closeAll();
  });
  win.on('closed', () => {
    windows.delete(note.id);
    byContents.forEach((v, k) => { if (v === note.id) byContents.delete(k); });
  });

  win.webContents.on('render-process-gone', () => {
    if (!win.isDestroyed()) win.reload();
  });
  // Links inside notes never open new Electron windows.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  return win;
}

function newNoteFrom(sourceId) {
  const srcWin = windows.get(sourceId) || windows.get(lastFocused) || [...windows.values()].pop();
  const src = srcWin && !srcWin.isDestroyed() ? srcWin.getBounds() : null;
  const bounds = src ? findSpotNextTo(src) : firstNoteBounds();
  const note = newNoteData(bounds);
  scheduleSave();
  createWindow(note, { slideFrom: src, focus: true });
}

function deleteNote(id) {
  if (deleting.has(id)) return;
  const win = windows.get(id);
  state.notes = state.notes.filter((n) => n.id !== id);
  deleting.add(id);
  writeStateNow();
  if (!win || win.isDestroyed()) return;
  animate(win, { opacity: win.getOpacity() }, { opacity: 0 }, 160, () => {
    if (!win.isDestroyed()) win.destroy();
    deleting.delete(id);
    // last note gone: notr keeps running in the tray; opening it gives a fresh note
  });
}

const openWindows = () => [...windows.values()].filter((w) => !w.isDestroyed());

// Open every saved note (or a fresh one if there are none).
function openAll() {
  if (state.notes.length === 0) {
    newNoteData(firstNoteBounds());
    writeStateNow();
  }
  const last = state.notes.length - 1;
  state.notes.forEach((note, i) => {
    if (windows.has(note.id)) return;
    note.bounds = ensureVisible(note.bounds || firstNoteBounds());
    createWindow(note, { focus: i === last });
  });
}

// "Close notr": save, fade the notes out and close them. The process stays
// in the tray (small, no note windows) and keeps listening for "open notr".
let closingAll = false;
function closeAll() {
  if (closingAll) return;
  closingAll = true;
  writeStateNow();
  const wins = openWindows();
  if (!wins.length) { closingAll = false; return; }
  let left = wins.length;
  for (const win of wins) {
    animate(win, { opacity: win.getOpacity() }, { opacity: 0 }, 140, () => {
      if (!win.isDestroyed()) win.destroy();
      if (--left === 0) closingAll = false;
    });
  }
}

function showAll() {
  if (closingAll) return;
  if (!openWindows().length) { openAll(); return; }
  for (const win of windows.values()) {
    if (win.isDestroyed()) continue;
    if (win.isMinimized()) win.restore();
    win.showInactive();
    win.moveTop(); // matters when notes aren't always on top
  }
  const focusWin = windows.get(lastFocused) || [...windows.values()].pop();
  if (focusWin && !focusWin.isDestroyed()) focusWin.focus();
}

function broadcast(channel, ...args) {
  for (const win of windows.values()) {
    if (!win.isDestroyed()) win.webContents.send(channel, ...args);
  }
}

// The "open notr" shortcut is system-wide: from any program it opens the
// notes again (after notr was closed) or brings them to the front.
let registeredOpen = null;
function registerOpenShortcut() {
  if (registeredOpen) {
    try { globalShortcut.unregister(registeredOpen); } catch (_) {}
    registeredOpen = null;
  }
  const accel = Keys.toAccelerator(state.settings.shortcuts.open);
  try {
    if (globalShortcut.register(accel, () => { logLine('open notr pressed'); showAll(); })) {
      registeredOpen = accel;
      logLine(`open notr shortcut ready: ${accel}`);
    } else {
      logLine(`open notr shortcut NOT available (another program has it): ${accel}`);
    }
  } catch (err) {
    logLine(`open notr shortcut failed: ${accel} ${err.message}`);
  }
}

function quitApp() {
  if (quitting) return;
  quitting = true;
  writeStateNow();
  app.quit();
}

function createTray() {
  try {
    tray = new Tray(nativeImage.createFromPath(TRAY_ICON));
  } catch (_) { return; }
  tray.setToolTip('notr');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open notr', click: showAll },
    { label: 'New note', click: () => { if (!openWindows().length) openAll(); else newNoteFrom(lastFocused); } },
    { label: 'Close notes', click: closeAll },
    { type: 'separator' },
    { label: 'Quit notr', click: quitApp },
  ]));
  tray.on('click', showAll);
}

// Start with Windows (in the background, so "open notr" works right after
// login). Only for the installed app, never for a dev checkout.
function syncLoginItem() {
  if (!app.isPackaged) return;
  try {
    app.setLoginItemSettings({
      openAtLogin: !!state.settings.startup,
      path: process.execPath,
      args: ['--hidden'],
      name: 'notr',
    });
  } catch (err) {
    console.warn('notr: could not update start-with-windows', err.message);
  }
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

const senderNote = (e) => byContents.get(e.sender.id);

ipcMain.handle('note:init', (e) => {
  const note = findNote(senderNote(e));
  if (!note) return null;
  return {
    note: { id: note.id, html: note.html, dot: note.dot },
    settings: publicSettings(),
  };
});

ipcMain.on('note:update', (e, patch) => {
  const note = findNote(senderNote(e));
  if (!note || !patch || typeof patch !== 'object') return;
  if (typeof patch.html === 'string') note.html = patch.html;
  if (DOTS.includes(patch.dot)) note.dot = patch.dot;
  note.updatedAt = Date.now();
  scheduleSave();
});

// ---------------------------------------------------------------------------
// keyboard resize (ctrl+arrows) and move (alt+arrows)
// While an arrow is held the note glides: slow at first so a tap nudges it a
// few pixels, then speeding up. Several arrows at once go diagonally.
// ---------------------------------------------------------------------------

const KBD = { startSpeed: 140, maxSpeed: 1100, rampSeconds: 0.9 }; // px/s
const kbd = new Map(); // webContents.id -> motion

function unionWorkArea() {
  const was = screen.getAllDisplays().map((d) => d.workArea);
  const x = Math.min(...was.map((a) => a.x)), y = Math.min(...was.map((a) => a.y));
  const r = Math.max(...was.map((a) => a.x + a.width)), b = Math.max(...was.map((a) => a.y + a.height));
  return { x, y, width: r - x, height: b - y };
}

function kbdStep(win, m) {
  if (win.isDestroyed()) { kbdStop(win); return; }
  const now = Date.now();
  const dt = Math.min(0.05, (now - m.last) / 1000);
  m.last = now;
  const t = Math.min(1, (now - m.start) / 1000 / KBD.rampSeconds);
  const speed = KBD.startSpeed + (KBD.maxSpeed - KBD.startSpeed) * t * t;
  const d = speed * dt;
  const dx = (m.dirs.has('right') ? 1 : 0) - (m.dirs.has('left') ? 1 : 0);
  const dy = (m.dirs.has('down') ? 1 : 0) - (m.dirs.has('up') ? 1 : 0);
  const b = m.b;

  if (m.mode === 'resize') {
    // right/down grow the note, left/up shrink it (like dragging the bottom-right corner)
    // growing stops at the screen edge; never snaps a note that is already past it
    const wa = screen.getDisplayMatching(win.getBounds()).workArea;
    const grow = (size, delta, room) => (delta > 0 ? Math.min(size + delta, Math.max(size, room)) : size + delta);
    b.width = Math.max(MIN_SIZE.width, grow(b.width, dx * d, wa.x + wa.width - b.x));
    b.height = Math.max(MIN_SIZE.height, grow(b.height, dy * d, wa.y + wa.height - b.y));
  } else {
    const u = unionWorkArea();
    b.x = Math.max(u.x, Math.min(u.x + u.width - b.width, b.x + dx * d));
    b.y = Math.max(u.y, Math.min(u.y + u.height - b.height, b.y + dy * d));
  }
  win.setBounds({ x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) });
}

function kbdStart(win, mode, dir) {
  if (!['left', 'right', 'up', 'down'].includes(dir) || !['resize', 'move'].includes(mode)) return;
  let m = kbd.get(win.webContents.id);
  if (m && m.mode !== mode) { kbdStop(win); m = null; }
  if (!m) {
    const now = Date.now();
    m = { mode, dirs: new Set(), start: now, last: now - 16, b: { ...win.getBounds() }, timer: null };
    kbd.set(win.webContents.id, m);
  }
  m.dirs.add(dir);
  kbdStep(win, m); // move right away, so a quick tap always does something
  if (!m.timer) m.timer = setInterval(() => kbdStep(win, m), 16);
}

function kbdStop(win, dir) {
  const m = kbd.get(win.webContents.id);
  if (!m) return;
  if (dir) m.dirs.delete(dir); else m.dirs.clear();
  if (m.dirs.size) return;
  clearInterval(m.timer);
  kbd.delete(win.webContents.id);
}

ipcMain.on('kbd:start', (e, mode, dir) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win) kbdStart(win, mode, dir);
});
ipcMain.on('kbd:stop', (e, dir) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win) kbdStop(win, dir);
});

ipcMain.on('note:new', (e) => newNoteFrom(senderNote(e)));
ipcMain.on('note:close', (e) => { const id = senderNote(e); if (id) deleteNote(id); });

// One message for every setting; the result goes to all notes.
ipcMain.on('settings:set', (_e, patch) => {
  if (!patch || typeof patch !== 'object') return;
  const s = state.settings;

  if (THEME_BG[patch.theme]) {
    s.theme = patch.theme;
    for (const win of windows.values()) if (!win.isDestroyed()) win.setBackgroundColor(THEME_BG[s.theme]);
  }

  // font settings belong to a theme and are remembered for it
  if (patch.font && typeof patch.font === 'object' && THEME_BG[patch.font.theme]) {
    const f = { ...(s.fonts[patch.font.theme] || {}), ...patch.font.value };
    s.fonts[patch.font.theme] = {
      family: typeof f.family === 'string' ? f.family : null,
      size: Number.isFinite(f.size) ? Math.min(48, Math.max(8, f.size)) : null,
      bold: !!f.bold,
      italic: !!f.italic,
    };
  }

  if (typeof patch.onTop === 'boolean' && patch.onTop !== s.onTop) {
    s.onTop = patch.onTop;
    for (const win of windows.values()) applyOnTop(win);
  }
  if (typeof patch.confirmDelete === 'boolean') s.confirmDelete = patch.confirmDelete;
  if (typeof patch.startup === 'boolean' && patch.startup !== s.startup) {
    s.startup = patch.startup;
    syncLoginItem();
  }

  if (patch.status && typeof patch.status === 'object') {
    if (typeof patch.status.pos === 'boolean') s.status.pos = patch.status.pos;
    if (typeof patch.status.chars === 'boolean') s.status.chars = patch.status.chars;
  }

  if (patch.shortcut && Keys.ACTIONS.includes(patch.shortcut.action)) {
    const combo = Keys.normalize(patch.shortcut.combo);
    const { action } = patch.shortcut;
    const taken = Keys.ACTIONS.some((a) => a !== action && s.shortcuts[a] === combo);
    if (combo && !taken && combo !== s.shortcuts[action]) {
      s.shortcuts[action] = combo;
      if (action === 'open') registerOpenShortcut();
    }
  }

  broadcast('settings:changed', publicSettings());
  scheduleSave();
});

ipcMain.on('edit', (e, cmd) => {
  if (cmd === 'cut') e.sender.cut();
  else if (cmd === 'copy') e.sender.copy();
  else if (cmd === 'paste') e.sender.paste();
});

ipcMain.on('app:quit', quitApp);

// ---------------------------------------------------------------------------
// app lifecycle
// ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showAll);

  app.whenReady().then(() => {
    app.setAppUserModelId('app.notr');
    Menu.setApplicationMenu(null);
    loadState();
    logLine(`start ${app.getVersion()} args=${JSON.stringify(process.argv.slice(1))}`);

    // At Windows login notr starts with --hidden: tray + shortcut only.
    if (!process.argv.includes('--hidden')) openAll();
    createTray();
    registerOpenShortcut();
    syncLoginItem();

    screen.on('display-removed', () => {
      for (const [id, win] of windows) {
        if (win.isDestroyed()) continue;
        const b = ensureVisible(win.getBounds());
        win.setBounds(b);
        const n = findNote(id);
        if (n) n.bounds = b;
      }
      scheduleSave();
    });
  });

  app.on('before-quit', () => { quitting = true; writeStateNow(); });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  // No note windows doesn't mean quit: notr waits in the tray. Only
  // "Quit notr" (tray) really exits.
  app.on('window-all-closed', () => {});
}
