'use strict';

// notr, as a utilr tool. This is notr's own main process and it does what it
// always did; only the parts that belonged to a stand-alone app moved out to
// utilr: the tray, start at login, the single-instance lock, the app menu and
// the app lifecycle. utilr hands in `host` (src/host.js): its ipc and
// shortcuts look like Electron's ipcMain and globalShortcut but are notr's
// own, and notr's data lives in host.dataDir (the tools/notr folder in utilr's data).

const { BrowserWindow, screen } = require('electron');
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
const IS_WIN = process.platform === 'win32';
const ICON = path.join(__dirname, 'assets', IS_WIN ? 'notr.ico' : 'notr-256.png');

module.exports = function notr(host) {
  const { ipc: ipcMain, shortcuts: globalShortcut } = host;

  // ---------------------------------------------------------------------------
  // state  (one JSON file in host.dataDir)
  // ---------------------------------------------------------------------------

  const STATE_FILE = () => path.join(host.dataDir, 'notr-state.json');

  // Small diagnostic log (%APPDATA%\notr\notr.log), trimmed when it grows.
  function logLine(msg) {
    try {
      const file = path.join(host.dataDir, 'notr.log');
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
    const { theme, fonts, status, shortcuts, onTop, confirmDelete } = state.settings;
    // hosted: utilr starts notr at login, so the note menu leaves that row out
    return { theme, fonts, status, shortcuts, onTop, confirmDelete, hosted: true };
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

  // Saved notes (the floppy button): note.saved + note.slot (the number on its
  // tab). Closing a saved note keeps it (note.closed) and its tab stays in the
  // title bar of every note; emptying its text unsaves it again.
  // text, or a drawing with a stroke in it (/draw)
  const hasText = (html) => /<path\b/.test(String(html || '')) ||
    String(html || '').replace(/<[^>]*>/g, '').replace(/&nbsp;|​/g, '').trim() !== '';

  function freeSlot() {
    const used = new Set(state.notes.filter((n) => n.saved).map((n) => n.slot));
    let slot = 1;
    while (used.has(slot)) slot++;
    return slot;
  }

  function unsave(note) {
    note.saved = false;
    delete note.slot;
    delete note.closed;
  }

  const savedTabs = () => state.notes
    .filter((n) => n.saved)
    .sort((a, b) => a.slot - b.slot)
    .map((n) => ({ id: n.id, slot: n.slot, open: !n.closed, title: n.preview || '' }));

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
  function findSpotNextTo(src, size = src) {
    const others = [...windows.values()].filter((w) => !w.isDestroyed()).map((w) => w.getBounds());
    const { width, height } = size;
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
    const contentsId = win.webContents.id;
    byContents.set(contentsId, note.id);

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
    // A saved note can be reopened while its old window is still going away:
    // only forget this window, never the new one.
    win.on('closed', () => {
      if (windows.get(note.id) === win) windows.delete(note.id);
      byContents.delete(contentsId);
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

  // Closing a saved note: the window goes, the note (and its tab) stays.
  function stashNote(id) {
    const note = findNote(id);
    if (!note || deleting.has(id)) return;
    note.closed = true;
    writeStateNow();
    broadcastTabs();
    const win = windows.get(id);
    if (!win || win.isDestroyed()) return;
    deleting.add(id);
    animate(win, { opacity: win.getOpacity() }, { opacity: 0 }, 160, () => {
      if (!win.isDestroyed()) win.destroy();
      deleting.delete(id);
    });
  }

  // A saved note's tab was clicked: bring it to the front, or open it again.
  // It comes back where it was if that spot is still free, otherwise it slides
  // out beside the note whose tab was clicked.
  function openSaved(id, fromId) {
    const note = findNote(id);
    if (!note || !note.saved || deleting.has(id)) return;
    const open = windows.get(id);
    if (open && !open.isDestroyed()) {
      if (open.isMinimized()) open.restore();
      open.show();
      open.focus();
      return;
    }
    const srcWin = windows.get(fromId);
    const src = srcWin && !srcWin.isDestroyed() ? srcWin.getBounds() : null;
    let bounds = ensureVisible(note.bounds || firstNoteBounds());
    let slideFrom = null;
    const others = openWindows().map((w) => w.getBounds());
    if (src && !isFree(bounds, screen.getDisplayMatching(bounds).workArea, others)) {
      bounds = findSpotNextTo(src, bounds);
      slideFrom = src;
    }
    note.bounds = bounds;
    note.closed = false;
    writeStateNow();
    createWindow(note, { slideFrom, focus: true });
    broadcastTabs();
  }

  const openWindows = () => [...windows.values()].filter((w) => !w.isDestroyed());

  // Open every note that was open (or a fresh one if there are none).
  // Saved notes that were closed stay closed: they are tabs.
  function openAll() {
    if (!state.notes.some((n) => !n.closed)) {
      newNoteData(firstNoteBounds());
      writeStateNow();
    }
    const toOpen = state.notes.filter((n) => !n.closed);
    toOpen.forEach((note, i) => {
      if (windows.has(note.id)) return;
      note.bounds = ensureVisible(note.bounds || firstNoteBounds());
      createWindow(note, { focus: i === toOpen.length - 1 });
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

  const broadcastTabs = () => broadcast('tabs:changed', savedTabs());

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
      tabs: savedTabs(),
      platform: process.platform,
    };
  });

  // patch: { html, dot, preview (first line, for the tab's hover text), empty }
  ipcMain.on('note:update', (e, patch) => {
    const note = findNote(senderNote(e));
    if (!note || !patch || typeof patch !== 'object') return;
    if (typeof patch.html === 'string') note.html = patch.html;
    if (DOTS.includes(patch.dot)) note.dot = patch.dot;
    let tabsChanged = false;
    if (typeof patch.preview === 'string') {
      const p = patch.preview.slice(0, 60);
      if (p !== note.preview) { note.preview = p; tabsChanged = note.saved; }
    }
    // all text deleted: the note isn't saved any more and its tab goes
    if (note.saved && (patch.empty === true || (typeof patch.html === 'string' && !hasText(patch.html)))) {
      unsave(note);
      tabsChanged = true;
    }
    note.updatedAt = Date.now();
    scheduleSave();
    if (tabsChanged) broadcastTabs();
  });

  ipcMain.on('note:save', (e) => {
    const note = findNote(senderNote(e));
    if (!note || note.saved || !hasText(note.html)) return;
    note.saved = true;
    note.slot = freeSlot();
    writeStateNow();
    broadcastTabs();
  });

  ipcMain.on('note:open', (e, id) => openSaved(id, senderNote(e)));

  // ---------------------------------------------------------------------------
  // keyboard resize (ctrl+arrows) and move (alt+arrows)
  // While an arrow is held the note glides: slow at first so a tap nudges it a
  // few pixels, then speeding up. Several arrows at once go diagonally.
  // ---------------------------------------------------------------------------

  const KBD = { startSpeed: 140, maxSpeed: 1100, rampSeconds: 0.9 }; // px/s
  // Keyed by the window itself: a note can close while a key is still held,
  // and a closed window can't be asked for its ids any more.
  const kbd = new Map(); // BrowserWindow -> motion

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
    if (win.isDestroyed()) return;
    let m = kbd.get(win);
    if (m && m.mode !== mode) { kbdStop(win); m = null; }
    if (!m) {
      const now = Date.now();
      m = { mode, dirs: new Set(), start: now, last: now - 16, b: { ...win.getBounds() }, timer: null };
      kbd.set(win, m);
      win.once('closed', () => kbdStop(win)); // note deleted / notr closed mid-glide
    }
    m.dirs.add(dir);
    kbdStep(win, m); // move right away, so a quick tap always does something
    if (!m.timer) m.timer = setInterval(() => kbdStep(win, m), 16);
  }

  function kbdStop(win, dir) {
    const m = kbd.get(win);
    if (!m) return;
    if (dir && !win.isDestroyed()) m.dirs.delete(dir); else m.dirs.clear();
    if (m.dirs.size) return;
    clearInterval(m.timer);
    kbd.delete(win);
  }

  ipcMain.on('kbd:start', (e, mode, dir) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (win) kbdStart(win, mode, dir);
  });
  ipcMain.on('kbd:stop', (e, dir) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (win) kbdStop(win, dir);
  });

  // tab / shift+tab: focus the next / previous note, left to right on screen
  ipcMain.on('note:cycle', (e, dir) => {
    const open = [...windows.entries()]
      .filter(([, w]) => !w.isDestroyed())
      .map(([id, w]) => ({ id, w, b: w.getBounds() }))
      .sort((a, b) => a.b.x - b.b.x || a.b.y - b.b.y);
    if (open.length < 2) return;
    const i = open.findIndex((o) => o.id === senderNote(e));
    const next = open[(i + (dir < 0 ? -1 : 1) + open.length) % open.length];
    if (next.w.isMinimized()) next.w.restore();
    next.w.show();
    next.w.focus();
  });

  ipcMain.on('note:new', (e) => newNoteFrom(senderNote(e)));
  // The note's own × / ctrl+d: a saved note is only closed, any other is deleted.
  ipcMain.on('note:close', (e) => {
    const id = senderNote(e);
    if (!id) return;
    const note = findNote(id);
    if (note && note.saved) stashNote(id); else deleteNote(id);
  });

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

  // "quit" from a note closes the notes; utilr itself quits from its tray
  ipcMain.on('app:quit', closeAll);

  // ---------------------------------------------------------------------------
  // notr as utilr sees it
  // ---------------------------------------------------------------------------

  // A monitor went away: pull notes back on screen.
  function onDisplayRemoved() {
    for (const [id, win] of windows) {
      if (win.isDestroyed()) continue;
      const b = ensureVisible(win.getBounds());
      win.setBounds(b);
      const n = findNote(id);
      if (n) n.bounds = b;
    }
    scheduleSave();
  }

  // In the background, like a start at login: no notes until "open notr".
  function start() {
    loadState();
    logLine(`start ${host.version} in utilr ${process.platform}`);
    registerOpenShortcut();
    screen.on('display-removed', onDisplayRemoved);
  }

  // utilr quits, or notr is removed: save and close every note. Notes that
  // were open come back open next time, like after a restart.
  function stop() {
    quitting = true;
    writeStateNow();
    screen.removeListener('display-removed', onDisplayRemoved);
    for (const win of [...kbd.keys()]) kbdStop(win);
    if (registeredOpen) { try { globalShortcut.unregister(registeredOpen); } catch (_) {} registeredOpen = null; }
    for (const win of openWindows()) win.destroy();
  }

  const newNote = () => { if (!openWindows().length) openAll(); else newNoteFrom(lastFocused); };

  // The "open notr" key, from utilr's keys page. The same rules as setting it
  // in a note: not a key a note already uses for add / delete.
  function setKey(id, raw) {
    if (id !== 'open') return { ok: false, error: 'unknown key' };
    const combo = Keys.normalize(raw);
    if (!combo) return { ok: false, error: 'not a shortcut' };
    const sc = state.settings.shortcuts;
    if (combo === sc.open) return { ok: true };
    const other = Keys.ACTIONS.find((a) => a !== 'open' && sc[a] === combo);
    if (other) return { ok: false, error: `${Keys.LABELS[other]} has it` };
    const old = sc.open;
    sc.open = combo;
    registerOpenShortcut();
    if (!registeredOpen) {
      sc.open = old;
      registerOpenShortcut();
      return { ok: false, error: 'another program has it' };
    }
    broadcast('settings:changed', publicSettings());
    scheduleSave();
    return { ok: true };
  }

  return {
    start,
    stop,
    open: showAll,
    actions: () => [
      { id: 'open', label: 'open notes', key: 'open', run: showAll },
      { id: 'new', label: 'new note', run: newNote },
      { id: 'close', label: 'close notes', run: closeAll },
    ],
    keys: () => [{ id: 'open', label: 'open notes', combo: state.settings.shortcuts.open, ok: registeredOpen !== null }],
    setKey,
  };
};
