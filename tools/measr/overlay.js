'use strict';

// The measuring overlay: one per display. It shows the frozen screen and reads
// it pixel by pixel, so it can tell where things begin and end.
//
//   move        the space round the pointer: lines run out to the nearest edges
//   click       pin that measure          drag        a box, snapped to what's inside
//   dbl-click   a box round the element   two boxes   the gap, or the padding
//   arrows      nudge 1 px (shift 10)     ctrl+c      copy what's white
//   enter       copy and close            c / s / a   colour / image / everything
//   tab         next box                  backspace   undo · del clears
//   right click the menu                  esc         close
//
// Everything is worked out and drawn in device pixels (the screenshot's own),
// on a canvas the size of the screen, so a line is always exactly one pixel.
(() => {
  const api = window.measr;
  const $ = (id) => document.getElementById(id);
  const shot = $('shot'), sctx = shot.getContext('2d', { alpha: false, willReadFrequently: false });
  const ink = $('ink'), ctx = ink.getContext('2d');
  const loupe = $('loupe'), lens = $('lens'), lctx = lens.getContext('2d');
  const noteEl = $('note'), sheet = $('keys'), menuEl = $('menu');

  // ghost tokens, read from the theme so there's one source of truth
  const css = getComputedStyle(document.documentElement);
  const tok = (n, d) => (css.getPropertyValue(n) || '').trim() || d;
  const C = {
    line: tok('--strong', '#ffffff'),
    halo: tok('--halo', 'rgba(0, 0, 0, .5)'),
    chip: tok('--menu-bg', '#161616'),
    chipHot: tok('--menu-hover', '#1f1f1f'),
    edge: tok('--menu-border', '#2a2a2a'),
    edgeHot: tok('--dim', '#8a8a8a'),
    text: tok('--text', '#d6d6d6'),
    strong: tok('--strong', '#ffffff'),
    dim: tok('--dim', '#8a8a8a'),
    font: tok('--font', "'DM Mono', monospace"),
  };
  const TOL = { exact: 4, soft: 18, loose: 48 };
  const MIN_DRAG = 4;       // css px: less than this is a click
  const MAX_PINS = 64;
  const LOUPE_N = 15;       // pixels across the loupe
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // --- state ----------------------------------------------------------------

  let sid = null, live = false;
  let S = null;              // settings
  let scale = 1;             // the display's scale factor (css px → screen px)
  let W = 0, H = 0;          // screen size in device px
  let kx = 1, ky = 1;        // device px per css px of this window
  let px = null;             // the screenshot, Uint32 RGBA per pixel
  let LW = 1, HALO = 1;      // line width and its dark halo, device px
  let U = 1;                 // one css px in device px (for sizes of drawn things)

  let mouse = null;          // last pointer position, css px
  let nudge = { x: 0, y: 0 };// arrow keys move the crosshair off the pointer
  let inside = false;        // the pointer is on this display
  let pins = [];             // { id, type: 'cross'|'box', ... } device px
  let pinSeq = 0;
  let sel = null;            // the selected box's id (gaps / padding are from it)
  let drag = null;           // { x, y } device px start
  let fresh = null;          // { id, at } just made: ctrl+c copies it until you move away
  let chips = [];            // hit areas of every number drawn, last frame
  let hot = null;            // the chip under the pointer
  let clicks = [];           // { id, t } crosses pinned by recent clicks (a dbl-click takes them back)
  let menuOpen = false;
  let stillTimer = null, loupeOn = false, stillAt = null;
  let noteTimer = null;

  // --- pixels ---------------------------------------------------------------

  // main sends the raw BGRA bitmap: swap to RGBA, keep it for reading, and paint it
  function paint(bitmap, width, height) {
    W = shot.width = ink.width = width;
    H = shot.height = ink.height = height;
    const src = new Uint32Array(bitmap.buffer, bitmap.byteOffset, (bitmap.byteLength / 4) | 0);
    const img = sctx.createImageData(width, height);
    const dst = new Uint32Array(img.data.buffer);
    const n = Math.min(src.length, dst.length);
    for (let i = 0; i < n; i++) {
      const p = src[i];
      dst[i] = 0xff000000 | ((p & 0xff) << 16) | (p & 0xff00) | ((p >>> 16) & 0xff);
    }
    sctx.putImageData(img, 0, 0);
    px = dst;
  }

  const tol = () => TOL[(S && S.edges) || 'soft'];
  function same(a, b, t) {
    if (a === b) return true;
    const dr = (a & 255) - (b & 255), dg = ((a >>> 8) & 255) - ((b >>> 8) & 255), db = ((a >>> 16) & 255) - ((b >>> 16) & 255);
    return dr <= t && dr >= -t && dg <= t && dg >= -t && db <= t && db >= -t;
  }
  const at = (x, y) => px[y * W + x];
  const hex = (p) => '#' + [p & 255, (p >>> 8) & 255, (p >>> 16) & 255].map((v) => v.toString(16).padStart(2, '0')).join('');

  // The space round a point: walk out in four directions until the colour changes.
  // -> { x, y, l, r, t, b } with the span [l, r) × [t, b)
  function cross(x, y) {
    const t = tol(), seed = at(x, y), row = y * W;
    let l = x, r = x, u = y, d = y;
    while (l > 0 && same(px[row + l - 1], seed, t)) l--;
    while (r < W - 1 && same(px[row + r + 1], seed, t)) r++;
    while (u > 0 && same(px[(u - 1) * W + x], seed, t)) u--;
    while (d < H - 1 && same(px[(d + 1) * W + x], seed, t)) d++;
    return { x, y, l, r: r + 1, t: u, b: d + 1 };
  }

  // A box you drew, shrunk to what's in it: the background is the colour most of
  // its edge has, and the box closes in until it meets something else.
  function snap(b) {
    if (b.w < 2 || b.h < 2) return b;
    const t = tol();
    const counts = new Map();
    const step = Math.max(1, Math.floor((b.w + b.h) / 600));
    const vote = (x, y) => { const p = at(x, y) & 0xfcfcfc; counts.set(p, (counts.get(p) || 0) + 1); };
    for (let x = b.x; x < b.x + b.w; x += step) { vote(x, b.y); vote(x, b.y + b.h - 1); }
    for (let y = b.y; y < b.y + b.h; y += step) { vote(b.x, y); vote(b.x + b.w - 1, y); }
    let bgKey = 0, best = -1;
    for (const [k, n] of counts) if (n > best) { best = n; bgKey = k; }
    // a real pixel of that colour, to compare against
    let bg = null;
    for (let x = b.x; x < b.x + b.w && bg === null; x++) if ((at(x, b.y) & 0xfcfcfc) === bgKey) bg = at(x, b.y);
    for (let y = b.y; y < b.y + b.h && bg === null; y++) if ((at(b.x, y) & 0xfcfcfc) === bgKey) bg = at(b.x, y);
    if (bg === null) return b;
    const x2 = b.x + b.w, y2 = b.y + b.h;
    const rowHas = (y, xa, xb) => { const o = y * W; for (let x = xa; x < xb; x++) if (!same(px[o + x], bg, t)) return true; return false; };
    const colHas = (x, ya, yb) => { for (let y = ya; y < yb; y++) if (!same(px[y * W + x], bg, t)) return true; return false; };
    let top = b.y; while (top < y2 && !rowHas(top, b.x, x2)) top++;
    if (top === y2) return b; // nothing in it: keep what you drew
    let bot = y2 - 1; while (bot > top && !rowHas(bot, b.x, x2)) bot--;
    let left = b.x; while (left < x2 && !colHas(left, top, bot + 1)) left++;
    let right = x2 - 1; while (right > left && !colHas(right, top, bot + 1)) right--;
    return { x: left, y: top, w: right - left + 1, h: bot - top + 1 };
  }

  // The element under a point: everything of its colour that's connected to it.
  // null when that's the page itself (it runs off most of the screen).
  let seen = null;
  function element(x, y) {
    const t = tol(), seed = at(x, y);
    if (!seen || seen.length !== W * H) seen = new Uint8Array(W * H); else seen.fill(0);
    const limit = W * H * 0.5;
    let count = 0, minX = x, maxX = x, minY = y, maxY = y;
    const stack = [y * W + x];
    const ok = (i) => !seen[i] && same(px[i], seed, t);
    while (stack.length) {
      const i = stack.pop();
      if (seen[i]) continue;
      const yy = (i / W) | 0, o = yy * W;
      let lx = i - o, rx = lx;
      while (lx > 0 && ok(o + lx - 1)) lx--;
      while (rx < W - 1 && ok(o + rx + 1)) rx++;
      for (let k = lx; k <= rx; k++) seen[o + k] = 1;
      count += rx - lx + 1;
      if (count > limit) return null;
      if (lx < minX) minX = lx;
      if (rx > maxX) maxX = rx;
      if (yy < minY) minY = yy;
      if (yy > maxY) maxY = yy;
      for (const ny of [yy - 1, yy + 1]) {
        if (ny < 0 || ny >= H) continue;
        const no = ny * W;
        let run = false;
        for (let k = lx; k <= rx; k++) {
          const m = ok(no + k);
          if (m && !run) stack.push(no + k);
          run = m;
        }
      }
    }
    const b = { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
    if (b.w >= W * 0.95 && b.h >= H * 0.95) return null;
    return b;
  }

  // --- numbers --------------------------------------------------------------

  const val = (dev) => (S && S.units === 'screen' ? dev : dev / scale);
  const num = (n) => (Math.abs(n - Math.round(n)) < 0.05 ? String(Math.round(n)) : n.toFixed(1));
  const show = (dev) => num(val(dev));

  // tailwind's spacing scale: 4px a step (half steps too), anything else in brackets
  function tw(n) {
    if (Math.abs(n) < 0.05) return '0';
    if (Math.abs(n - 1) < 0.05) return 'px';
    const q = n / 4;
    if (Math.abs(q * 2 - Math.round(q * 2)) < 0.01) return String(Math.round(q * 2) / 2);
    return `[${num(n)}px]`;
  }

  // what a copy puts on the clipboard, in the chosen format
  function text(c) {
    const f = (S && S.format) || 'plain';
    const v = (d) => num(val(d));
    const tv = (d) => tw(+num(val(d)));
    if (c.kind === 'size') {
      if (f === 'css') return `width: ${v(c.w)}px; height: ${v(c.h)}px;`;
      if (f === 'tailwind') return `w-${tv(c.w)} h-${tv(c.h)}`;
      return `${v(c.w)} × ${v(c.h)}`;
    }
    if (c.kind === 'gap') {
      const axis = c.axis;
      if (f === 'css') return `${axis === 'x' ? 'column-gap' : 'row-gap'}: ${v(c.v)}px;`;
      if (f === 'tailwind') return `gap-${axis}-${tv(c.v)}`;
      return v(c.v);
    }
    if (c.kind === 'pad') {
      const [t, r, b, l] = [c.t, c.r, c.b, c.l].map(v);
      const short = t === b && l === r ? (t === l ? [t] : [t, r]) : l === r ? [t, r, b] : [t, r, b, l];
      if (f === 'css') return `padding: ${short.map((x) => x + 'px').join(' ')};`;
      if (f === 'tailwind') {
        const [T, R, B, L] = [c.t, c.r, c.b, c.l].map(tv);
        if (T === R && R === B && B === L) return `p-${T}`;
        if (T === B && L === R) return `px-${L} py-${T}`;
        return `pt-${T} pr-${R} pb-${B} pl-${L}`;
      }
      return short.join(' ');
    }
    return '';
  }

  // --- geometry -------------------------------------------------------------

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  // the crosshair: the pointer in device px, plus what the arrow keys added
  function point() {
    if (!mouse) return null;
    return {
      x: clamp(Math.floor(mouse.x * kx) + nudge.x, 0, W - 1),
      y: clamp(Math.floor(mouse.y * ky) + nudge.y, 0, H - 1),
    };
  }
  const dev = (m) => ({ x: m.x * kx, y: m.y * ky });
  const boxes = () => pins.filter((p) => p.type === 'box');
  const byId = (id) => pins.find((p) => p.id === id) || null;
  const contains = (o, i) => i.x >= o.x && i.y >= o.y && i.x + i.w <= o.x + o.w && i.y + i.h <= o.y + o.h;
  const within = (b, p) => p.x >= b.x && p.x < b.x + b.w && p.y >= b.y && p.y < b.y + b.h;

  // which box the gap or padding is measured to: the one under the pointer,
  // or else the one made just before the selected one
  function partner() {
    const s = byId(sel);
    if (!s) return null;
    const p = point();
    const bs = boxes();
    if (p && inside) {
      const under = bs.filter((b) => b.id !== s.id && within(b, p)).sort((a, b) => a.w * a.h - b.w * b.h)[0];
      if (under) return under;
    }
    const i = bs.indexOf(s);
    return bs[i - 1] || (i === 0 ? bs[1] : null) || null;
  }

  // the relation between two boxes: padding when one holds the other, else gaps
  function relation(A, B) {
    if (!A || !B) return null;
    if (contains(A, B) || contains(B, A)) {
      const o = contains(A, B) ? A : B, i = o === A ? B : A;
      return { kind: 'pad', o, i, t: i.y - o.y, r: o.x + o.w - (i.x + i.w), b: o.y + o.h - (i.y + i.h), l: i.x - o.x };
    }
    const ax2 = A.x + A.w, ay2 = A.y + A.h, bx2 = B.x + B.w, by2 = B.y + B.h;
    const gaps = [];
    const gx = B.x >= ax2 ? [ax2, B.x, true] : A.x >= bx2 ? [bx2, A.x, false] : null;
    const gy = B.y >= ay2 ? [ay2, B.y, true] : A.y >= by2 ? [by2, A.y, false] : null;
    if (gx) {
      const o1 = Math.max(A.y, B.y), o2 = Math.min(ay2, by2);
      const y = o2 > o1 ? Math.floor((o1 + o2) / 2) : Math.floor(B.y + B.h / 2);
      // no overlap: A's edge is drawn on, dashed, to meet the line
      const ext = o2 > o1 ? null : { x: gx[2] ? ax2 : A.x - 1, y1: y < A.y ? y : ay2, y2: y < A.y ? A.y : y };
      gaps.push({ axis: 'x', a: gx[0], b: gx[1], at: y, ext });
    }
    if (gy) {
      const o1 = Math.max(A.x, B.x), o2 = Math.min(ax2, bx2);
      const x = o2 > o1 ? Math.floor((o1 + o2) / 2) : Math.floor(B.x + B.w / 2);
      const ext = o2 > o1 ? null : { y: gy[2] ? ay2 : A.y - 1, x1: x < A.x ? x : ax2, x2: x < A.x ? A.x : x };
      gaps.push({ axis: 'y', a: gy[0], b: gy[1], at: x, ext });
    }
    return gaps.length ? { kind: 'gaps', gaps } : null;
  }

  // --- drawing --------------------------------------------------------------

  let dirty = false;
  const redraw = () => { if (dirty) return; dirty = true; requestAnimationFrame(() => { dirty = false; draw(); }); };

  // a line in device px, along pixel centres, with a dark halo so it reads on anything
  function line(x1, y1, x2, y2, alpha = 1, dashed = false) {
    const o = LW / 2;
    const hz = y1 === y2;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.lineCap = 'butt';
    if (dashed) ctx.setLineDash([3 * U, 3 * U]);
    ctx.beginPath();
    if (hz) { ctx.moveTo(x1, y1 + o); ctx.lineTo(x2, y2 + o); } else { ctx.moveTo(x1 + o, y1); ctx.lineTo(x2 + o, y2); }
    ctx.strokeStyle = C.halo;
    ctx.lineWidth = LW + 2 * HALO;
    ctx.stroke();
    ctx.strokeStyle = C.line;
    ctx.lineWidth = LW;
    ctx.stroke();
    ctx.restore();
  }

  // a measured span [a, b) along x at row y (or along y at column x), with end ticks
  function span(axis, a, b, at, alpha = 1) {
    const tk = 3 * U;
    if (b - a < 1) return;
    if (axis === 'x') {
      line(a, at, b, at, alpha);
      line(a, at - tk, a, at + tk + LW, alpha);
      line(b - LW, at - tk, b - LW, at + tk + LW, alpha);
    } else {
      line(at, a, at, b, alpha);
      line(at - tk, a, at + tk + LW, a, alpha);
      line(at - tk, b - LW, at + tk + LW, b - LW, alpha);
    }
  }

  function outline(b, alpha = 1, dashed = false) {
    const x1 = b.x - LW, y1 = b.y - LW, x2 = b.x + b.w, y2 = b.y + b.h;
    line(x1, y1, x2 + LW, y1, alpha, dashed);
    line(x1, y2, x2 + LW, y2, alpha, dashed);
    line(x1, y1, x1, y2 + LW, alpha, dashed);
    line(x2, y1, x2, y2 + LW, alpha, dashed);
  }

  // a number: a small ghost panel. parts: [[text, dim?], …]
  // places: where it may go, best first, as { x, y, ax, ay } with (ax, ay) ∈ 0…1
  // the point of the chip that sits at (x, y). Numbers are queued while the
  // lines are drawn, then laid out most important first, each in the first of
  // its places that's still free, so they never pile up on each other.
  let queue = [];
  function chip(parts, places, key, copy, { alpha = 1, rank = 3 } = {}) {
    queue.push({ parts, places, key, copy, alpha, rank });
  }

  function layChips() {
    const focus = focusKey();
    const padX = 6 * U, h = Math.round(18 * U), m = 3 * U;
    const placed = [];
    const free = (r) => !placed.some((o) => r.x < o.x + o.w + m && o.x < r.x + r.w + m && r.y < o.y + o.h + m && o.y < r.y + r.h + m);
    const rank = (c) => (c.key && c.key === focus ? -1 : c.rank);
    ctx.save();
    ctx.font = `300 ${10 * U}px ${C.font}`;
    ctx.textBaseline = 'middle';
    ctx.lineWidth = LW;
    for (const c of queue.sort((a, b) => rank(a) - rank(b))) {
      const widths = c.parts.map(([t]) => ctx.measureText(t).width);
      const w = Math.round(widths.reduce((s, x) => s + x, 0) + 2 * padX);
      const fit = (x, y) => ({ x: clamp(Math.round(x), 2 * U, W - w - 2 * U), y: clamp(Math.round(y), 2 * U, H - h - 2 * U), w, h });
      let r = null, found = false;
      for (const p of c.places) {
        const here = fit(p.x - w * p.ax, p.y - h * p.ay);
        if (!r) r = here;
        if (free(here)) { r = here; found = true; break; }
      }
      // crowded (small things close together): step away from the first place until it's clear
      if (!found) {
        const base = r;
        search: for (let k = 1; k <= 6; k++) {
          for (const [dx, dy] of [[0, k], [0, -k], [k, 0], [-k, 0]]) {
            const here = fit(base.x + dx * (w / 2 + m), base.y + dy * (h + m));
            if (free(here)) { r = here; break search; }
          }
        }
      }
      placed.push(r);
      const isHot = c.key && c.key === focus;
      ctx.globalAlpha = c.alpha;
      ctx.fillStyle = isHot ? C.chipHot : C.chip;
      ctx.fillRect(r.x, r.y, w, h);
      ctx.strokeStyle = isHot ? C.edgeHot : C.edge;
      ctx.strokeRect(r.x + LW / 2, r.y + LW / 2, w - LW, h - LW);
      let tx = r.x + padX;
      c.parts.forEach(([t, dim], i) => {
        ctx.fillStyle = dim ? C.dim : isHot ? C.strong : C.text;
        ctx.fillText(t, tx, r.y + h / 2 + 0.5 * U);
        tx += widths[i];
      });
      if (c.key && c.copy) chips.push({ ...r, key: c.key, copy: c.copy });
    }
    ctx.restore();
    queue = [];
  }
  const sizeParts = (w, h) => [[show(w)], [' × ', true], [show(h)]];
  // round a point: below right first, then the other corners
  const around = (x, y, g) => [
    { x: x + g, y: y + g, ax: 0, ay: 0 }, { x: x - g, y: y + g, ax: 1, ay: 0 },
    { x: x + g, y: y - g, ax: 0, ay: 1 }, { x: x - g, y: y - g, ax: 1, ay: 1 },
  ];
  // along a measured span: beside its middle, either side
  const beside = (axis, a, b, at) => {
    const mid = (a + b) / 2, g = 5 * U;
    return axis === 'x'
      ? [{ x: mid, y: at - g, ax: 0.5, ay: 1 }, { x: mid, y: at + g + LW, ax: 0.5, ay: 0 }]
      : [{ x: at + g + LW, y: mid, ax: 0, ay: 0.5 }, { x: at - g, y: mid, ax: 1, ay: 0.5 }];
  };

  function drawCross(c, alpha, key, rank) {
    span('x', c.l, c.r, c.y, alpha);
    span('y', c.t, c.b, c.x, alpha);
    chip(sizeParts(c.r - c.l, c.b - c.t), around(c.x, c.y, 12 * U), key, { kind: 'size', w: c.r - c.l, h: c.b - c.t }, { alpha: Math.max(alpha, 0.85), rank });
  }

  function boxNow(b) {
    if (!b.anim) return b;
    const t = Math.min(1, (performance.now() - b.anim.t0) / 140);
    if (t >= 1) { b.anim = null; return b; }
    const k = 1 - Math.pow(1 - t, 3), f = b.anim.from;
    redraw();
    return { ...b, x: f.x + (b.x - f.x) * k, y: f.y + (b.y - f.y) * k, w: f.w + (b.w - f.w) * k, h: f.h + (b.h - f.h) * k };
  }

  function drawBox(b, alpha, key, rank) {
    const r = boxNow(b);
    const q = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) };
    outline(q, alpha);
    const g = 6 * U, cx = q.x + q.w / 2, cy = q.y + q.h / 2;
    chip(sizeParts(b.w, b.h), [
      { x: cx, y: q.y + q.h + g, ax: 0.5, ay: 0 }, { x: cx, y: q.y - g, ax: 0.5, ay: 1 },
      { x: q.x + q.w + g, y: cy, ax: 0, ay: 0.5 }, { x: q.x - g, y: cy, ax: 1, ay: 0.5 },
      { x: q.x + q.w - g, y: q.y + q.h - g, ax: 1, ay: 1 },
    ], key, { kind: 'size', w: b.w, h: b.h }, { alpha: Math.max(alpha, 0.85), rank });
  }

  function drawRelation(rel) {
    if (!rel) return;
    if (rel.kind === 'pad') {
      const { o, i } = rel;
      const cy = Math.floor(i.y + i.h / 2), cx = Math.floor(i.x + i.w / 2);
      const copy = { kind: 'pad', t: rel.t, r: rel.r, b: rel.b, l: rel.l };
      const sides = [
        ['x', o.x, i.x, cy, rel.l], ['x', i.x + i.w, o.x + o.w, cy, rel.r],
        ['y', o.y, i.y, cx, rel.t], ['y', i.y + i.h, o.y + o.h, cx, rel.b],
      ];
      for (const [axis, a, b, atv, v] of sides) {
        if (v < 1) continue;
        span(axis, a, b, atv);
        chip([[show(v)]], beside(axis, a, b, atv), 'rel:pad', copy, { rank: 1 });
      }
      return;
    }
    for (const gp of rel.gaps) {
      if (gp.ext) {
        if (gp.axis === 'x') line(gp.ext.x, gp.ext.y1, gp.ext.x, gp.ext.y2, 0.7, true);
        else line(gp.ext.x1, gp.ext.y, gp.ext.x2, gp.ext.y, 0.7, true);
      }
      span(gp.axis, gp.a, gp.b, gp.at);
      chip([[show(gp.b - gp.a)]], beside(gp.axis, gp.a, gp.b, gp.at), 'rel:g' + gp.axis, { kind: 'gap', axis: gp.axis, v: gp.b - gp.a }, { rank: 1 });
    }
  }

  // what ctrl+c copies right now (its chip is drawn white): the number under the
  // pointer, or what you just made, or the live measure
  function focusKey() {
    if (hot) return hot.key;
    if (fresh && byId(fresh.id)) return 'pin:' + fresh.id;
    if (showLive()) return 'live';
    return null;
  }
  function focusCopy() {
    if (hot) return hot.copy;
    const f = fresh && byId(fresh.id);
    if (f) return f.type === 'box' ? { kind: 'size', w: f.w, h: f.h } : { kind: 'size', w: f.r - f.l, h: f.b - f.t };
    const p = point();
    if (p && inside) { const c = cross(p.x, p.y); return { kind: 'size', w: c.r - c.l, h: c.b - c.t }; }
    return null;
  }

  const showLive = () => live && inside && mouse && !drag && !hot && !menuOpen && !(fresh && byId(fresh.id));

  function draw(exporting = false) {
    ctx.clearRect(0, 0, W, H);
    chips = [];
    if (!live) return;
    const s = byId(sel);
    for (const p of pins) {
      const isSel = p.id === sel;
      if (p.type === 'box') drawBox(p, isSel || exporting ? 1 : 0.55, 'pin:' + p.id, isSel ? 2 : 3);
      else drawCross(p, 0.8, 'pin:' + p.id, 3);
    }
    if (s) drawRelation(relation(s, partner()));

    if (!exporting) {
      const p = point();
      if (drag && p) {
        const b = dragBox(p);
        outline(b, 0.9, true);
        chip(sizeParts(b.w, b.h), around(b.x + b.w, b.y + b.h, 8 * U), null, null, { rank: 0 });
      } else if (showLive() && p) {
        drawCross(cross(p.x, p.y), 1, 'live', 0);
        // a one-pixel point where you are, so you always know exactly which pixel
        ctx.fillStyle = C.halo;
        ctx.fillRect(p.x - HALO, p.y - HALO, LW + 2 * HALO, LW + 2 * HALO);
        ctx.fillStyle = C.line;
        ctx.fillRect(p.x, p.y, LW, LW);
      }
    }
    layChips();
    document.body.classList.toggle('on-chip', !!hot);
    if (!exporting) drawLoupe();
  }

  function dragBox(p) {
    const x1 = Math.min(drag.x, p.x), y1 = Math.min(drag.y, p.y);
    return { x: x1, y: y1, w: Math.abs(p.x - drag.x) + 1, h: Math.abs(p.y - drag.y) + 1 };
  }

  // --- loupe ----------------------------------------------------------------

  const wantLoupe = () => S && live && inside && !menuOpen && !hot && (S.loupe === 'always' || (S.loupe === 'auto' && loupeOn));

  function drawLoupe() {
    const p = point();
    if (!wantLoupe() || !p) { loupe.hidden = true; return; }
    const cell = 8, size = LOUPE_N * cell;              // css px
    const dpr = window.devicePixelRatio || 1;
    if (lens.width !== Math.round(size * dpr)) { lens.width = lens.height = Math.round(size * dpr); lens.style.width = lens.style.height = size + 'px'; }
    const n = LOUPE_N, half = (n - 1) / 2, cs = lens.width / n;
    lctx.imageSmoothingEnabled = false;
    lctx.fillStyle = '#111111';
    lctx.fillRect(0, 0, lens.width, lens.height);
    lctx.drawImage(shot, p.x - half, p.y - half, n, n, 0, 0, lens.width, lens.height);
    lctx.fillStyle = 'rgba(255, 255, 255, .06)';
    for (let i = 1; i < n; i++) { lctx.fillRect(Math.round(i * cs), 0, 1, lens.height); lctx.fillRect(0, Math.round(i * cs), lens.width, 1); }
    const c0 = Math.round(half * cs);
    lctx.strokeStyle = 'rgba(0, 0, 0, .6)';
    lctx.lineWidth = 3;
    lctx.strokeRect(c0 - 0.5, c0 - 0.5, Math.round(cs) + 1, Math.round(cs) + 1);
    lctx.strokeStyle = '#ffffff';
    lctx.lineWidth = 1;
    lctx.strokeRect(c0 - 0.5, c0 - 0.5, Math.round(cs) + 1, Math.round(cs) + 1);
    $('hex').textContent = hex(at(p.x, p.y));
    $('pos').textContent = `${show(p.x)}, ${show(p.y)}`;
    loupe.hidden = false;
    // above right of the pointer; flips at the screen's edges
    const m = { x: p.x / kx, y: p.y / ky };
    const lw = loupe.offsetWidth, lh = loupe.offsetHeight, g = 22;
    let x = m.x + g, y = m.y - g - lh;
    if (x + lw > innerWidth - 4) x = m.x - g - lw;
    if (y < 4) y = m.y + g + 30;
    if (y + lh > innerHeight - 4) y = innerHeight - lh - 4;
    loupe.style.left = Math.round(x) + 'px';
    loupe.style.top = Math.round(y) + 'px';
  }

  // auto: the loupe comes when you slow down to aim, and goes when you move on
  function stillCheck() {
    if (!S || S.loupe !== 'auto' || !mouse) return;
    if (stillAt && Math.hypot(mouse.x - stillAt.x, mouse.y - stillAt.y) < 4) return;
    stillAt = { ...mouse };
    if (loupeOn) { loupeOn = false; redraw(); }
    clearTimeout(stillTimer);
    stillTimer = setTimeout(() => { loupeOn = true; redraw(); }, 420);
  }

  // --- notices --------------------------------------------------------------

  function note(html, ms = 1400) {
    clearTimeout(noteTimer);
    noteEl.innerHTML = html;
    noteEl.hidden = false;
    noteEl.classList.remove('gone');
    placeNote();
    if (ms) noteTimer = setTimeout(() => noteEl.classList.add('gone'), ms);
  }
  // top centre, unless you're measuring up there
  function placeNote() {
    const low = mouse && mouse.y < 120 && Math.abs(mouse.x - innerWidth / 2) < 360;
    noteEl.classList.toggle('low', !!low);
  }
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const copied = (what, detail = '') => note(`${esc(what)}${detail ? ` <span class="d">${esc(detail)}</span>` : ''}`);

  // --- actions --------------------------------------------------------------

  async function copy(c, close = false) {
    if (!c) return;
    const t = text(c);
    await api.copyText(t);
    if (close) { finish({ text: 'copied', detail: t }); return; }
    copied('copied', t);
  }

  async function copyColour() {
    const p = point();
    if (!p) return;
    const h = hex(at(p.x, p.y));
    await api.copyText(h);
    copied('copied', h);
  }

  // everything on screen, as lines of text
  async function copyAll() {
    const lines = [];
    for (const p of pins) {
      const c = p.type === 'box' ? { kind: 'size', w: p.w, h: p.h } : { kind: 'size', w: p.r - p.l, h: p.b - p.t };
      lines.push((p.type === 'box' ? 'box  ' : 'space  ') + text(c));
    }
    const rel = relation(byId(sel), partner());
    if (rel && rel.kind === 'pad') lines.push('padding  ' + text({ kind: 'pad', t: rel.t, r: rel.r, b: rel.b, l: rel.l }));
    if (rel && rel.kind === 'gaps') for (const g of rel.gaps) lines.push('gap  ' + text({ kind: 'gap', axis: g.axis, v: g.b - g.a }));
    if (!lines.length) { note('nothing pinned yet'); return; }
    await api.copyText(lines.join('\n'));
    copied('copied', lines.length === 1 ? lines[0] : `${lines.length} lines`);
  }

  // the screen round what you measured, with the measures drawn on: for a chat,
  // an issue, a prompt
  async function copyImage() {
    let r = null;
    const grow = (b) => { r = r ? { x1: Math.min(r.x1, b.x), y1: Math.min(r.y1, b.y), x2: Math.max(r.x2, b.x + b.w), y2: Math.max(r.y2, b.y + b.h) } : { x1: b.x, y1: b.y, x2: b.x + b.w, y2: b.y + b.h }; };
    for (const p of pins) grow(p.type === 'box' ? p : { x: p.l, y: p.t, w: p.r - p.l, h: p.b - p.t });
    if (!r) { const p = point(); if (p) { const c = cross(p.x, p.y); pins.push({ id: ++pinSeq, type: 'cross', ...c }); grow({ x: c.l, y: c.t, w: c.r - c.l, h: c.b - c.t }); } }
    if (!r) return;
    const m = 40 * U;
    const x1 = clamp(Math.floor(r.x1 - m), 0, W), y1 = clamp(Math.floor(r.y1 - m), 0, H);
    const x2 = clamp(Math.ceil(r.x2 + m + 40 * U), 0, W), y2 = clamp(Math.ceil(r.y2 + m + 20 * U), 0, H);
    const out = document.createElement('canvas');
    out.width = x2 - x1;
    out.height = y2 - y1;
    const o = out.getContext('2d');
    const keepHot = hot, keepFresh = fresh;
    hot = null; fresh = null;
    draw(true);
    o.drawImage(shot, x1, y1, out.width, out.height, 0, 0, out.width, out.height);
    o.drawImage(ink, x1, y1, out.width, out.height, 0, 0, out.width, out.height);
    hot = keepHot; fresh = keepFresh;
    draw();
    const blob = await new Promise((res) => out.toBlob(res, 'image/png'));
    if (!blob) return;
    const ok = await api.copyPng(new Uint8Array(await blob.arrayBuffer()));
    copied(ok ? 'image copied' : 'could not copy', ok ? `${out.width} × ${out.height}` : '');
  }

  function addPin(p) {
    if (pins.length >= MAX_PINS) pins.shift();
    pins.push(p);
    if (p.type === 'box') sel = p.id;
    fresh = { id: p.id, at: { ...mouse } };
    if (sel && !byId(sel)) sel = (boxes().slice(-1)[0] || {}).id || null;
    redraw();
    return p;
  }

  function undo() {
    const p = pins.pop();
    if (!p) return;
    if (p.id === sel) sel = (boxes().slice(-1)[0] || {}).id || null;
    if (fresh && fresh.id === p.id) fresh = null;
    hot = null;
    redraw();
  }

  function clearAll() {
    pins = []; sel = null; fresh = null; hot = null;
    redraw();
  }

  function nextBox() {
    const bs = boxes();
    if (bs.length < 2) return;
    const i = bs.findIndex((b) => b.id === sel);
    sel = bs[(i + 1) % bs.length].id;
    redraw();
  }

  function finish(notice) {
    if (!live) return;
    live = false;
    api.close(notice || null);
  }

  // --- menu (right click) ---------------------------------------------------

  let menuAt = null; // what the menu acts on: the copy and the point as they were on right click
  const menu = window.MeasrMenu.create({
    el: menuEl,
    api,
    commands: () => {
      const c = menuAt && menuAt.copy;
      return [
        { act: 'copy', label: 'copy', value: c ? text(c) : 'ctrl+c', disabled: !c },
        { act: 'colour', label: 'copy colour', value: menuAt && menuAt.colour ? menuAt.colour : 'c', disabled: !(menuAt && menuAt.colour) },
        { act: 'image', label: 'copy image', value: 's' },
        { act: 'all', label: 'copy all', value: 'a', disabled: !pins.length },
      ];
    },
    footer: () => [
      { act: 'undo', label: 'undo', value: 'backspace', disabled: !pins.length },
      { act: 'clear', label: 'clear', value: 'del', disabled: !pins.length },
      { act: 'keys', label: 'keys', value: '?' },
      { act: 'close', label: 'close', value: 'esc' },
    ],
    onCommand: (a) => {
      const keep = menuAt;
      closeMenu();
      if (a === 'copy' && keep) copy(keep.copy);
      else if (a === 'colour' && keep && keep.colour) api.copyText(keep.colour).then(() => copied('copied', keep.colour));
      else if (a === 'image') copyImage();
      else if (a === 'all') copyAll();
      else if (a === 'undo') undo();
      else if (a === 'clear') clearAll();
      else if (a === 'keys') toggleSheet(true);
      else if (a === 'close') finish();
    },
  });

  function openMenu(e) {
    const p = point();
    menuAt = { copy: focusCopy(), colour: p ? hex(at(p.x, p.y)) : null };
    menuOpen = true;
    menu.reset();
    menu.set(S);
    menuEl.hidden = false;
    document.body.classList.add('menu-open');
    const w = menuEl.offsetWidth, h = menuEl.offsetHeight;
    menuEl.style.left = Math.round(Math.min(e.clientX, innerWidth - w - 6)) + 'px';
    menuEl.style.top = Math.round(Math.min(e.clientY, innerHeight - h - 6)) + 'px';
    redraw();
  }

  function closeMenu() {
    if (!menuOpen) return;
    menuOpen = false;
    menuEl.hidden = true;
    document.body.classList.remove('menu-open');
    redraw();
  }

  function toggleSheet(on) {
    sheet.hidden = !on;
    if (on) noteEl.classList.add('gone');
  }

  // --- input ----------------------------------------------------------------

  const pt = (e) => ({ x: e.clientX, y: e.clientY });
  const chipAt = (m) => { const d = dev(m); return chips.slice().reverse().find((c) => d.x >= c.x && d.x < c.x + c.w && d.y >= c.y && d.y < c.y + c.h) || null; };
  let down = null; // { m, onChip }

  window.addEventListener('pointerdown', (e) => {
    if (!live) return;
    if (menuOpen) { if (!menuEl.contains(e.target)) { closeMenu(); e.preventDefault(); } return; }
    if (!sheet.hidden) { toggleSheet(false); return; }
    if (e.button === 2) return; // the menu, on contextmenu
    if (e.button !== 0) return;
    mouse = pt(e);
    nudge = { x: 0, y: 0 };
    const c = chipAt(mouse);
    down = { m: mouse, chip: c };
    if (!c) {
      const p = point();
      drag = null;
      down.p = p;
    }
    try { document.body.setPointerCapture(e.pointerId); } catch (_) {}
    noteEl.classList.add('gone');
  });

  window.addEventListener('pointermove', (e) => {
    if (!live) return;
    const m = pt(e);
    const moved = !mouse || m.x !== mouse.x || m.y !== mouse.y;
    if (!moved) return;
    mouse = m;
    nudge = { x: 0, y: 0 };
    if (!inside) { inside = true; api.focus(); }
    if (menuOpen) return;
    if (down && !down.chip && !drag && Math.hypot(m.x - down.m.x, m.y - down.m.y) >= MIN_DRAG) {
      drag = { x: down.p.x, y: down.p.y };
      fresh = null;
    }
    if (fresh && Math.hypot(m.x - fresh.at.x, m.y - fresh.at.y) > 10) fresh = null;
    hot = drag ? null : chipAt(m);
    if (!noteEl.hidden) placeNote();
    stillCheck();
    redraw();
  });

  window.addEventListener('pointerup', (e) => {
    if (!live || !down || e.button !== 0) return;
    const d = down;
    down = null;
    mouse = pt(e);
    if (d.chip) {
      if (chipAt(mouse) === d.chip || (chipAt(mouse) && chipAt(mouse).key === d.chip.key)) copy(d.chip.copy);
      return;
    }
    if (drag) {
      const raw = dragBox(point());
      drag = null;
      const b = e.altKey ? raw : snap(raw);
      const pin = addPin({ id: ++pinSeq, type: 'box', ...b });
      if (!reduced && (b.x !== raw.x || b.y !== raw.y || b.w !== raw.w || b.h !== raw.h)) pin.anim = { from: raw, t0: performance.now() };
      return;
    }
    // a click: pin the space round the point
    const p = d.p || point();
    if (!p) return;
    const pin = addPin({ id: ++pinSeq, type: 'cross', ...cross(p.x, p.y) });
    const now = performance.now();
    clicks = clicks.filter((c) => now - c.t < 600);
    clicks.push({ id: pin.id, t: now });
  });

  // double click: the element under the pointer, as a box
  window.addEventListener('dblclick', (e) => {
    if (!live || menuOpen || chipAt(pt(e))) return;
    const now = performance.now();
    const back = new Set(clicks.filter((c) => now - c.t < 600).map((c) => c.id));
    pins = pins.filter((p) => !back.has(p.id));
    clicks = [];
    const p = point();
    if (!p) return;
    const b = element(p.x, p.y);
    if (!b) { note('that\'s the page <span class="d">· drag round the element</span>', 2000); redraw(); return; }
    addPin({ id: ++pinSeq, type: 'box', ...b });
  });

  window.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (!live) return;
    down = null;
    drag = null;
    if (menuOpen) closeMenu();
    toggleSheet(false);
    openMenu(e);
  });

  document.documentElement.addEventListener('mouseleave', () => { inside = false; hot = null; redraw(); });
  document.documentElement.addEventListener('mouseenter', () => { inside = true; api.focus(); redraw(); });
  window.addEventListener('blur', () => { down = null; drag = null; redraw(); });

  window.addEventListener('keydown', (e) => {
    if (!live) return;
    if (menuOpen) {
      if (menu.handleKey(e)) return;
      if (e.key === 'Escape') { e.preventDefault(); closeMenu(); }
      return;
    }
    if (!sheet.hidden && e.key !== '?' && e.key !== 'Shift') { e.preventDefault(); toggleSheet(false); if (e.key === 'Escape') return; }
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key;
    if (k === 'Escape') {
      e.preventDefault();
      if (drag || down) { drag = null; down = null; redraw(); return; }
      finish();
      return;
    }
    if (k.startsWith('Arrow')) {
      e.preventDefault();
      if (!mouse) return;
      const n = e.shiftKey ? 10 : 1;
      if (k === 'ArrowLeft') nudge.x -= n;
      if (k === 'ArrowRight') nudge.x += n;
      if (k === 'ArrowUp') nudge.y -= n;
      if (k === 'ArrowDown') nudge.y += n;
      fresh = null;
      hot = null;
      if (S && S.loupe === 'auto') { loupeOn = true; clearTimeout(stillTimer); }
      redraw();
      return;
    }
    if (k === 'Enter') { e.preventDefault(); const c = focusCopy(); if (c) copy(c, true); else finish(); return; }
    if (ctrl && e.code === 'KeyC') { e.preventDefault(); if (e.shiftKey) copyAll(); else copy(focusCopy()); return; }
    if (ctrl && e.code === 'KeyZ') { e.preventDefault(); undo(); return; }
    if (ctrl || e.altKey) return;
    if (e.code === 'KeyC') { e.preventDefault(); copyColour(); return; }
    if (e.code === 'KeyS') { e.preventDefault(); copyImage(); return; }
    if (e.code === 'KeyA') { e.preventDefault(); copyAll(); return; }
    if (k === 'Tab') { e.preventDefault(); nextBox(); return; }
    if (k === 'Backspace') { e.preventDefault(); undo(); return; }
    if (k === 'Delete') { e.preventDefault(); clearAll(); return; }
    if (k === '?' || e.code === 'KeyH' || k === 'F1') { e.preventDefault(); toggleSheet(sheet.hidden); return; }
    if (e.code === 'KeyZ') {
      // z: loupe on / off, for this time and from now on
      e.preventDefault();
      const next = S.loupe === 'off' ? 'auto' : 'off';
      api.setSettings({ loupe: next });
      S = { ...S, loupe: next };
      loupeOn = next === 'auto';
      note(`loupe <span class="d">${next === 'off' ? 'off' : 'on'}</span>`, 900);
      redraw();
    }
  });

  // --- from main ------------------------------------------------------------

  function reset() {
    live = false;
    pins = []; sel = null; drag = null; down = null; fresh = null; hot = null; clicks = [];
    mouse = null; nudge = { x: 0, y: 0 }; inside = false;
    loupeOn = false; stillAt = null;
    clearTimeout(stillTimer);
    clearTimeout(noteTimer);
    closeMenu();
    toggleSheet(false);
    noteEl.hidden = true;
    loupe.hidden = true;
    ctx.clearRect(0, 0, ink.width, ink.height);
    sctx.fillStyle = '#111111';
    sctx.fillRect(0, 0, shot.width, shot.height);
    px = null;
  }

  const fontReady = document.fonts.load(`300 10px 'DM Mono'`).catch(() => {});

  api.onOpen(async (o) => {
    reset();
    sid = o.sid;
    S = o.settings;
    scale = o.scale || 1;
    paint(o.bitmap, o.width, o.height);
    kx = W / innerWidth;
    ky = H / innerHeight;
    U = kx;
    LW = kx >= 1.75 ? 2 : 1;
    HALO = LW;
    if (o.active) {
      mouse = { x: o.cursor.x, y: o.cursor.y };
      inside = true;
      if (S.loupe === 'auto') stillCheck();
      if (S.hints) note(`drag <span class="d">box</span><span class="sep-dot">·</span>click <span class="d">pin</span><span class="sep-dot">·</span>ctrl+c <span class="d">copy</span><span class="sep-dot">·</span>? <span class="d">keys</span><span class="sep-dot">·</span>esc <span class="d">close</span>`, 3200);
    }
    live = true;
    await fontReady;
    draw();
    requestAnimationFrame(() => requestAnimationFrame(() => api.ready(sid)));
  });

  api.onReset(reset);
  api.onSettings((s) => { S = s; if (menuOpen) menu.set(S); redraw(); });
})();
