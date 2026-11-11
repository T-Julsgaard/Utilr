'use strict';

// clipr, a utilr tool: everything you copied today, one key away.
//
// clipr watches the clipboard and keeps the text you copy, newest first, for
// as long as the computer is on. The history is only ever in memory: nothing
// you copy is written to disk, and a restart starts a clean day. Settings (the
// key, paste on pick, where the popup appears) live in host.dataDir.
//
//   alt+shift+v   the popup: type to find, enter pastes into the app you were in
//
// Electron has no "clipboard changed" event, so clipr asks every half second.
// One read is about 0.1 ms; clips that password managers mark as private are
// left out (the same formats Windows' own clipboard history respects), and the
// polling stops while the screen is locked or the computer sleeps.

const { app, BrowserWindow, screen, clipboard, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const Keys = require('./keys');

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

const BG = '#111111';              // ghost --bg, so the popup never flashes white
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const POPUP = { width: 400, height: 460 };
const POLL_MS = 500;
const MAX_CLIPS = 200;             // the oldest go first
const MAX_CHARS = 1000000;         // one clip; anything bigger isn't kept
const BUDGET = 4000000;            // every clip together, in characters
const PREVIEW = 600;               // characters of a clip the popup gets
const RELEASE_MS = 5 * 60 * 1000;  // the hidden popup is closed after this long unused
const PLACES = ['pointer', 'center'];

// "Don't keep this": what password managers put next to a secret. Windows
// also has CanIncludeInClipboardHistory, a DWORD that is 0 for "keep it out".
const RAW = (f) => `electron application/osclipboard;format="${f}"`;
const PRIVATE = IS_WIN ? [RAW('ExcludeClipboardContentFromMonitorProcessing')]
  : IS_MAC ? [RAW('org.nspasteboard.ConcealedType'), RAW('org.nspasteboard.TransientType')]
    : ['x-kde-passwordManagerHint'];
const NO_HISTORY = IS_WIN ? RAW('CanIncludeInClipboardHistory') : null;

// Paste = ctrl+v into the window that had focus before the popup. Windows
// only, through the script host every Windows has (about 60 ms to start).
// The script is written to host.dataDir, since cscript can't read from asar.
const PASTE_JS = 'WScript.CreateObject("WScript.Shell").SendKeys("^v");\r\n';
const CSCRIPT = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cscript.exe');

module.exports = function clipr(host) {
  const { ipc, shortcuts } = host;
  const log = (msg) => host.log(msg); // never the text of a clip, only sizes

  // ---------------------------------------------------------------------------
  // settings  (clipr-settings.json in host.dataDir)
  // ---------------------------------------------------------------------------

  // key:     the system-wide popup key
  // paste:   picking a clip also pastes it (windows); off = it's only copied
  // at:      where the popup opens: next to the pointer, or in the middle
  // paused:  nothing new is kept until you resume
  const defaults = () => ({ key: Keys.DEFAULT, paste: true, at: 'pointer', paused: false });
  const FILE = () => path.join(host.dataDir, 'clipr-settings.json');

  let settings = defaults();
  let saveTimer = null;

  function loadSettings() {
    try {
      const raw = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
      if (raw && typeof raw === 'object') settings = { ...defaults(), ...raw };
    } catch (_) { /* first run, or unreadable: the defaults */ }
    settings.key = Keys.normalize(settings.key) || Keys.DEFAULT;
    if (!PLACES.includes(settings.at)) settings.at = 'pointer';
    settings.paste = settings.paste !== false;
    settings.paused = settings.paused === true;
  }

  function saveNow() {
    clearTimeout(saveTimer);
    saveTimer = null;
    const file = FILE();
    const json = JSON.stringify({ key: settings.key, paste: settings.paste, at: settings.at, paused: settings.paused }, null, 1);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, json, 'utf8');
      try { fs.renameSync(tmp, file); } catch (_) { fs.writeFileSync(file, json, 'utf8'); }
    } catch (err) {
      log('could not save settings: ' + err.message);
    }
  }
  const save = () => { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 300); };

  const publicSettings = () => ({
    key: settings.key,
    keyOk: registered !== null || keyPaused,
    paste: settings.paste,
    canPaste: IS_WIN,
    at: settings.at,
    paused: settings.paused,
    version: host.version,
    hosted: true, // utilr does start at login and quit: clipr has no rows for them
  });

  // ---------------------------------------------------------------------------
  // the history: in memory, newest first
  // ---------------------------------------------------------------------------

  let clips = [];   // { id, text, at, lines }
  let total = 0;    // characters in clips
  let seq = 0;
  let last = null;  // the clipboard's text at the last look

  const countLines = (s) => { let n = 1; for (let i = s.indexOf('\n'); i !== -1; i = s.indexOf('\n', i + 1)) n++; return n; };

  // A copy you made before moves back to the top instead of showing twice.
  function keep(text) {
    const i = clips.findIndex((c) => c.text === text);
    if (i === 0) { clips[0].at = Date.now(); return; }
    let clip;
    if (i > 0) {
      clip = clips.splice(i, 1)[0];
      clip.at = Date.now();
    } else {
      clip = { id: ++seq, text, at: Date.now(), lines: countLines(text) };
      total += text.length;
    }
    clips.unshift(clip);
    while (clips.length > MAX_CLIPS || (total > BUDGET && clips.length > 1)) total -= clips.pop().text.length;
    changed();
  }

  function remove(id) {
    const i = clips.findIndex((c) => c.id === id);
    if (i < 0) return;
    total -= clips[i].text.length;
    clips.splice(i, 1);
    changed();
  }

  function clearAll() {
    clips = [];
    total = 0;
    changed();
    log('history cleared');
  }

  // the popup, if it's up, asks again with what you typed
  function changed() {
    if (shown && win && !win.isDestroyed()) win.webContents.send('clips:changed');
  }

  async function isPrivate() {
    for (const f of PRIVATE) {
      try { if (await clipboard.has(f)) return true; } catch (_) {}
    }
    if (!NO_HISTORY) return false;
    try {
      if (!(await clipboard.has(NO_HISTORY))) return false;
      const item = (await clipboard.read()).find((x) => x.types.includes(NO_HISTORY));
      if (!item) return false;
      const b = new Uint8Array(await (await item.getType(NO_HISTORY)).arrayBuffer());
      return b.length >= 4 && (b[0] | b[1] | b[2] | b[3]) === 0;
    } catch (_) {
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // watching the clipboard
  // ---------------------------------------------------------------------------

  let pollTimer = null;
  let polling = false;
  let asleep = false; // screen locked or computer asleep

  async function poll() {
    if (polling || asleep || settings.paused) return;
    polling = true;
    try {
      const text = await clipboard.readText();
      if (text !== last) {
        last = text;
        if (!text || !text.trim()) { /* an image, a file, or nothing: not text */ }
        else if (text.length > MAX_CHARS) log(`left out a clip of ${text.length} characters (too big)`);
        else if (await isPrivate()) log('left out a private clip');
        else keep(text);
      }
    } catch (_) { /* the clipboard was busy: next time */ }
    polling = false;
  }

  // What's on the clipboard now is where clipr starts from, without keeping it.
  // Used when you resume, so whatever you copied while paused stays out.
  async function baseline() {
    try { last = await clipboard.readText(); } catch (_) { last = null; }
  }

  function setPaused(on) {
    on = !!on;
    if (on === settings.paused) return;
    settings.paused = on;
    if (!on) baseline();
    log(on ? 'paused' : 'recording again');
    save();
    sendSettings();
    host.changed(); // the tray's pause / resume label
  }

  const onSleep = () => { asleep = true; };
  const onWake = () => { asleep = false; };
  const POWER = ['lock-screen', 'suspend'];
  const WAKE = ['unlock-screen', 'resume'];

  // ---------------------------------------------------------------------------
  // the popup: made the first time you open it, then kept (hidden) so the key
  // opens it at once
  // ---------------------------------------------------------------------------

  let win = null;
  let shown = false;
  let shownAt = 0;
  let stopping = false;
  let fadeTimer = null;
  let releaseTimer = null; // a popup you haven't used in a while is let go

  // Hidden but loaded, the popup opens at once. Unused for a while, it's
  // closed so it costs no memory; the next open makes it again (~0.2 s).
  function releaseLater() {
    clearTimeout(releaseTimer);
    releaseTimer = setTimeout(() => {
      if (shown || !win || win.isDestroyed()) return;
      win.destroy(); // no 'close' event: straight to 'closed'
      win = null;
    }, RELEASE_MS);
  }

  const easeOut = (t) => 1 - Math.pow(1 - t, 3);

  function fade(w, to, ms, done) {
    clearTimeout(fadeTimer);
    const from = w.getOpacity();
    const start = Date.now();
    const step = () => {
      if (w.isDestroyed()) return;
      const t = Math.min(1, (Date.now() - start) / ms);
      w.setOpacity(from + (to - from) * easeOut(t));
      if (t < 1) fadeTimer = setTimeout(step, 8);
      else if (done) done();
    };
    step();
  }

  function ensureWin() {
    if (win && !win.isDestroyed()) return win;
    const w = win = new BrowserWindow({
      ...POPUP,
      frame: false,
      show: false,
      opacity: 0,
      resizable: false,
      minimizable: IS_WIN, // see hide(): how the window you were in gets focus back
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      title: 'clipr',
      backgroundColor: BG,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        backgroundThrottling: false,
      },
    });
    w.setAlwaysOnTop(true, 'pop-up-menu');
    if (IS_MAC) w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    w.webContents.on('will-navigate', (e) => e.preventDefault());
    w.loaded = new Promise((res) => w.webContents.once('did-finish-load', res));
    w.loadFile(path.join(__dirname, 'popup.html'));
    // Click anywhere else and it goes. A blur in its first moments is focus
    // settling (Windows' foreground rules), not you.
    w.on('blur', () => {
      if (!shown) return;
      if (Date.now() - shownAt < 350) { setTimeout(() => { if (shown && !w.isDestroyed()) w.focus(); }, 30); return; }
      hide();
    });
    w.on('close', (e) => { if (!stopping) { e.preventDefault(); hide(); } });
    w.on('closed', () => { if (win === w) { win = null; shown = false; } });
    w.webContents.on('render-process-gone', () => { if (!w.isDestroyed()) w.reload(); });
    return w;
  }

  function popupBounds() {
    const { width, height } = POPUP;
    const cur = screen.getCursorScreenPoint();
    const wa = screen.getDisplayNearestPoint(cur).workArea;
    let x, y;
    if (settings.at === 'center') {
      x = Math.round(wa.x + (wa.width - width) / 2);
      y = Math.round(wa.y + (wa.height - height) / 3);
    } else {
      // below and right of the pointer, or the other side when there's no room
      x = cur.x + 12;
      y = cur.y + 12;
      if (x + width > wa.x + wa.width) x = cur.x - width - 12;
      if (y + height > wa.y + wa.height) y = cur.y - height - 12;
    }
    x = Math.max(wa.x, Math.min(wa.x + wa.width - width, x));
    y = Math.max(wa.y, Math.min(wa.y + wa.height - height, y));
    return { x, y, width, height };
  }

  async function show() {
    clearTimeout(releaseTimer);
    const t0 = Date.now();
    const cold = !win || win.isDestroyed();
    const w = ensureWin();
    shown = true;
    await w.loaded;
    if (cold) log(`popup made in ${Date.now() - t0} ms`);
    if (!shown || w.isDestroyed()) return;
    await poll(); // what you copied a moment ago is in it
    if (!shown || w.isDestroyed()) return;
    w.webContents.send('popup:show', snapshot(''));
    w.setOpacity(0);
    const b = popupBounds();
    w.setBounds(b);
    w.setBounds(b); // twice: Windows can rescale a window moved between DPIs
    shownAt = Date.now();
    w.show();
    if (IS_MAC) app.focus({ steal: true });
    w.focus();
    fade(w, 1, 120);
  }

  function hide(done) {
    const w = win;
    if (!w || w.isDestroyed() || !shown) { if (done) done(); return; }
    shown = false;
    w.webContents.send('popup:hide');
    if (keyPaused) { keyPaused = false; registerKey(); }
    fade(w, 0, 90, () => {
      if (!w.isDestroyed()) {
        // On Windows a hidden window hands focus to no one in particular; a
        // minimized one hands it to the window below, which is where you were.
        if (IS_WIN) w.minimize();
        w.hide();
      }
      if (done) done();
    });
    releaseLater();
  }

  const toggle = () => (shown ? hide() : show());

  // What the popup shows: every clip (or the ones with q in them), as a
  // preview. The whole text stays here; the popup picks by id.
  function snapshot(q) {
    const needle = String(q || '').toLowerCase();
    const items = [];
    for (const c of clips) {
      let from = 0;
      if (needle) {
        const i = c.text.toLowerCase().indexOf(needle);
        if (i < 0) continue;
        if (i > PREVIEW - needle.length - 40) from = Math.max(0, i - 40); // show the part that matched
      }
      items.push({
        id: c.id,
        text: (from ? '…' : '') + c.text.slice(from, from + PREVIEW),
        lines: c.lines,
        chars: c.text.length,
        at: c.at,
      });
    }
    return { items, count: clips.length, settings: publicSettings() };
  }

  function sendSettings() {
    if (win && !win.isDestroyed()) win.webContents.send('settings:changed', publicSettings());
  }

  // ---------------------------------------------------------------------------
  // picking a clip: on the clipboard, and pasted where you were
  // ---------------------------------------------------------------------------

  function pasteScript() {
    const file = path.join(host.dataDir, 'paste.js');
    try { if (fs.readFileSync(file, 'utf8') === PASTE_JS) return file; } catch (_) {}
    fs.writeFileSync(file, PASTE_JS, 'utf8');
    return file;
  }

  function sendPaste() {
    try {
      const p = spawn(CSCRIPT, ['//nologo', '//B', '//E:jscript', pasteScript()], { windowsHide: true, stdio: 'ignore' });
      p.on('error', (err) => log('paste failed: ' + err.message));
      p.unref();
    } catch (err) {
      log('paste failed: ' + err.message);
    }
  }

  async function pick(id, mode) {
    const c = clips.find((x) => x.id === id);
    if (!c) return false;
    try {
      await clipboard.writeText(c.text);
    } catch (err) {
      log('copy failed: ' + err.message);
      return false;
    }
    last = c.text;
    keep(c.text); // back on top
    const paste = mode !== 'copy' && settings.paste && IS_WIN;
    // Hidden first: the window you were in gets focus back, then ctrl+v.
    hide(() => { if (paste) setTimeout(sendPaste, 40); });
    return true;
  }

  // ---------------------------------------------------------------------------
  // the key (system-wide)
  // ---------------------------------------------------------------------------

  let registered = null; // the accelerator clipr holds
  let keyPaused = false; // while the menu records a new key, the old one is quiet

  function registerKey() {
    if (registered) { shortcuts.unregister(registered); registered = null; }
    if (keyPaused) return true;
    const accel = Keys.toAccelerator(settings.key);
    if (shortcuts.register(accel, toggle)) {
      registered = accel;
      log(`key ready: ${accel}`);
      return true;
    }
    log(`key NOT available (another tool or program has it): ${accel}`);
    return false;
  }

  function setKey(id, raw) {
    if (id !== 'key') return { ok: false, error: 'unknown key' };
    const combo = Keys.normalize(raw);
    if (!combo) return { ok: false, error: 'not a shortcut' };
    if (combo === settings.key && registered) return { ok: true };
    const old = settings.key;
    settings.key = combo;
    if (!registerKey()) {
      settings.key = old;
      registerKey();
      sendSettings();
      return { ok: false, error: 'another program has it' };
    }
    save();
    sendSettings();
    host.changed();
    return { ok: true };
  }

  // ---------------------------------------------------------------------------
  // IPC  (channels are "clipr/…"; only the popup may talk)
  // ---------------------------------------------------------------------------

  const fromPopup = (e) => win && !win.isDestroyed() && e.sender === win.webContents;

  ipc.handle('list', (e, q) => (fromPopup(e) ? snapshot(q) : null));
  ipc.handle('pick', (e, id, mode) => (fromPopup(e) ? pick(+id, String(mode)) : false));
  ipc.handle('settings:get', (e) => (fromPopup(e) ? publicSettings() : null));
  ipc.on('remove', (e, id) => { if (fromPopup(e)) remove(+id); });
  ipc.on('clear', (e) => { if (fromPopup(e)) clearAll(); });
  ipc.on('hide', (e) => { if (fromPopup(e)) hide(); });
  ipc.on('key:record', (e, on) => {
    if (!fromPopup(e)) return;
    keyPaused = !!on;
    registerKey();
  });
  ipc.on('settings:set', (e, patch) => {
    if (!fromPopup(e) || !patch || typeof patch !== 'object') return;
    if (typeof patch.paste === 'boolean') settings.paste = patch.paste;
    if (PLACES.includes(patch.at)) settings.at = patch.at;
    if (typeof patch.paused === 'boolean') setPaused(patch.paused);
    if (typeof patch.key === 'string') {
      keyPaused = false;
      const r = setKey('key', patch.key);
      if (!r.ok) e.sender.send('settings:key-taken', r.error === 'not a shortcut' ? 'add ctrl or alt' : 'taken');
    }
    save();
    sendSettings();
  });

  // ---------------------------------------------------------------------------
  // clipr as utilr sees it
  // ---------------------------------------------------------------------------

  // No window until you open it: start is the settings, the key and a timer.
  function start() {
    stopping = false;
    loadSettings();
    registerKey();
    if (!settings.paused) poll(); // what's on the clipboard now counts as copied today
    else baseline();
    pollTimer = setInterval(poll, POLL_MS);
    for (const ev of POWER) powerMonitor.on(ev, onSleep);
    for (const ev of WAKE) powerMonitor.on(ev, onWake);
  }

  // utilr quits, or clipr is removed: the history goes with it.
  function stop() {
    stopping = true;
    saveNow();
    clearInterval(pollTimer);
    clearTimeout(fadeTimer);
    clearTimeout(releaseTimer);
    pollTimer = null;
    for (const ev of POWER) powerMonitor.removeListener(ev, onSleep);
    for (const ev of WAKE) powerMonitor.removeListener(ev, onWake);
    if (registered) { shortcuts.unregister(registered); registered = null; }
    shown = false;
    if (win && !win.isDestroyed()) win.destroy();
    win = null;
    clips = [];
    total = 0;
  }

  return {
    start,
    stop,
    open: show,
    actions: () => [
      { id: 'open', label: 'clipboard history', key: 'key', run: show },
      { id: 'pause', label: settings.paused ? 'resume recording' : 'pause recording', run: () => setPaused(!settings.paused) },
      { id: 'clear', label: 'clear history', run: clearAll },
    ],
    keys: () => [{ id: 'key', label: 'clipboard history', combo: settings.key, ok: registered !== null || keyPaused }],
    setKey,
  };
};
