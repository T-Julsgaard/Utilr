'use strict';

// findr's index thread. It owns the index, so the main process never holds
// a million names and never blocks on a search.
//
//   roots     each drive (or folder) findr covers: its index, a scan thread
//             while it's being read, and its cache file
//   scans     a root without a cache is read at once; one with a cache is
//             searchable straight from it and read again a little later (to
//             catch what changed while utilr was off), then every 6 hours
//   changes   the watch thread (watch.js) says which folders changed, over a
//             port; a moment later each is read again and the index fixed
//   away      when findr isn't used for a while, main puts this thread away to
//             give its memory back: it saves what changed, hands back the
//             folders it hadn't looked at yet, and is ended. The next one
//             loads the cache and carries on where this one stopped
//
// Messages in:  config, port, lost, search, rescan, touch, recent, save
// On the port:  dirty, lost, park (from the watch thread)
// Messages out: results, status, log, saved, parked, busy

const { parentPort, workerData, Worker } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const v8 = require('v8');
const E = require('./engine');
const { RESCAN_EVERY, FRESH, AFTER_CACHE, MAX_DIRTY, QUIET_AFTER, LOST_EVERY, LOST_WAIT } = require('./timing');

const P = path.win32;
const { cacheDir, srcs, boot } = workerData;

const SAVE_AFTER = 10 * 60 * 1000; // live changes are saved this long after the first (and when findr
                                   // stops, or this thread is put away): busy folders change all the
                                   // time, the cache is tens of MB
const TICK = 700;                  // changes are looked at in batches, this long after the first

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
        root: s.root, count: s.v.live, scanning: !!s.scan, found: s.found, at: s.v.scannedAt, due: s.dueAt,
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
  s.dueAt = 0;
  s.dueWhy = '';
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
      scanAt(s, Date.now() + RESCAN_EVERY, 'every 6 hours');
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

// The next scan of a root: when, and what for. Kept, so it can be handed on
// when this thread is put away.
function scanAt(s, at, why) {
  clearTimeout(s.rescanTimer);
  s.dueAt = at;
  s.dueWhy = why;
  s.rescanTimer = setTimeout(() => scan(s, why), Math.max(0, at - Date.now()));
  status();
}

// false: it couldn't be written
function saveNow(s) {
  clearTimeout(s.saveTimer);
  s.saveTimer = null;
  if (s.scan && s.target === s.v) return true; // half read: the last full copy stays
  try {
    E.save(s.v, cacheFile(s.root));
    return true;
  } catch (err) {
    log(`can't save the index of ${s.root}: ${err.message}`);
    return false;
  }
}
function saveLater(s) {
  if (!s.saveTimer) s.saveTimer = setTimeout(() => saveNow(s), SAVE_AFTER);
}

// ---------------------------------------------------------------------------
// changes (from the watch thread)
// ---------------------------------------------------------------------------

function onDirty(s, dirs) {
  for (const d of dirs) {
    s.dirty.add(d);
    if (s.during) s.during.add(d);
  }
  if (s.dirty.size > MAX_DIRTY) { s.dirty.clear(); rescanSoon(s, 'too many changes at once'); return; }
  tickSoon(s);
}

function onLost(s, why) {
  // A scan reads every folder, and with last-access times on (the Windows
  // default on many machines) that alone can be too much: not a reason to
  // read it all again.
  if (s.scan || Date.now() - s.v.scannedAt < QUIET_AFTER) return;
  rescanSoon(s, why);
}

// a minute from now, but not sooner than LOST_EVERY after the last scan
function rescanSoon(s, why) {
  if (s.scan || s.rescanAt) return; // one's on its way
  s.rescanAt = Math.max(Date.now() + LOST_WAIT, s.v.scannedAt + LOST_EVERY);
  scanAt(s, s.rescanAt, why);
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
  if (s.scan) { try { s.scan.terminate(); } catch (_) {} }
  s.scan = null;
  for (const t of ['tick', 'saveTimer', 'rescanTimer']) clearTimeout(s[t]);
}

// Roots: each { root, resume }. resume is there when this thread takes over
// from one that was put away: the watch thread kept every change since, so
// nothing has to be read again, and the next scan is when that one had it
// ({ at, why, lost }; no at: 6 hours after the last).
function configure(m) {
  if (m.home) home = E.key(m.home);
  const want = new Map((m.roots || []).map((r) => [E.key(r.root), r]));
  for (const [k, s] of roots) {
    if (want.has(k)) continue;
    drop(s);
    roots.delete(k);
    log(`${s.root} left out`);
  }
  prune(want);
  for (const [k, r] of want) {
    if (roots.has(k)) continue;
    const s = {
      root: r.root, v: new E.Volume(r.root), scan: null, target: null, found: 0, dirty: new Set(), during: null,
      tick: null, saveTimer: null, rescanTimer: null, rescanAt: 0, dueAt: 0, dueWhy: '',
    };
    roots.set(k, s);
    const t0 = Date.now();
    if (!E.load(s.v, cacheFile(r.root))) { scan(s, 'first time'); continue; }
    const age = Date.now() - s.v.scannedAt;
    log(`${r.root}: ${s.v.live} entries from the cache in ${Date.now() - t0} ms (${Math.round(age / 60000)} min old)`);
    const re = r.resume;
    if (re && re.at) {
      if (re.lost) s.rescanAt = re.at;
      scanAt(s, re.at, re.why || 'every 6 hours');
    } else if (re) {
      scanAt(s, s.v.scannedAt + RESCAN_EVERY, 'every 6 hours');
    } else {
      scanAt(s, Date.now() + (age < FRESH ? FRESH : AFTER_CACHE), 'catching up after a start');
    }
  }
  status();
}

// Off means not indexed, on disk too: the cache of a root that isn't covered
// any more goes (one left over from while the index was away, too).
function prune(want) {
  const keep = new Set([...want.values()].map((r) => P.basename(cacheFile(r.root)).toLowerCase()));
  let files = [];
  try { files = fs.readdirSync(cacheDir); } catch (_) { return; }
  for (const f of files) {
    if (!/^index-.+\.bin$/i.test(f) || keep.has(f.toLowerCase())) continue;
    try { fs.unlinkSync(P.join(cacheDir, f)); } catch (_) {}
  }
}

// Put away. Main asks through the watch thread, so every change it sent is
// here by now. Not while a scan runs, or when a cache can't be written: then
// "busy", and this thread stays.
function park() {
  if ([...roots.values()].some((s) => s.scan)) { post({ type: 'busy', why: 'a scan is running' }); return; }
  for (const s of roots.values()) {
    if (s.saveTimer && !saveNow(s)) { post({ type: 'busy', why: "the index can't be saved" }); return; }
  }
  const out = [];
  for (const s of roots.values()) {
    clearTimeout(s.tick);
    clearTimeout(s.rescanTimer);
    s.tick = s.rescanTimer = null;
    out.push({ root: s.root, at: s.dueAt, why: s.dueWhy, lost: !!s.rescanAt, dirs: [...s.dirty] });
  }
  post({ type: 'parked', roots: out, heap: mb(v8.getHeapStatistics().used_heap_size) });
}

function onPort(m) {
  if (m.type === 'park') { park(); return; }
  const s = roots.get(E.key(m.root));
  if (!s) return;
  if (m.type === 'dirty') onDirty(s, m.dirs || []);
  else if (m.type === 'lost') onLost(s, m.why);
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

const guard = (fn) => (m) => {
  try {
    fn(m);
  } catch (err) {
    log(`engine: ${err && err.stack || err}`);
    if (m && m.type === 'search') post({ type: 'results', seq: m.seq, total: 0, items: [], ms: 0 });
  }
};

parentPort.on('message', guard((m) => {
  if (m.type === 'config') configure(m);
  else if (m.type === 'port') m.port.on('message', guard(onPort));
  else if (m.type === 'lost') onPort(m); // Windows lost track while this thread was being asked to go
  else if (m.type === 'search') search(m);
  else if (m.type === 'rescan') { for (const s of roots.values()) scan(s, 'asked for'); }
  else if (m.type === 'touch') touch(m.path);
  else if (m.type === 'recent') recent = new Set((m.recent || []).map(E.key));
  else if (m.type === 'save') { for (const s of roots.values()) if (s.saveTimer) saveNow(s); post({ type: 'saved' }); }
}));
