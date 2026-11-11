'use strict';

// findr's engine thread. It owns the index, so the main process never holds
// a million names and never blocks on a search.
//
//   roots     each drive (or folder) findr covers: its index, a scan thread
//             while it's being read, a watcher, and its cache file
//   scans     a root without a cache is read at once; one with a cache is
//             searchable straight from it and read again a little later (to
//             catch what changed while utilr was off), then every 6 hours
//   watching  fixed drives are watched (one recursive watch per drive, what
//             Windows calls ReadDirectoryChangesW). A change marks its folder;
//             a moment later the folder is read again and the index fixed.
//             USB drives aren't watched (a watch would stop you ejecting them)
//
// Messages in:  config, search, rescan, touch, recent
// Messages out: results, status, log

const { parentPort, workerData, Worker } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const v8 = require('v8');
const E = require('./engine');
const { SKIP } = require('./walk');

const P = path.win32;
const { cacheDir, srcs, boot } = workerData;
const cacheKey = E.key(cacheDir);

const RESCAN_EVERY = 6 * 60 * 60 * 1000;
const FRESH = 10 * 60 * 1000;      // a cache younger than this isn't read again at once
const AFTER_CACHE = 20 * 1000;     // otherwise: a fresh scan this long after start
const SAVE_AFTER = 10 * 60 * 1000; // live changes are saved this long after the first (and when findr
                                   // stops): busy folders change all the time, the cache is tens of MB
const TICK = 700;                  // changes are looked at in batches, this long after the first
const MAX_DIRTY = 20000;           // more changed folders than this at once: read it all again
const QUIET_AFTER = 2 * 60 * 1000; // Windows losing track during or just after a scan is the scan itself
const LOST_EVERY = 15 * 60 * 1000; // read again for that at most this often

const roots = new Map(); // root key -> state
let home = '';
let recent = new Set();
let statusTimer = null;

const post = (m) => parentPort.postMessage(m);
const log = (msg) => post({ type: 'log', msg });
const mb = (b) => `${Math.round(b / 1048576)} MB`;

function cacheFile(root) {
  const k = E.key(root);
  const id = /^[a-z]:$/.test(k) ? k[0] : 'f-' + crypto.createHash('sha1').update(k).digest('hex').slice(0, 12);
  return P.join(cacheDir, `index-${id}.bin`);
}

function status() {
  if (statusTimer) return;
  statusTimer = setTimeout(() => {
    statusTimer = null;
    post({
      type: 'status',
      roots: [...roots.values()].map((s) => ({
        root: s.root, count: s.v.live, scanning: !!s.scan, found: s.found, at: s.v.scannedAt, watching: !!s.watcher,
      })),
    });
  }, 150);
}

// ---------------------------------------------------------------------------
// scanning
// ---------------------------------------------------------------------------

// why: what the log says this scan is for
function scan(s, why = 'scheduled') {
  if (s.scan) return;
  clearTimeout(s.rescanTimer);
  s.rescanAt = 0;
  // Nothing yet: the scan fills the live index, searchable as it grows.
  // Otherwise it fills a new one, swapped in when it's done.
  const fresh = s.v.next <= 1;
  const v = fresh ? s.v : new E.Volume(s.root);
  v.start();
  s.target = v;
  s.found = 1;
  s.during = new Set();
  const t0 = Date.now();
  let w;
  try {
    // A walk makes millions of short-lived objects but keeps few: a small
    // young generation keeps it from growing a big heap that outlives it.
    w = new Worker(boot, {
      eval: true,
      workerData: { entry: './scan', srcs, root: s.root },
      resourceLimits: { maxYoungGenerationSizeMb: 4, maxOldGenerationSizeMb: 512 },
    });
  } catch (err) {
    log(`can't scan ${s.root}: ${err.message}`);
    return;
  }
  s.scan = w;
  w.on('message', (m) => {
    if (s.scan !== w) return;
    if (m.type === 'batch') {
      v.add(m);
      s.found = v.next;
      status();
    } else if (m.type === 'done') {
      s.scan = null;
      s.target = null;
      v.scannedAt = Date.now();
      s.v = v;
      for (const d of s.during) s.dirty.add(d);
      s.during = null;
      if (s.dirty.size) tickSoon(s);
      log(`scanned ${s.root} (${why}): ${m.files} files and ${m.dirs} folders in ${((Date.now() - t0) / 1000).toFixed(1)} s` +
        (m.denied ? ` (${m.denied} folders not readable)` : '') + `, heap ${mb(v8.getHeapStatistics().used_heap_size)}`);
      saveNow(s);
      w.terminate();
      status();
      s.rescanTimer = setTimeout(() => scan(s, 'every 6 hours'), RESCAN_EVERY);
    }
  });
  w.on('error', (err) => {
    if (s.scan !== w) return;
    s.scan = null;
    s.target = null;
    log(`scan of ${s.root} failed: ${err.message}`);
    status();
  });
  w.on('exit', () => {
    if (s.scan !== w) return;
    s.scan = null;
    s.target = null;
    status();
  });
  status();
}

function saveNow(s) {
  clearTimeout(s.saveTimer);
  s.saveTimer = null;
  if (s.scan && s.target === s.v) return; // half read: the last full copy stays
  try {
    E.save(s.v, cacheFile(s.root));
  } catch (err) {
    log(`can't save the index of ${s.root}: ${err.message}`);
  }
}
function saveLater(s) {
  if (!s.saveTimer) s.saveTimer = setTimeout(() => saveNow(s), SAVE_AFTER);
}

// ---------------------------------------------------------------------------
// watching
// ---------------------------------------------------------------------------

function unwatch(s) {
  if (s.watcher) { try { s.watcher.close(); } catch (_) {} }
  s.watcher = null;
}

function watch(s) {
  unwatch(s);
  if (!s.watchOn) return;
  try {
    // 'rename' is a name appearing or going (new, deleted, renamed, moved);
    // 'change' is only an edit, which doesn't change any name.
    s.watcher = fs.watch(s.root, { recursive: true }, (ev, name) => {
      if (ev === 'rename' || !name) onEvent(s, name);
    });
    s.watcher.on('error', (err) => {
      log(`stopped watching ${s.root}: ${err.message}`);
      unwatch(s);
      status();
    });
  } catch (err) {
    log(`can't watch ${s.root}: ${err.message}`);
  }
}

function onEvent(s, name) {
  if (!name) { // Windows lost track: too much at once
    // A scan reads every folder, and with last-access times on (the Windows
    // default on many machines) that alone can be too much: not a reason to
    // read it all again.
    if (s.scan || Date.now() - s.v.scannedAt < QUIET_AFTER) return;
    rescanSoon(s, 'windows lost track of changes');
    return;
  }
  const rel = String(name);
  for (const part of rel.toLowerCase().split('\\')) if (SKIP.has(part)) return;
  const full = P.join(s.root, rel);
  if (cacheKey && E.key(full).startsWith(cacheKey)) return; // findr's own cache
  const dir = P.dirname(full);
  s.dirty.add(dir);
  if (s.during) s.during.add(dir);
  if (s.dirty.size > MAX_DIRTY) { s.dirty.clear(); rescanSoon(s, 'too many changes at once'); return; }
  tickSoon(s);
}

// a minute from now, but not sooner than LOST_EVERY after the last scan
function rescanSoon(s, why) {
  if (s.scan || s.rescanAt) return; // one's on its way
  s.rescanAt = Math.max(Date.now() + 60 * 1000, s.v.scannedAt + LOST_EVERY);
  clearTimeout(s.rescanTimer);
  s.rescanTimer = setTimeout(() => scan(s, why), s.rescanAt - Date.now());
}

function tickSoon(s) {
  if (!s.tick) s.tick = setTimeout(() => tick(s), TICK);
}

function tick(s) {
  s.tick = null;
  if (s.scan && s.target === s.v) return; // after the scan (it keeps the list)
  const t0 = Date.now();
  let added = 0, removed = 0, n = 0;
  for (const d of s.dirty) {
    s.dirty.delete(d);
    const r = E.refreshDir(s.v, d);
    if (r === 'up') {
      // not known yet (new, or inside something new): look one level up
      const up = P.dirname(d);
      const k = E.key(up);
      if (up !== d && (k === s.v.rootKey || k.startsWith(s.v.rootKey + '\\'))) s.dirty.add(up);
    } else if (r) {
      added += r.added;
      removed += r.removed;
    }
    if (++n >= 400 || Date.now() - t0 > 300) break;
  }
  if (added || removed) {
    s.v.tidy();
    saveLater(s);
    status();
  }
  if (s.dirty.size) tickSoon(s);
}

// ---------------------------------------------------------------------------
// roots
// ---------------------------------------------------------------------------

function drop(s) {
  unwatch(s);
  if (s.scan) { try { s.scan.terminate(); } catch (_) {} }
  s.scan = null;
  for (const t of ['tick', 'saveTimer', 'rescanTimer']) clearTimeout(s[t]);
}

function configure(m) {
  if (m.home) home = E.key(m.home);
  const want = new Map((m.roots || []).map((r) => [E.key(r.root), r]));
  for (const [k, s] of roots) {
    if (want.has(k)) continue;
    drop(s);
    roots.delete(k);
    try { fs.unlinkSync(cacheFile(s.root)); } catch (_) {} // off means not indexed, on disk too
    log(`${s.root} left out`);
  }
  for (const [k, r] of want) {
    let s = roots.get(k);
    if (s) {
      if (s.watchOn !== !!r.watch) { s.watchOn = !!r.watch; watch(s); }
      continue;
    }
    s = {
      root: r.root, watchOn: !!r.watch, v: new E.Volume(r.root), scan: null, target: null, found: 0,
      watcher: null, dirty: new Set(), during: null, tick: null, saveTimer: null, rescanTimer: null, rescanAt: 0,
    };
    roots.set(k, s);
    const t0 = Date.now();
    if (E.load(s.v, cacheFile(r.root))) {
      const age = Date.now() - s.v.scannedAt;
      log(`${r.root}: ${s.v.live} entries from the cache in ${Date.now() - t0} ms (${Math.round(age / 60000)} min old)`);
      s.rescanTimer = setTimeout(() => scan(s, 'catching up after a start'), age < FRESH ? FRESH : AFTER_CACHE);
    } else {
      scan(s, 'first time');
    }
    watch(s);
  }
  status();
}

function search(m) {
  const t0 = process.hrtime.bigint();
  const vols = [...roots.values()]
    .sort((a, b) => a.root.localeCompare(b.root))
    .map((s) => s.v)
    .filter((v) => v.segs.length);
  const r = E.search(vols, m.q, { limit: m.limit || 100, recent, home });
  post({ type: 'results', seq: m.seq, ...r, ms: Number(process.hrtime.bigint() - t0) / 1e6 });
}

function touch(p) {
  const k = E.key(p);
  for (const s of roots.values()) {
    if (k === s.v.rootKey || k.startsWith(s.v.rootKey + '\\')) {
      s.dirty.add(P.dirname(p));
      tickSoon(s);
    }
  }
}

parentPort.on('message', (m) => {
  try {
    if (m.type === 'config') configure(m);
    else if (m.type === 'search') search(m);
    else if (m.type === 'rescan') { for (const s of roots.values()) scan(s, 'asked for'); }
    else if (m.type === 'touch') touch(m.path);
    else if (m.type === 'recent') recent = new Set((m.recent || []).map(E.key));
    else if (m.type === 'save') { for (const s of roots.values()) if (s.saveTimer) saveNow(s); post({ type: 'saved' }); }
  } catch (err) {
    log(`engine: ${err && err.stack || err}`);
    if (m && m.type === 'search') post({ type: 'results', seq: m.seq, total: 0, items: [], ms: 0 });
  }
});
