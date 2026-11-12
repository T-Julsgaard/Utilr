'use strict';

// findr's watch thread, with utilr's RAM saver on: the part of findr that's
// always on, and small. (With it off, the index thread watches the drives
// itself and this thread isn't started.) It holds the watches on the fixed drives (one recursive watch per drive, what
// Windows calls ReadDirectoryChangesW) and passes on which folders changed.
//
// While the index thread (worker.js) is up, changes go straight to it over a
// port. While it's put away (findr unused for a while), they're kept here, a
// set of folder paths per root, and handed over when it's back. That's how
// the index can be closed without missing anything.
//
// Messages in (from main):  roots, attach (with or without a new port), detach, requeue
// Messages out (to main):   lost (while the index is away), log
// On the port (to index):   dirty, lost, park (the last thing sent before it goes)

const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const { ignoredChange } = require('./walk');
const T = require('./timing');

const P = path.win32;
const key = (p) => String(p).toLowerCase().replace(/\//g, '\\').replace(/\\+$/, '');
const cacheKey = key(workerData.cacheDir);
const FLUSH = 100; // changes go to the index in batches, this long after the first

const roots = new Map(); // root key -> { root, watchOn, watcher, kept: Set, pending: Set }
let port = null;         // to the index thread
let live = false;        // the index is up and listening
let flushTimer = null;

const log = (msg) => parentPort.postMessage({ type: 'log', msg });

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
    });
  } catch (err) {
    log(`can't watch ${s.root}: ${err.message}`);
  }
}

function onEvent(s, name) {
  if (!name) { lost(s, 'windows lost track of changes'); return; } // too much at once
  const rel = String(name);
  if (ignoredChange(rel, s.noWindows)) return;
  const full = P.join(s.root, rel);
  if (cacheKey && key(full).startsWith(cacheKey)) return; // findr's own cache
  const dir = P.dirname(full);
  if (live) {
    s.pending.add(dir);
    if (!flushTimer) flushTimer = setTimeout(flush, FLUSH);
    return;
  }
  keep(s, [dir]);
}

// while the index is away
function keep(s, dirs) {
  for (const d of dirs) s.kept.add(d);
  if (s.kept.size > T.MAX_DIRTY) lost(s, 'too many changes at once');
}

function lost(s, why) {
  if (live) {
    flush(); // what came before it, first
    port.postMessage({ type: 'lost', root: s.root, why });
    return;
  }
  s.kept.clear(); // it's all read again anyway
  parentPort.postMessage({ type: 'lost', root: s.root, why });
}

function flush() {
  clearTimeout(flushTimer);
  flushTimer = null;
  if (!live) return;
  for (const s of roots.values()) {
    if (!s.pending.size) continue;
    port.postMessage({ type: 'dirty', root: s.root, dirs: [...s.pending] });
    s.pending.clear();
  }
}

function configure(list) {
  const want = new Map(list.map((r) => [key(r.root), r]));
  for (const [k, s] of roots) {
    if (want.has(k)) continue;
    unwatch(s);
    roots.delete(k);
  }
  for (const [k, r] of want) {
    let s = roots.get(k);
    if (!s) {
      s = { root: r.root, watchOn: !!r.watch, noWindows: !!r.noWindows, watcher: null, kept: new Set(), pending: new Set() };
      roots.set(k, s);
      watch(s);
    } else {
      s.noWindows = !!r.noWindows;
      if (s.watchOn !== !!r.watch) { s.watchOn = !!r.watch; watch(s); }
    }
  }
}

// The index is up: what changed while it was away, then everything as it comes.
function attach(p) {
  if (p) port = p;
  if (!port) return;
  live = true;
  for (const s of roots.values()) {
    if (!s.kept.size) continue;
    port.postMessage({ type: 'dirty', root: s.root, dirs: [...s.kept] });
    s.kept.clear();
  }
}

// The index is going away. 'park' goes on the same port as the changes, so the
// index has all of them by the time it hears it. From here on they're kept.
function detach() {
  if (!live) return;
  flush();
  live = false;
  port.postMessage({ type: 'park' });
}

parentPort.on('message', (m) => {
  try {
    if (m.type === 'roots') configure(m.roots || []);
    else if (m.type === 'attach') attach(m.port);
    else if (m.type === 'detach') detach();
    else if (m.type === 'requeue') {
      // what the index hadn't looked at yet when it went
      for (const r of m.roots || []) {
        const s = roots.get(key(r.root));
        if (!s) continue;
        if (live) { for (const d of r.dirs) s.pending.add(d); if (!flushTimer) flushTimer = setTimeout(flush, FLUSH); }
        else keep(s, r.dirs);
      }
    }
  } catch (err) {
    log(`watch: ${err && err.stack || err}`);
  }
});
