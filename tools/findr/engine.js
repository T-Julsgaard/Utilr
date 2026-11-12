'use strict';

// findr's index: every file and folder on a root (a drive, or a folder), held
// in memory as compactly as plain JavaScript allows, and searched by name.
//
// A root's entries live in segments. A segment is up to ~50,000 entries with
// their names in ONE string, "\nname\nname\n…\n", and typed arrays for the
// rest (parent id, flags, depth). Searching is a case-insensitive RegExp over
// that string, which V8 runs at memory speed (as fast as indexOf on a
// lowercase copy, without the copy), so a million names take a few
// milliseconds. Matches map back to entries through the offsets in `starts`.
//
// Segments stay small on purpose: V8 stores a string with one character
// outside Latin-1 at two bytes per character, so one odd name only widens
// its own segment.
//
// Ids: a root's entries are numbered in the order they were found (see
// walk.js), so a parent always has a smaller id than its children. Segments
// cover consecutive id ranges. Gone entries are flagged dead, not removed;
// the next full scan starts clean.

const fs = require('fs');
const path = require('path');
const { walk, Batch, flagsFor, isRealDir, rootName, skipInside, SKIP, F_DIR, F_DEAD, F_NOISY, F_HIDDEN } = require('./walk');

const P = path.win32;

// a path as a lookup key: lowercase, no trailing separator ("c:" for C:\)
const key = (p) => String(p).toLowerCase().replace(/\//g, '\\').replace(/\\+$/, '');

// offsets just past each "\n": starts[k] is where name k begins, and
// starts[k + 1] - 1 is where it ends (starts[n] is the string's length)
function startsOf(s, n) {
  const starts = new Uint32Array(n + 1);
  let k = 0;
  for (let i = s.indexOf('\n'); i !== -1 && k <= n; i = s.indexOf('\n', i + 1)) starts[k++] = i + 1;
  return starts;
}

// the largest k in [lo, hi] with a[k] <= x
function floorIndex(a, x, lo, hi) {
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (a[mid] <= x) lo = mid; else hi = mid - 1;
  }
  return lo;
}

const SEG = 50000; // entries per segment, at most (from the cache; scans post 25,000)

class Segment {
  constructor(base, { raw, parent, flags, depth }) {
    this.base = base;
    this.n = parent.length;
    this.raw = raw;
    this.starts = startsOf(raw, this.n);
    this.parent = parent;
    this.flags = flags;
    this.depth = depth;
  }
  name(i) { return this.raw.slice(this.starts[i], this.starts[i + 1] - 1); }
}

const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Glue small segments into one (ids stay as they are: they're consecutive).
function merge(segs) {
  let raw = segs[0].raw;
  for (let i = 1; i < segs.length; i++) raw += segs[i].raw.slice(1);
  const n = segs.reduce((s, x) => s + x.n, 0);
  const parent = new Int32Array(n), flags = new Uint8Array(n), depth = new Uint8Array(n);
  let o = 0;
  for (const s of segs) { parent.set(s.parent, o); flags.set(s.flags, o); depth.set(s.depth, o); o += s.n; }
  return new Segment(segs[0].base, { raw, parent, flags, depth });
}

class Volume {
  constructor(root) {
    this.root = root;
    this.rootKey = key(root);
    this.isDrive = /^[a-z]:$/.test(this.rootKey);
    this.noWindows = false; // a drive whose Windows folder isn't walked (see walk.js)
    this.reset();
  }

  reset() {
    this.segs = [];
    this.next = 0;          // the next id
    this.live = 0;          // entries that aren't dead
    this.dirIds = new Map(); // folder path key -> id, for live updates
    this.kids = new Map();   // folder id -> its children's ids, for folders that change
    this.scannedAt = 0;
  }

  // a fresh index: just the root itself, id 0
  start() {
    this.reset();
    const b = new Batch();
    b.push(rootName(this.root), -1, F_DIR, 0);
    this.add(b.pack());
  }

  add(packed) {
    if (!packed.parent.length) return null;
    const s = new Segment(this.next, packed);
    this.segs.push(s);
    this.next += s.n;
    this.live += s.n;
    return s;
  }

  seg(id) {
    const a = this.segs;
    let lo = 0, hi = a.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (a[mid].base <= id) lo = mid; else hi = mid - 1;
    }
    return a[lo];
  }
  flagsOf(id) { const s = this.seg(id); return s.flags[id - s.base]; }
  depthOf(id) { const s = this.seg(id); return s.depth[id - s.base]; }
  parentOf(id) { const s = this.seg(id); return s.parent[id - s.base]; }
  nameOf(id) { const s = this.seg(id); return s.name(id - s.base); }

  pathOf(id) {
    const parts = [];
    for (let guard = 0; id >= 0 && guard < 300; guard++) {
      const s = this.seg(id), i = id - s.base;
      parts.push(s.name(i));
      id = s.parent[i];
    }
    parts.reverse();
    const p = parts.join('\\');
    return parts.length === 1 && this.isDrive ? p + '\\' : p;
  }

  // Small segments from live updates pile up; past a handful, glue them.
  tidy() {
    const small = this.segs.filter((s) => s.n < 20000);
    if (small.length < 24) return;
    const out = [];
    let run = [];
    const flush = () => { if (run.length > 1) out.push(merge(run)); else out.push(...run); run = []; };
    for (const s of this.segs) {
      if (s.n < 20000) run.push(s);
      else { flush(); out.push(s); }
    }
    flush();
    this.segs = out;
  }
}

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

// "invoice 2026" -> every name with both. Rules, the same as most file finders:
//   words        all of them, anywhere in the name, in any order
//   "a phrase"   kept together, spaces and all
//   * ?          wildcards: the whole name must fit ("*.pdf", "img_????.jpg")
//   \ or /       a word with a separator is looked for in the whole path
//                ("docs\invoice", "projects\")
function parse(q) {
  const terms = [];
  const re = /"([^"]*)"?|(\S+)/g;
  let m;
  while ((m = re.exec(String(q || '')))) {
    const t = (m[1] !== undefined ? m[1] : m[2]).toLowerCase().replace(/\//g, '\\');
    if (!t.trim()) continue;
    const glob = /[*?]/.test(t);
    const isPath = t.includes('\\');
    const lits = glob ? t.split(/[*?]+/).filter(Boolean) : [t];
    let rx = null;
    if (glob) {
      const body = t.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
      rx = new RegExp((isPath ? '' : '^') + body + '$');
    }
    terms.push({ t, glob, isPath, lits, rx });
  }
  return terms;
}

// The word indexOf looks for: the longest plain piece of a name word, or the
// last piece of a path word ("docs\inv" -> "inv"; "projects\" -> "projects").
function driver(terms) {
  let best = '';
  for (const t of terms) if (!t.isPath) for (const l of t.lits) if (l.length > best.length) best = l;
  if (best) return best;
  for (const t of terms) {
    for (const l of t.lits) {
      const parts = l.split('\\').filter(Boolean);
      const last = l.endsWith('\\') ? parts[parts.length - 1] : parts[parts.length - 1];
      if (last && last.length > best.length) best = last;
    }
  }
  return best;
}

const isWord = (c) => (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c > 127;

// How good a match is, from the name alone (cheap: runs on every match).
function rank(lower, flags, depth, q) {
  let s = 0;
  if (q.whole) {
    if (lower === q.whole) s += 1000;
    else {
      const dot = lower.lastIndexOf('.');
      if (dot > 0 && lower.slice(0, dot) === q.whole) s += 900;
      else if (lower.startsWith(q.first)) s += 400;
      else {
        const i = lower.indexOf(q.first);
        if (i > 0 && !isWord(lower.charCodeAt(i - 1))) s += 200;
      }
    }
  }
  if (flags & F_NOISY) s -= 800; // more than an exact name: node_modules\x\invoice.js under Invoice-2026.pdf
  if (flags & F_HIDDEN) s -= 120;
  if (flags & F_DIR) s += 10;
  s -= depth * 6;
  s -= Math.min(lower.length, 80);
  return s;
}

// vols: [Volume]. opts: { limit, recent: Set of path keys, home: path key }.
// Returns { total, items: [{ path, name, dir, isDir }] }, best first.
function search(vols, q, { limit = 100, recent = null, home = '' } = {}) {
  const terms = parse(q);
  const drive = driver(terms);
  if (!drive) return { total: 0, items: [] };
  const plain = terms.filter((t) => !t.glob && !t.isPath).map((t) => t.t);
  const ctx = { whole: plain.join(' '), first: plain[0] || '' };
  const nameTerms = terms.filter((t) => !t.isPath);
  const pathTerms = terms.filter((t) => t.isPath);

  const KEEP = Math.max(limit * 2, 200);
  const rx = new RegExp(escapeRx(drive), 'gi');
  let cand = [];
  let floor = -Infinity;
  let total = 0;

  for (let vi = 0; vi < vols.length; vi++) {
    const v = vols[vi];
    for (const sg of v.segs) {
      const { raw, starts, flags, depth, n } = sg;
      let k = 0;
      rx.lastIndex = 0;
      for (;;) {
        const m = rx.exec(raw);
        if (!m) break;
        k = floorIndex(starts, m.index, k, n - 1);
        const end = starts[k + 1];
        rx.lastIndex = end; // the next name
        const f = flags[k];
        if (f & F_DEAD) continue;
        const lower = raw.slice(starts[k], end - 1).toLowerCase();
        let ok = true;
        for (const t of nameTerms) {
          if (t.glob ? !t.rx.test(lower) : !lower.includes(t.t)) { ok = false; break; }
        }
        if (!ok) continue;
        if (pathTerms.length) {
          const full = key(v.pathOf(sg.base + k)) + (f & F_DIR ? '\\' : '');
          for (const t of pathTerms) {
            if (t.glob ? !t.rx.test(full) : !full.includes(t.t)) { ok = false; break; }
          }
          if (!ok) continue;
        }
        total++;
        const s = rank(lower, f, depth[k], ctx);
        if (s <= floor) continue;
        cand.push({ s, vi, id: sg.base + k });
        if (cand.length >= KEEP * 4) {
          cand.sort((a, b) => b.s - a.s);
          cand.length = KEEP;
          floor = cand[KEEP - 1].s;
        }
      }
    }
  }

  cand.sort((a, b) => b.s - a.s);
  if (cand.length > KEEP) cand.length = KEEP;
  // the few that are left get their paths, and two boosts that need them:
  // things you opened before, and things in your own folder
  const out = cand.map((c) => {
    const v = vols[c.vi];
    const p = v.pathOf(c.id);
    const pk = key(p);
    let s = c.s;
    if (recent && recent.has(pk)) s += 800;
    if (home && pk.startsWith(home + '\\')) s += 150;
    const isDir = (v.flagsOf(c.id) & F_DIR) !== 0;
    const cut = p.lastIndexOf('\\', p.length - 2);
    return { s, path: p, name: v.nameOf(c.id), dir: c.id === 0 ? '' : p.slice(0, cut < 0 ? 0 : cut), isDir };
  });
  out.sort((a, b) => b.s - a.s || a.path.length - b.path.length);
  return { total, items: out.slice(0, limit).map(({ s, ...it }) => it) };
}

// ---------------------------------------------------------------------------
// live updates: a folder changed, look at it again
// ---------------------------------------------------------------------------

// the child of `pid` called `nameLower` (any case), or -1
function childByName(v, pid, nameLower) {
  const rx = new RegExp('\\n' + escapeRx(nameLower) + '\\n', 'gi');
  for (const sg of v.segs) {
    if (sg.base + sg.n <= pid) continue; // children come after their parent
    rx.lastIndex = 0;
    let m;
    while ((m = rx.exec(sg.raw))) {
      rx.lastIndex = m.index + 1;
      const k = floorIndex(sg.starts, m.index + 1, 0, sg.n - 1);
      if (sg.starts[k] !== m.index + 1) continue;
      if (sg.parent[k] === pid && !(sg.flags[k] & F_DEAD)) return sg.base + k;
    }
  }
  return -1;
}

// a folder's id from its path, or -1 when it isn't in the index
function resolveDir(v, p) {
  const k = key(p);
  if (k === v.rootKey) return 0;
  if (!k.startsWith(v.rootKey + '\\')) return -1;
  const hit = v.dirIds.get(k);
  if (hit !== undefined && !(v.flagsOf(hit) & F_DEAD)) return hit;
  const pid = resolveDir(v, P.dirname(k));
  if (pid < 0) return -1;
  const id = childByName(v, pid, P.basename(k));
  if (id < 0 || !(v.flagsOf(id) & F_DIR)) return -1;
  if (v.dirIds.size > 20000) v.dirIds.clear();
  v.dirIds.set(k, id);
  return id;
}

// A folder's children. Finding them means one pass over the whole root, so
// they're kept for folders that change (a browser's cache changes all day);
// refreshDir() keeps the list right, and dead ones are dropped as it's read.
function childrenOf(v, pid) {
  let ids = v.kids.get(pid);
  if (!ids) {
    ids = [];
    for (const sg of v.segs) {
      if (sg.base + sg.n <= pid) continue;
      const { parent } = sg;
      for (let j = 0; j < sg.n; j++) if (parent[j] === pid) ids.push(sg.base + j);
    }
    if (v.kids.size >= 4000) v.kids.clear();
  }
  const out = [], live = [];
  for (const id of ids) {
    const f = v.flagsOf(id);
    if (f & F_DEAD) continue;
    live.push(id);
    out.push({ id, raw: v.nameOf(id), isDir: (f & F_DIR) !== 0 });
  }
  v.kids.set(pid, live);
  return out;
}

// Mark entries dead, and everything inside the folders among them.
function kill(v, ids) {
  if (!ids.length) return 0;
  let n = 0, firstDir = Infinity;
  for (const id of ids) {
    const s = v.seg(id), i = id - s.base;
    if (s.flags[i] & F_DEAD) continue;
    s.flags[i] |= F_DEAD;
    n++;
    if ((s.flags[i] & F_DIR) && id < firstDir) firstDir = id;
  }
  if (firstDir !== Infinity) {
    // one pass forward: parents come first, so a dead parent is already known
    for (const sg of v.segs) {
      if (sg.base + sg.n <= firstDir) continue;
      for (let j = Math.max(0, firstDir + 1 - sg.base); j < sg.n; j++) {
        if (sg.flags[j] & F_DEAD) continue;
        const p = sg.parent[j];
        if (p >= firstDir && (v.flagsOf(p) & F_DEAD)) { sg.flags[j] |= F_DEAD; n++; }
      }
    }
    v.dirIds.clear();
  }
  v.live -= n;
  return n;
}

// Compare a folder on disk with the index and fix the difference. New folders
// are walked whole (a folder moved in brings its contents along).
// Returns { added, removed }, or 'up' when this folder isn't known (look at
// its parent instead), or null when it can't be read.
function refreshDir(v, dirPath) {
  const id = resolveDir(v, dirPath);
  if (id < 0) return 'up';
  if (id > 0 && v.parentOf(id) === 0 && skipInside(v.nameOf(id).toLowerCase(), 1, v.noWindows)) return { added: 0, removed: 0 };
  let ents;
  try {
    ents = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (err) {
    return err.code === 'ENOENT' || err.code === 'ENOTDIR' ? 'up' : null;
  }
  const have = new Map();
  for (const c of childrenOf(v, id)) have.set(c.raw.toLowerCase(), c);
  const depth = v.depthOf(id) + 1;
  const noisy = (v.flagsOf(id) & F_NOISY) !== 0;
  const batch = new Batch();
  const dirs = [];
  let next = v.next;
  for (const ent of ents) {
    const name = ent.name, lower = name.toLowerCase();
    const isDir = isRealDir(ent);
    if (isDir && SKIP.has(lower)) continue;
    const c = have.get(lower);
    if (c && c.isDir === isDir && c.raw === name) { have.delete(lower); continue; }
    const f = flagsFor(name, lower, isDir, noisy, depth);
    const nid = next++;
    batch.push(name, id, f, depth);
    if (isDir && !skipInside(lower, depth, v.noWindows)) dirs.push({ p: P.join(dirPath, name), id: nid, noisy: (f & F_NOISY) !== 0 });
  }
  const removed = kill(v, [...have.values()].map((c) => c.id));
  const before = v.next;
  v.add(batch.pack());
  const kids = v.kids.get(id);
  if (kids) for (let nid = before; nid < before + batch.length; nid++) kids.push(nid);
  for (const d of dirs) {
    walk(d.p, { dirId: d.id, nextId: v.next, depth, noisy: d.noisy, noWindows: v.noWindows, onBatch: (p) => v.add(p) });
  }
  return { added: v.next - before, removed };
}

// ---------------------------------------------------------------------------
// the cache on disk: one file per root
//   {"v":1,"root":"C:\\","n":…,"at":…,"nb":…}\n  names (utf8)  pad  parent (int32)  flags  depth
// Dead entries are left out, so the file is also a clean copy of the index.
// ---------------------------------------------------------------------------

const FORMAT = 1;

// Written a segment at a time, so saving never holds a second copy of the
// names: a segment with nothing dead in it goes out as it is.
function save(v, file) {
  const map = new Int32Array(v.next).fill(-1);
  const parent = new Int32Array(v.live), flags = new Uint8Array(v.live), depth = new Uint8Array(v.live);
  const chunks = [];
  let n = 0, nb = 1; // the leading "\n"
  for (const sg of v.segs) {
    const from = n;
    let names = null; // only when something in this segment is left out
    for (let j = 0; j < sg.n; j++) {
      const p = sg.parent[j];
      const np = p < 0 ? -1 : map[p];
      if ((sg.flags[j] & F_DEAD) || (p >= 0 && np < 0) || n >= parent.length) { // gone, or its folder is
        if (!names) { names = []; for (let x = 0; x < j; x++) names.push(sg.name(x)); }
        continue;
      }
      map[sg.base + j] = n;
      if (names) names.push(sg.name(j));
      parent[n] = np;
      flags[n] = sg.flags[j];
      depth[n] = sg.depth[j];
      n++;
    }
    if (n === from) continue;
    const text = names ? names.join('\n') + '\n' : sg.raw.slice(1);
    chunks.push(text);
    nb += Buffer.byteLength(text, 'utf8');
  }
  const head = Buffer.from(JSON.stringify({ v: FORMAT, root: v.root, n, at: v.scannedAt || Date.now(), nb, nw: v.noWindows }) + '\n', 'utf8');
  fs.mkdirSync(P.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, head);
    fs.writeSync(fd, '\n');
    for (const text of chunks) fs.writeSync(fd, text, null, 'utf8');
    fs.writeSync(fd, Buffer.alloc((4 - ((head.length + nb) % 4)) % 4));
    fs.writeSync(fd, new Uint8Array(parent.buffer, 0, n * 4));
    fs.writeSync(fd, flags.subarray(0, n));
    fs.writeSync(fd, depth.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  return n;
}

// Fills `v` from its cache file. Returns false if there's none (or it's not
// for this root, or it's from another version).
function load(v, file) {
  let buf;
  try { buf = fs.readFileSync(file); } catch (_) { return false; }
  try {
    const nl = buf.indexOf(10);
    const h = JSON.parse(buf.toString('utf8', 0, nl));
    if (h.v !== FORMAT || key(h.root) !== v.rootKey || !(h.n > 0)) return false;
    const body = nl + 1;
    let off = body + h.nb;
    off += (4 - (off % 4)) % 4;
    const take = (bytes) => { const b = buf.subarray(off, off + bytes); off += bytes; return new Uint8Array(b).buffer; };
    const parent = new Int32Array(take(h.n * 4));
    const flags = new Uint8Array(take(h.n));
    const depth = new Uint8Array(take(h.n));
    if (depth.length !== h.n) return false;
    v.reset();
    // Names straight from the bytes, SEG at a time (each its own string, so
    // one wide character only widens its own segment).
    let from = body, count = 0, start = 0;
    for (let i = body + 1, end = body + h.nb; i < end; i++) {
      if (buf[i] !== 10) continue;
      count++;
      if (count % SEG !== 0 && i !== end - 1) continue;
      const n = count - start;
      v.add({
        raw: buf.toString('utf8', from, i + 1),
        parent: parent.subarray(start, count),
        flags: flags.subarray(start, count),
        depth: depth.subarray(start, count),
      });
      const sg = v.segs[v.segs.length - 1];
      if (sg.starts[n] !== sg.raw.length) { v.reset(); return false; } // names and count disagree
      from = i;
      start = count;
    }
    if (count !== h.n) { v.reset(); return false; }
    v.scannedAt = h.at;
    v.cachedNoWindows = !!h.nw; // how it was read: a cache from before the setting has the Windows folders in
    return true;
  } catch (_) {
    v.reset();
    return false;
  }
}

module.exports = { Volume, Segment, search, parse, refreshDir, resolveDir, kill, save, load, key };
