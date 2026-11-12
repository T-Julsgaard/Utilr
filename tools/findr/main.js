'use strict';

// findr, a utilr tool: every file on every drive, found as you type.
//
// Windows' own search only knows what its indexer got around to (on some
// machines a few hundred files). findr keeps its own list of every name on
// your drives instead, no admin needed:
//
//   engine   a worker thread holds the list and answers searches (worker.js,
//            engine.js); the main process never holds a million names. It's
//            put away when findr isn't used for a while (see "the threads")
//   scans    one thread per drive reads every folder (walk.js); after the
//            first time the list comes from a cache in host.dataDir at once
//   watch    a small thread watches the fixed drives (watch.js), so new,
//            renamed and deleted files show up within a second
//
//   alt+shift+d   the popup: type, enter opens, ctrl+enter opens the folder
//
// Drives come from Windows (PowerShell, Win32_LogicalDisk): local and USB
// drives are in by default, network drives and discs aren't.

const { BrowserWindow, screen, shell, clipboard } = require('electron');
const { Worker, MessageChannel } = require('worker_threads');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const Keys = require('./keys');
const Boot = require('./boot');
const T = require('./timing');

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

const BG = '#111111';              // ghost --bg, so the popup never flashes white
const POPUP = { width: 620, height: 440 };
// How the popup looks (findr's menu › look):
//   bar     just a search bar; results drop below it once you type (the default)
//   window  a window: two-line rows, the status line, chrome on hover
//   line    a line across the top of the screen; results as a table below
// The bar and the line are drawn on a transparent window a little bigger
// than they are, so they can grow, cast their shadow and hold the menu.
const LOOKS = ['bar', 'window', 'line'];
const BAR = { width: 680, height: 500, top: 0.2 }; // top: where the bar sits, as a share of the screen
const LINE = { height: 0.62, max: 560 };
const LIMIT = 100;                 // results the popup gets
const BOOT_AFTER = 1500;           // the engine starts this long after utilr does
const RELEASE_MS = 5 * 60 * 1000;  // the hidden popup is closed after this long unused
const DRIVES_EVERY = 30 * 1000;    // opening the popup looks for new drives at most this often
const UNLOAD_AFTER = 5 * 60 * 1000; // the index is put away after this long unused (see "the threads")
const BUSY_SOON = 2 * 60 * 1000;   // but not when a scan is due sooner than this
const MAX_RECENT = 40;
const TYPES = { 2: 'usb', 3: 'local', 4: 'network', 5: 'disc', 6: 'ram' };
const ON_BY_DEFAULT = new Set(['local', 'usb', 'ram']);
const WATCHED = new Set(['local', 'ram']); // a watch on a USB drive would stop you ejecting it

const PS = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const PS_DRIVES = "Get-CimInstance Win32_LogicalDisk | ForEach-Object { '' + $_.DeviceID + '|' + $_.DriveType + '|' + $_.Size + '|' + $_.VolumeName }";

const pkey = (p) => String(p).toLowerCase().replace(/\//g, '\\').replace(/\\+$/, '');

module.exports = function findr(host) {
  const { ipc, shortcuts } = host;
  const log = (msg) => host.log(msg); // never what you searched for

  // ---------------------------------------------------------------------------
  // settings  (findr-settings.json in host.dataDir)
  // ---------------------------------------------------------------------------

  // key:      the system-wide popup key
  // drives:   { c: false, … } only what you changed; the rest follow the type
  // known:    the drives seen last time, so the engine can start before
  //           Windows has been asked again
  // folders:  extra places to cover, e.g. a network share (settings file only)
  // recent:   remember what you open (it's ranked first, and shown before you type)
  // look:     bar, window or line (see LOOKS)
  // windowsFolders: what's inside a drive's own Windows folder is found too
  //           (off: the folder is listed, its hundreds of thousands of system
  //           files aren't, which saves memory and scan time)
  const defaults = () => ({ key: Keys.DEFAULT, drives: {}, known: [], folders: [], recent: true, look: 'bar', windowsFolders: false });
  const FILE = () => path.join(host.dataDir, 'findr-settings.json');
  const RECENT = () => path.join(host.dataDir, 'findr-recent.json');

  let settings = defaults();
  let saveTimer = null;

  function loadSettings() {
    try {
      const raw = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
      if (raw && typeof raw === 'object') settings = { ...defaults(), ...raw };
    } catch (_) { /* first run, or unreadable: the defaults */ }
    settings.key = Keys.normalize(settings.key) || Keys.DEFAULT;
    if (!settings.drives || typeof settings.drives !== 'object') settings.drives = {};
    if (!Array.isArray(settings.known)) settings.known = [];
    settings.known = settings.known.filter((d) => d && /^[a-z]$/.test(d.letter) && typeof d.type === 'string');
    if (!Array.isArray(settings.folders)) settings.folders = [];
    settings.folders = settings.folders.filter((f) => typeof f === 'string' && path.isAbsolute(f));
    settings.recent = settings.recent !== false;
    settings.windowsFolders = settings.windowsFolders === true;
    if (!LOOKS.includes(settings.look)) settings.look = 'bar';
  }

  function writeJson(file, data) {
    const json = JSON.stringify(data, null, 1);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, json, 'utf8');
    try { fs.renameSync(tmp, file); } catch (_) { fs.writeFileSync(file, json, 'utf8'); }
  }

  function saveNow() {
    clearTimeout(saveTimer);
    saveTimer = null;
    try {
      writeJson(FILE(), settings);
    } catch (err) {
      log('could not save settings: ' + err.message);
    }
  }
  const save = () => { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 300); };

  // ---------------------------------------------------------------------------
  // what you opened (findr-recent.json): first when you haven't typed yet,
  // and ranked up when you have
  // ---------------------------------------------------------------------------

  let recent = [];

  function loadRecent() {
    recent = [];
    if (!settings.recent) return;
    try {
      const raw = JSON.parse(fs.readFileSync(RECENT(), 'utf8'));
      if (Array.isArray(raw)) recent = raw.filter((p) => typeof p === 'string').slice(0, MAX_RECENT);
    } catch (_) {}
  }

  function saveRecent() {
    try {
      if (!settings.recent) { fs.rmSync(RECENT(), { force: true }); return; }
      writeJson(RECENT(), recent);
    } catch (err) {
      log('could not save recent: ' + err.message);
    }
    if (engine) engine.postMessage({ type: 'recent', recent });
  }

  function remember(p) {
    if (!settings.recent) return;
    const k = pkey(p);
    recent = [p, ...recent.filter((x) => pkey(x) !== k)].slice(0, MAX_RECENT);
    saveRecent();
  }

  function forget(p) {
    const k = pkey(p);
    const n = recent.length;
    recent = recent.filter((x) => pkey(x) !== k);
    if (recent.length !== n) saveRecent();
  }

  function clearRecent() {
    recent = [];
    saveRecent();
    if (shown && !lastQ) refreshPopup();
  }

  // ---------------------------------------------------------------------------
  // drives
  // ---------------------------------------------------------------------------

  let drivesAt = 0;
  let detecting = null;

  // Ask Windows which drives there are, and what kind. About half a second
  // (PowerShell starting), so it's done in the background and kept.
  function detectDrives() {
    if (detecting) return detecting;
    detecting = new Promise((resolve) => {
      execFile(PS, ['-NoProfile', '-NonInteractive', '-Command', PS_DRIVES], { windowsHide: true, timeout: 15000 }, (err, out) => {
        detecting = null;
        drivesAt = Date.now();
        if (err) {
          log('could not list the drives: ' + err.message);
          if (!settings.known.length) settings.known = [{ letter: 'c', type: 'local', label: '' }];
          return resolve(false);
        }
        const found = [];
        for (const line of String(out).split(/\r?\n/)) {
          const [id, type, size, ...label] = line.trim().split('|');
          const m = /^([A-Za-z]):$/.exec(id || '');
          if (!m || !(Number(size) > 0)) continue; // a disc drive with no disc
          found.push({ letter: m[1].toLowerCase(), type: TYPES[type] || 'other', label: label.join('|').trim() });
        }
        found.sort((a, b) => a.letter.localeCompare(b.letter));
        const changed = JSON.stringify(found) !== JSON.stringify(settings.known);
        if (changed) {
          log(`drives: ${found.map((d) => `${d.letter}: ${d.type}`).join(', ')}`);
          settings.known = found;
          save();
          configure();
          sendSettings();
        }
        resolve(changed);
      });
    });
    return detecting;
  }

  const driveOn = (d) => (d.letter in settings.drives ? !!settings.drives[d.letter] : ON_BY_DEFAULT.has(d.type));

  // noWindows: a drive's own Windows folder is listed, not walked (findr's
  // "windows folders" setting, off by default)
  function roots() {
    const noWindows = !settings.windowsFolders;
    const out = settings.known.filter(driveOn).map((d) => ({ root: d.letter.toUpperCase() + ':\\', watch: WATCHED.has(d.type), noWindows }));
    for (const f of settings.folders) if (fs.existsSync(f)) out.push({ root: f, watch: true, noWindows: false });
    return out;
  }

  // ---------------------------------------------------------------------------
  // the threads
  // ---------------------------------------------------------------------------
  //
  // RAM saver off (utilr's settings; the default): one engine thread
  // (worker.js) holds the index and watches the drives, always.
  //
  // RAM saver on: the watch moves to a thread of its own (watch.js), small and
  // always on, and the engine is put away when findr isn't used. After
  // UNLOAD_AFTER without the popup, and with no scan running or due soon, it
  // saves what changed and is ended, and its memory goes back to Windows.
  // Meanwhile the watch keeps which folders change. Opening the popup brings
  // the engine back: the cache in a fraction of a second, then those folders.
  // A scan that comes due while it's away (every 6 hours, or Windows losing
  // track) brings it back for that, and it goes again once the scan's done.

  let engine = null;
  let watcher = null;
  let bootTimer = null;
  let restarts = 0;
  let watchRestarts = 0;
  let index = [];       // per root: { root, count, scanning, found, at, due } (kept while it's away)
  let seq = 0;
  let inflight = null;  // { seq, resolve }
  let queued = null;    // { q, resolve }: only the newest waits
  let usedAt = 0;       // the popup last shown, hidden or searched
  let heard = false;    // the engine has said how it is since it started
  let parking = false;  // it's been asked to go, and hasn't answered yet
  let away = null;      // put away: root key -> { at, why, lost }, its next scan
  let wantBack = false; // wanted again while it was going
  let wantRescan = false;
  let lostLater = [];   // Windows lost track while it was going: { root, why }
  let idleTimer = null;
  let wakeTimer = null;

  const saving = () => !!(host.ramSaver && host.ramSaver());
  const unloadAfter = () => (host.ramSaverMs ? host.ramSaverMs() : UNLOAD_AFTER);

  // RAM saver turned off: the engine watches again (and comes back if it was
  // away); the watch thread hands over what it kept, then goes
  function retireWatch() {
    if (!watcher || parking || saving()) return;
    const w = watcher;
    watcher = null;
    setTimeout(() => w.terminate(), 2000); // time to pass on what it kept
    configure(); // the engine watches again
  }

  function setRamSaver(on) {
    if (stopping) return;
    if (on) {
      bootWatch();
      link();
      configure(); // the engine stops watching: the watch thread does
      armIdle();
      return;
    }
    clearTimeout(idleTimer);
    if (parking) { wantBack = true; return; } // back once it's gone, then the watch goes
    if (!engine) bootEngine('ram saver off'); // with what the watch thread kept
    retireWatch();
  }

  function bootWatch() {
    if (watcher || stopping) return;
    const w = watcher = new Worker(Boot.CODE, {
      eval: true,
      workerData: { entry: './watch', srcs: Boot.sources(), cacheDir: host.dataDir },
    });
    w.on('message', (m) => { if (watcher === w) fromWatch(m); });
    w.on('error', (err) => log('watch failed: ' + (err && err.stack || err)));
    w.on('exit', (code) => {
      if (watcher !== w) return;
      watcher = null;
      if (stopping) return;
      log(`watch stopped (${code})`);
      parking = false;
      if (watchRestarts++ >= 3) return;
      setTimeout(() => {
        if (stopping || !saving()) return;
        bootWatch();
        link();
        // what changed in between is lost: read it all again
        for (const r of index) lost(r.root, 'the watch stopped');
      }, 5000);
    });
    w.postMessage({ type: 'roots', roots: roots() });
  }

  function bootEngine(why = 'started') {
    if (stopping) return;
    if (parking) { wantBack = true; return; }
    if (engine) return;
    clearTimeout(wakeTimer);
    wakeTimer = null;
    heard = false;
    const w = engine = new Worker(Boot.CODE, {
      eval: true,
      workerData: { entry: './worker', srcs: Boot.sources(), boot: Boot.CODE, cacheDir: host.dataDir },
    });
    w.on('message', (m) => { if (engine === w) fromEngine(m); });
    w.on('error', (err) => log('engine failed: ' + (err && err.stack || err)));
    w.on('exit', (code) => {
      if (engine !== w) return;
      engine = null;
      parking = false;
      endSearches();
      if (watcher) watcher.postMessage({ type: 'detach' }); // keep what changes until the next one
      if (stopping) return;
      log(`engine stopped (${code})`);
      if (restarts++ < 3) bootTimer = setTimeout(bootEngine, 5000);
    });
    w.postMessage({ type: 'recent', recent });
    const resume = away;
    away = null;
    configure(resume);
    link();
    if (wantRescan) { wantRescan = false; w.postMessage({ type: 'rescan' }); }
    if (resume) log(`index back (${why})`);
    armIdle();
  }

  // looked at every so often while the engine is up (RAM saver on), and again
  // when the popup goes
  function armIdle() {
    clearTimeout(idleTimer);
    if (!saving()) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      maybePark();
      if (engine && !parking) armIdle();
    }, Math.min(30 * 1000, Math.max(250, unloadAfter() / 4)));
  }

  // the engine and the watch, joined: changes go straight from one to the other
  function link() {
    if (!engine || !watcher) return;
    const { port1, port2 } = new MessageChannel();
    engine.postMessage({ type: 'port', port: port2 }, [port2]);
    watcher.postMessage({ type: 'attach', port: port1 }, [port1]);
  }

  // resume: from the engine that was put away, so the new one carries on
  // where it stopped
  function configure(resume = null) {
    const rs = roots();
    if (watcher) watcher.postMessage({ type: 'roots', roots: rs });
    if (away) {
      const keep = new Set(rs.map((r) => pkey(r.root)));
      for (const k of away.keys()) if (!keep.has(k)) away.delete(k);
      armWake();
    }
    if (!engine) return;
    engine.postMessage({
      type: 'config',
      roots: rs.map((r) => ({
        root: r.root,
        watch: r.watch && !watcher, // the engine watches, unless the watch thread does
        noWindows: r.noWindows,
        resume: resume ? resume.get(pkey(r.root)) || null : null,
      })),
      home: process.env.USERPROFILE || '',
    });
  }

  // Not used for a while, and nothing to do soon: put it away. The watch
  // passes the request on behind the last change it sent, and the engine
  // answers "parked" or "busy".
  function maybePark() {
    if (!saving() || !engine || !watcher || parking || stopping || shown || !heard || inflight) return;
    const now = Date.now();
    if (now - usedAt < unloadAfter()) return;
    if (index.some((r) => r.scanning || (r.due && r.due - now < BUSY_SOON))) return;
    parking = true;
    watcher.postMessage({ type: 'detach' });
  }

  function parked(m) {
    const w = engine;
    engine = null;
    parking = false;
    clearTimeout(idleTimer);
    endSearches();
    w.terminate();
    // what it hadn't read yet goes back to the watch, to be handed on
    if (watcher) {
      watcher.postMessage({ type: 'detach' });
      const back = m.roots.filter((r) => r.dirs.length).map((r) => ({ root: r.root, dirs: r.dirs }));
      if (back.length) watcher.postMessage({ type: 'requeue', roots: back });
    }
    away = new Map(m.roots.map((r) => [pkey(r.root), { at: r.at || 0, why: r.why || '', lost: !!r.lost }]));
    index = index.map((r) => ({ ...r, scanning: false }));
    log(`index put away after ${Math.round((Date.now() - usedAt) / 60000)} min unused (it held ${m.heap})`);
    for (const l of lostLater) lost(l.root, l.why);
    lostLater = [];
    armWake();
    if (wantBack) {
      wantBack = false;
      bootEngine(saving() ? 'wanted while it was going' : 'ram saver off');
      if (shown) refreshPopup(); // what it asked for in between went unanswered
      retireWatch(); // the RAM saver was turned off meanwhile
    }
  }

  // Windows lost track of a drive (or the watch stopped) while the engine
  // wasn't listening: its scan, as the engine would have planned it (a minute
  // from now, not sooner than 15 minutes after the last), and the engine
  // back for it then.
  function lost(root, why) {
    if (parking) { lostLater.push({ root, why }); return; }
    if (engine) { engine.postMessage({ type: 'lost', root, why }); return; }
    if (!away) return; // not started yet: the first scan is on its way
    const k = pkey(root);
    const e = away.get(k);
    const r = index.find((x) => pkey(x.root) === k);
    if (!e || !r || e.lost) return; // unknown, or one's on its way
    const now = Date.now();
    if (now - r.at < T.QUIET_AFTER && why !== 'the watch stopped') return;
    const at = Math.max(now + T.LOST_WAIT, r.at + T.LOST_EVERY);
    if (!e.at || at < e.at) { e.at = at; e.why = why; }
    e.lost = true;
    armWake();
  }

  function armWake() {
    clearTimeout(wakeTimer);
    wakeTimer = null;
    if (!away || stopping) return;
    const ats = [...away.values()].map((e) => e.at).filter(Boolean);
    if (!ats.length) return;
    const ms = Math.max(0, Math.min(Math.min(...ats) - Date.now(), 2 ** 31 - 1));
    wakeTimer = setTimeout(() => { wakeTimer = null; bootEngine('a scan is due'); }, ms);
  }

  function fromWatch(m) {
    if (m.type === 'log') log(m.msg);
    else if (m.type === 'lost') lost(m.root, m.why);
  }

  function fromEngine(m) {
    if (m.type === 'log') log(m.msg);
    else if (m.type === 'status') {
      index = m.roots;
      heard = true;
      if (shown && win && !win.isDestroyed()) win.webContents.send('index:status', publicStatus());
    } else if (m.type === 'parked') {
      parked(m);
    } else if (m.type === 'busy') {
      // it stays (a scan started, or a cache couldn't be written)
      parking = false;
      wantBack = false;
      if (watcher) watcher.postMessage({ type: 'attach' });
      for (const l of lostLater) engine.postMessage({ type: 'lost', root: l.root, why: l.why });
      lostLater = [];
      armIdle();
    } else if (m.type === 'results') {
      if (!inflight || m.seq !== inflight.seq) return;
      const done = inflight.resolve;
      inflight = null;
      done(m);
      if (queued) { const q = queued; queued = null; ask(q.q, q.resolve); }
    }
  }

  function ask(q, resolve) {
    inflight = { seq: ++seq, resolve };
    engine.postMessage({ type: 'search', seq, q, limit: LIMIT });
  }

  // One search at a time; while one runs, only the newest waits (typing fast
  // never piles up work).
  function engineSearch(q) {
    return new Promise((resolve) => {
      if (!engine) return resolve(null);
      if (!inflight) return ask(q, resolve);
      if (queued) queued.resolve(null);
      queued = { q, resolve };
    });
  }

  function endSearches() {
    if (inflight) inflight.resolve(null);
    if (queued) queued.resolve(null);
    inflight = queued = null;
  }

  const publicStatus = () => ({
    roots: index.map((r) => ({ root: r.root, count: r.count, scanning: r.scanning, found: r.found })),
    total: index.reduce((s, r) => s + r.count, 0),
    scanning: index.some((r) => r.scanning),
    ready: !!engine || !!away,
  });

  function rescan() {
    log('rescan');
    if (engine && !parking) { engine.postMessage({ type: 'rescan' }); return; }
    wantRescan = true;
    bootEngine('rescan');
  }

  // ---------------------------------------------------------------------------
  // the popup: made the first time you open it, then kept (hidden) so the key
  // opens it at once
  // ---------------------------------------------------------------------------

  let win = null;
  let shown = false;
  let shownAt = 0;
  let stopping = false;
  let fadeTimer = null;
  let releaseTimer = null;
  let last = [];   // what the popup shows: [{ path, name, dir, isDir }], picked by index
  let lastQ = '';

  function releaseLater() {
    clearTimeout(releaseTimer);
    releaseTimer = setTimeout(() => {
      if (shown || !win || win.isDestroyed()) return;
      win.destroy();
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

  // One window at a time, made for the look you chose (a window can't turn
  // transparent later, so a new look means a new window).
  function ensureWin() {
    if (win && !win.isDestroyed() && win.look === settings.look) return win;
    if (win && !win.isDestroyed()) { const old = win; win = null; old.destroy(); }
    const clear = settings.look !== 'window';
    const w = win = new BrowserWindow({
      ...POPUP,
      frame: false,
      show: false,
      opacity: 0,
      resizable: false,
      minimizable: true, // see hide(): how the window you were in gets focus back
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      title: 'findr',
      transparent: clear,
      hasShadow: !clear,
      backgroundColor: clear ? '#00000000' : BG,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        backgroundThrottling: false,
      },
    });
    w.look = settings.look;
    w.setAlwaysOnTop(true, 'pop-up-menu');
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

  // On the screen with the pointer. The window: in the middle, a third of the
  // way down. The bar: in the middle, a fifth of the way down (it grows
  // downwards). The line: across the top.
  function popupBounds() {
    const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    if (settings.look === 'line') {
      return { x: wa.x, y: wa.y, width: wa.width, height: Math.round(Math.min(LINE.max, wa.height * LINE.height)) };
    }
    const { width, height } = settings.look === 'bar' ? BAR : POPUP;
    const w = Math.min(width, wa.width), h = Math.min(height, wa.height);
    const top = settings.look === 'bar' ? wa.height * BAR.top : (wa.height - h) / 3;
    return {
      x: Math.round(wa.x + (wa.width - w) / 2),
      y: Math.round(wa.y + Math.max(0, Math.min(top, wa.height - h))),
      width: w,
      height: h,
    };
  }

  // A new look, while the popup is up: it's made again in that look and
  // opens with the look menu still there, so you can flip through them.
  function setLook(look) {
    if (!LOOKS.includes(look) || look === settings.look) return;
    settings.look = look;
    save();
    log(`look: ${look}`);
    if (!win || win.isDestroyed()) return;
    const old = win, was = shown;
    win = null;
    shown = false;
    clearTimeout(fadeTimer);
    old.destroy();
    if (was) show({ menu: 'look', q: lastQ });
  }

  async function show(opts = {}) {
    clearTimeout(releaseTimer);
    usedAt = Date.now();
    if (!stopping && (!engine || parking)) { if (saving()) bootWatch(); bootEngine('opened'); }
    if (Date.now() - drivesAt > DRIVES_EVERY) detectDrives(); // a USB drive you just put in
    const t0 = Date.now();
    const cold = !win || win.isDestroyed();
    const w = ensureWin();
    shown = true;
    await w.loaded;
    if (cold) log(`popup made in ${Date.now() - t0} ms`);
    if (!shown || w.isDestroyed()) return;
    const q = typeof opts.q === 'string' ? opts.q : '';
    const first = q.trim() ? (await search(q)) || (await listRecent()) : (lastQ = '', await listRecent());
    if (!shown || w.isDestroyed()) return;
    w.webContents.send('popup:show', { ...first, q, menu: opts.menu || null, settings: publicSettings() });
    w.setOpacity(0);
    const b = popupBounds();
    w.setBounds(b);
    w.setBounds(b); // twice: Windows can rescale a window moved between DPIs
    shownAt = Date.now();
    w.show();
    w.focus();
    fade(w, 1, 120);
  }

  // back = true: the window you were in gets focus back (esc, click away).
  // After opening something, no: what you opened should keep it.
  function hide(back = true, done) {
    const w = win;
    if (!w || w.isDestroyed() || !shown) { if (done) done(); return; }
    shown = false;
    usedAt = Date.now();
    if (engine) armIdle();
    w.webContents.send('popup:hide');
    if (keyPaused) { keyPaused = false; registerKey(); }
    fade(w, 0, 90, () => {
      if (!w.isDestroyed()) {
        // a hidden window hands focus to no one in particular; a minimized
        // one hands it to the window below, which is where you were
        if (back) w.minimize();
        w.hide();
      }
      if (done) done();
    });
    releaseLater();
  }

  const toggle = () => (shown ? hide() : show());

  function refreshPopup() {
    if (win && !win.isDestroyed()) win.webContents.send('popup:show', null);
  }

  // ---------------------------------------------------------------------------
  // searching, opening
  // ---------------------------------------------------------------------------

  const split = (p) => {
    const cut = p.replace(/\\+$/, '').lastIndexOf('\\');
    return { name: cut < 0 ? p : p.slice(cut + 1) || p, dir: cut < 0 ? '' : p.slice(0, cut) };
  };

  // what you opened, newest first, without the ones that are gone
  async function listRecent() {
    const items = (await Promise.all(recent.map(async (p) => {
      try {
        const st = await fs.promises.stat(p);
        return { path: p, ...split(p), isDir: st.isDirectory() };
      } catch (_) {
        return null;
      }
    }))).filter(Boolean);
    last = items;
    return { q: '', items: items.map(view), total: items.length, recent: true, status: publicStatus() };
  }

  const view = ({ name, dir, isDir }) => ({ name, dir, isDir });

  async function search(q) {
    lastQ = q;
    usedAt = Date.now();
    if (!q.trim()) return listRecent();
    const r = await engineSearch(q);
    if (!r || q !== lastQ) return null; // a newer search took its place
    last = r.items;
    return { q, items: r.items.map(view), total: r.total, ms: r.ms, status: publicStatus() };
  }

  async function open(i, how) {
    const it = last[i];
    if (!it) return { ok: false };
    if (how === 'copy') {
      clipboard.writeText(it.path);
      return { ok: true, note: 'path copied' };
    }
    if (how === 'folder') {
      shell.showItemInFolder(it.path);
      hide(false);
      return { ok: true };
    }
    // opened while the popup still has focus, so Windows lets the app you
    // open come to the front; then the popup goes
    const err = await shell.openPath(it.path);
    if (err) {
      const gone = !fs.existsSync(it.path);
      if (gone) {
        forget(it.path);
        if (engine) engine.postMessage({ type: 'touch', path: it.path });
      }
      log(`could not open a ${it.isDir ? 'folder' : 'file'}: ${gone ? 'it is gone' : err}`);
      return { ok: false, error: gone ? 'gone' : "can't open it" };
    }
    remember(it.path);
    hide(false);
    return { ok: true };
  }

  async function details(i) {
    const it = last[i];
    if (!it) return null;
    try {
      const st = await fs.promises.stat(it.path);
      return { size: st.isDirectory() ? null : st.size, mtime: st.mtimeMs };
    } catch (_) {
      return { gone: true };
    }
  }

  // ---------------------------------------------------------------------------
  // the key (system-wide)
  // ---------------------------------------------------------------------------

  let registered = null;
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
    if (id !== 'key') return { ok: false, error: 'unknown shortcut' };
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
  // settings, as the popup's menu sees them
  // ---------------------------------------------------------------------------

  const publicSettings = () => ({
    key: settings.key,
    keyOk: registered !== null || keyPaused,
    drives: settings.known.map((d) => ({ letter: d.letter, type: d.type, label: d.label, on: driveOn(d) })),
    folders: settings.folders.slice(),
    recent: settings.recent,
    windowsFolders: settings.windowsFolders,
    look: settings.look,
    version: host.version,
    hosted: true, // utilr does start at login and quit: findr has no rows for them
  });

  function sendSettings() {
    if (win && !win.isDestroyed()) win.webContents.send('settings:changed', publicSettings());
  }

  // ---------------------------------------------------------------------------
  // IPC  (channels are "findr/…"; only the popup may talk)
  // ---------------------------------------------------------------------------

  const fromPopup = (e) => win && !win.isDestroyed() && e.sender === win.webContents;

  ipc.handle('search', (e, q) => (fromPopup(e) ? search(String(q || '').slice(0, 500)) : null));
  ipc.handle('open', (e, i, how) => (fromPopup(e) ? open(+i, String(how)) : { ok: false }));
  ipc.handle('details', (e, i) => (fromPopup(e) ? details(+i) : null));
  ipc.handle('settings:get', (e) => (fromPopup(e) ? publicSettings() : null));
  ipc.on('forget', (e, i) => {
    if (!fromPopup(e) || lastQ.trim()) return;
    const it = last[+i];
    if (it) forget(it.path);
  });
  ipc.on('rescan', (e) => { if (fromPopup(e)) rescan(); });
  ipc.on('hide', (e) => { if (fromPopup(e)) hide(); });
  ipc.on('key:record', (e, on) => {
    if (!fromPopup(e)) return;
    keyPaused = !!on;
    registerKey();
  });
  ipc.on('settings:set', (e, patch) => {
    if (!fromPopup(e) || !patch || typeof patch !== 'object') return;
    if (patch.drive && /^[a-z]$/.test(patch.drive.letter)) {
      settings.drives[patch.drive.letter] = !!patch.drive.on;
      configure();
    }
    if (typeof patch.look === 'string') { setLook(patch.look); return; } // a new window; it gets the settings itself
    if (typeof patch.windowsFolders === 'boolean' && patch.windowsFolders !== settings.windowsFolders) {
      settings.windowsFolders = patch.windowsFolders;
      log(`windows folders ${settings.windowsFolders ? 'in' : 'left out'}`);
      configure(); // those drives are read again
    }
    if (typeof patch.recent === 'boolean') {
      settings.recent = patch.recent;
      if (!patch.recent) clearRecent();
    }
    if (typeof patch.key === 'string') {
      keyPaused = false;
      const r = setKey('key', patch.key);
      if (!r.ok) e.sender.send('settings:key-taken', r.error === 'not a shortcut' ? 'add ctrl or alt' : 'taken');
    }
    save();
    sendSettings();
  });

  // ---------------------------------------------------------------------------
  // findr as utilr sees it
  // ---------------------------------------------------------------------------

  // Settings and the key now; the engine a moment later, so utilr itself
  // starts as fast as ever. No window until you open it.
  function start() {
    stopping = false;
    restarts = 0;
    watchRestarts = 0;
    usedAt = 0;
    loadSettings();
    loadRecent();
    registerKey();
    bootTimer = setTimeout(() => {
      if (saving()) bootWatch();
      bootEngine();
      detectDrives();
    }, BOOT_AFTER);
  }

  // utilr quits, or findr is removed. The index is on disk already (saved
  // after every scan, every 10 minutes while things change, and when it's put
  // away); the engine gets a moment to save what changed since, then it's
  // ended. If utilr quits first, the scan on the next start catches up.
  function stop() {
    stopping = true;
    saveNow();
    clearTimeout(bootTimer);
    clearTimeout(fadeTimer);
    clearTimeout(releaseTimer);
    clearTimeout(idleTimer);
    clearTimeout(wakeTimer);
    endSearches();
    away = null;
    parking = wantBack = wantRescan = false;
    lostLater = [];
    if (watcher) { const w = watcher; watcher = null; w.terminate(); }
    if (engine) {
      const w = engine;
      engine = null;
      let ended = false;
      const end = () => { if (!ended) { ended = true; w.terminate(); } };
      w.on('message', (m) => { if (m.type === 'saved') end(); });
      setTimeout(end, 3000);
      w.postMessage({ type: 'save' });
    }
    if (registered) { shortcuts.unregister(registered); registered = null; }
    shown = false;
    if (win && !win.isDestroyed()) win.destroy();
    win = null;
    last = [];
  }

  return {
    start,
    stop,
    open: show,
    actions: () => [
      { id: 'open', label: 'find files', key: 'key', run: show },
      { id: 'rescan', label: 'rescan drives', run: rescan },
      { id: 'clear', label: 'clear recent', run: clearRecent },
    ],
    keys: () => [{ id: 'key', label: 'find files', combo: settings.key, ok: registered !== null || keyPaused }],
    setKey,
    ramSaver: setRamSaver,
  };
};
