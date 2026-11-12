'use strict';

// Walking a folder tree into findr's flat list.
//
// Every file and folder is one entry: its name, the id of the folder it's in,
// a few flag bits and how deep it is. Ids are handed out in the order entries
// are found, and a folder is always found before what's in it, so a parent's
// id is always smaller than its children's. The engine leans on that.
//
// Plain readdir with file types: one call per folder, no stat per file, so a
// million files take seconds on an SSD (about a minute on a spinning disk).

const fs = require('fs');
const path = require('path');

const F_DIR = 1;     // a folder
const F_DEAD = 2;    // gone (deleted, renamed away); skipped until the next scan
const F_NOISY = 4;   // inside AppData, node_modules, .git, Windows, …: ranked lower
const F_HIDDEN = 8;  // the name starts with . or $: ranked a little lower

// Never walked: the recycle bin, restore points, Windows' component store
// (WinSxS alone is ~100k files nobody looks for) and setup leftovers.
const SKIP = new Set([
  '$recycle.bin', 'system volume information', '$winreagent', 'config.msi', 'winsxs',
  '$windows.~bt', '$windows.~ws', '$sysreset', '$getcurrent', 'recovery',
]);

// Folders whose insides are mostly machine-made. Still found, just lower.
const NOISY = new Set([
  'appdata', 'node_modules', '.git', '.svn', '.hg', 'temp', 'tmp', 'cache', 'caches', '.cache',
  '__pycache__', '.npm', '.nuget', '.gradle', '.m2', '.cargo', '.rustup', 'site-packages',
  'bower_components', '.vs', '.idea', 'obj', '$windows.~ws',
]);
// only noisy right under a drive's root
const NOISY_TOP = new Set(['windows', 'programdata', 'program files (x86)', 'msocache', 'perflogs', 'intel', 'amd', 'nvidia']);

const MAX_DEPTH = 255;

// A drive's own Windows folder (C:\Windows, or an old install's G:\Windows):
// with findr's "windows folders" setting off (the default), it's listed but
// not walked. Hundreds of thousands of system files nobody looks for.
const WINDOWS = 'windows';
const skipInside = (lower, depth, noWindows) => noWindows && depth === 1 && lower === WINDOWS;

// A change (a path below a root) that findr doesn't look at: it's in a
// folder findr never walks.
function ignoredChange(rel, noWindows) {
  const parts = String(rel).toLowerCase().split(/[\\/]/);
  if (noWindows && parts.length > 1 && parts[0] === WINDOWS) return true;
  return parts.some((p) => SKIP.has(p));
}

function flagsFor(name, lower, isDir, parentNoisy, depth) {
  let f = isDir ? F_DIR : 0;
  if (parentNoisy || (isDir && (NOISY.has(lower) || (depth === 1 && NOISY_TOP.has(lower))))) f |= F_NOISY;
  const c = name.charCodeAt(0);
  if (c === 46 /* . */ || c === 36 /* $ */) f |= F_HIDDEN;
  return f;
}

// A folder you can't skip into: a junction or a symlink. Listed, never entered
// (that's how "Documents and Settings" doesn't index C:\Users twice).
const isRealDir = (ent) => ent.isDirectory() && !ent.isSymbolicLink();

// A batch of new entries, filled by walk() and handed out every `size` entries.
class Batch {
  constructor() { this.names = []; this.parent = []; this.flags = []; this.depth = []; }
  get length() { return this.names.length; }
  push(name, parent, flags, depth) {
    this.names.push(name);
    this.parent.push(parent);
    this.flags.push(flags);
    this.depth.push(Math.min(depth, MAX_DEPTH));
  }
  // packed for the engine (and for posting between threads): the names as one
  // string, "\nname\nname\n", and typed arrays for the rest
  pack() {
    return {
      raw: '\n' + this.names.join('\n') + '\n',
      parent: Int32Array.from(this.parent),
      flags: Uint8Array.from(this.flags),
      depth: Uint8Array.from(this.depth),
    };
  }
}

// Walk everything below `dir` (not `dir` itself), whose id is `dirId`.
// New entries get ids from `nextId` up. `onBatch(packed)` is called every
// `size` entries and once at the end. noWindows: `dir` is (in) a drive whose
// Windows folder isn't walked. Returns { next, denied, dirs, files }.
function walk(dir, { dirId, nextId, depth = 0, noisy = false, noWindows = false, size = 25000, onBatch, shouldStop }) {
  let next = nextId, denied = 0, dirs = 0, files = 0;
  let batch = new Batch();
  const flush = () => {
    if (!batch.length) return;
    onBatch(batch.pack());
    batch = new Batch();
  };
  const stack = [{ p: dir, id: dirId, depth, noisy }];
  while (stack.length) {
    if (shouldStop && shouldStop()) break;
    const d = stack.pop();
    let ents;
    try { ents = fs.readdirSync(d.p, { withFileTypes: true }); } catch (_) { denied++; continue; }
    const cd = d.depth + 1;
    for (const ent of ents) {
      const name = ent.name;
      const lower = name.toLowerCase();
      const isDir = isRealDir(ent);
      if (isDir && SKIP.has(lower)) continue;
      const f = flagsFor(name, lower, isDir, d.noisy, cd);
      const id = next++;
      batch.push(name, d.id, f, cd);
      if (isDir) {
        dirs++;
        if (cd < MAX_DEPTH && !skipInside(lower, cd, noWindows)) stack.push({ p: path.join(d.p, name), id, depth: cd, noisy: (f & F_NOISY) !== 0 });
      } else {
        files++;
      }
      if (batch.length >= size) flush();
    }
  }
  flush();
  return { next, denied, dirs, files };
}

// The name a root is listed under: "C:" for a drive (its path is then "C:\"),
// the whole path for a folder.
function rootName(root) {
  const r = root.replace(/[\\/]+$/, '');
  return r || root;
}

module.exports = { walk, Batch, flagsFor, isRealDir, rootName, skipInside, ignoredChange, SKIP, F_DIR, F_DEAD, F_NOISY, F_HIDDEN };
