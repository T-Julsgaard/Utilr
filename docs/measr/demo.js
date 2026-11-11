'use strict';
// measr in the browser. Like the app, it measures by reading pixels: a pretend
// page is drawn on a canvas, and every edge, box and element is found in that
// canvas's own pixels (device px), then shown in css px.
(() => {
  const desk = document.getElementById('desk');
  const scr = document.getElementById('screen');
  const ov = document.getElementById('overlay');
  const toastEl = document.getElementById('toast');
  const sctx = scr.getContext('2d', { willReadFrequently: true });
  const octx = ov.getContext('2d');
  const TOL = 30; // "soft": ignores tiny differences, like compression noise

  let dpr = 1, W = 0, H = 0, DW = 0, DH = 0, data = null;
  let as = 'plain';
  let pointer = null;          // css px, or null when outside
  let drag = null;             // { x0, y0, x1, y1, alt }
  const marks = [];            // pinned: { kind: 'box', x, y, w, h } | { kind: 'space', ... }
  let clickTimer = null;

  // ---------------------------------------------------------------------------
  // the pretend page
  // ---------------------------------------------------------------------------
  function paint() {
    const r = desk.getBoundingClientRect();
    dpr = window.devicePixelRatio || 1;
    W = Math.round(r.width); H = Math.round(r.height);
    DW = Math.round(W * dpr); DH = Math.round(H * dpr);
    for (const c of [scr, ov]) { c.width = DW; c.height = DH; c.style.width = W + 'px'; c.style.height = H + 'px'; }
    const g = sctx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const rect = (x, y, w, h, fill, stroke) => {
      g.fillStyle = fill; g.fillRect(x, y, w, h);
      if (stroke) { g.fillStyle = stroke; g.fillRect(x, y, w, 1); g.fillRect(x, y + h - 1, w, 1); g.fillRect(x, y, 1, h); g.fillRect(x + w - 1, y, 1, h); }
    };
    rect(0, 0, W, H, '#f4f4f3');
    // nav
    rect(0, 0, W, 52, '#ffffff');
    rect(0, 52, W, 1, '#e4e4e7');
    rect(24, 14, 24, 24, '#18181b');
    rect(64, 22, 48, 8, '#a1a1aa'); rect(128, 22, 40, 8, '#a1a1aa');
    if (W > 420) rect(184, 22, 56, 8, '#a1a1aa');
    rect(W - 24 - 96, 10, 96, 32, '#18181b');
    rect(W - 24 - 72, 22, 48, 8, '#e4e4e7');
    // content
    const cw = Math.min(W - 48, 900);
    const x0 = Math.round((W - cw) / 2);
    const narrow = cw < 640;
    const c1w = narrow ? cw : 400;
    rect(x0, 84, c1w, 240, '#ffffff', '#e4e4e7');
    rect(x0 + 24, 108, 180, 12, '#27272a');
    rect(x0 + 24, 136, Math.min(320, c1w - 48), 8, '#d4d4d8');
    rect(x0 + 24, 152, Math.min(280, c1w - 48), 8, '#d4d4d8');
    rect(x0 + 24, 176, c1w - 48, 40, '#fafafa', '#d4d4d8');
    rect(x0 + 36, 192, 120, 8, '#a1a1aa');
    rect(x0 + 24, 260, 120, 40, '#18181b');
    rect(x0 + 52, 276, 64, 8, '#fafafa');
    rect(x0 + 160, 260, 96, 40, '#ffffff', '#d4d4d8');
    rect(x0 + 184, 276, 48, 8, '#52525b');
    if (!narrow) {
      const c2x = x0 + c1w + 24, c2w = cw - c1w - 24;
      rect(c2x, 84, c2w, 240, '#ffffff', '#e4e4e7');
      rect(c2x + 24, 108, 120, 12, '#27272a');
      const hs = [64, 104, 84, 136, 120, 156, 112, 172];
      const n = Math.max(3, Math.min(hs.length, Math.floor((c2w - 48 + 16) / 40)));
      hs.slice(0, n).forEach((h, i) => rect(c2x + 24 + i * 40, 300 - h, 24, h, i === n - 1 ? '#4f46e5' : '#c7d2fe'));
      rect(c2x + 24, 300, c2w - 48, 1, '#e4e4e7');
    }
    const ty = 348, tw = Math.floor((cw - 32) / 3);
    for (let i = 0; i < 3; i++) {
      const tx = x0 + i * (tw + 16);
      rect(tx, ty, tw, 120, '#ffffff', '#e4e4e7');
      rect(tx + 20, ty + 20, 32, 32, ['#e0e7ff', '#dcfce7', '#fef3c7'][i]);
      rect(tx + 20, ty + 68, Math.min(120, tw - 40), 10, '#3f3f46');
      rect(tx + 20, ty + 88, Math.min(160, tw - 40), 8, '#d4d4d8');
    }
    data = sctx.getImageData(0, 0, DW, DH).data;
    draw();
  }

  // ---------------------------------------------------------------------------
  // reading pixels (device px)
  // ---------------------------------------------------------------------------
  const at = (x, y) => (y * DW + x) * 4;
  const same = (i, j) => Math.abs(data[i] - data[j]) + Math.abs(data[i + 1] - data[j + 1]) + Math.abs(data[i + 2] - data[j + 2]) <= TOL;
  const dev = (v) => Math.max(0, Math.round(v * dpr));
  const css = (d) => Math.round(d / dpr);

  // from a point, out to the nearest edge each way: the space you're in
  function space(px, py) {
    const x = Math.min(DW - 1, dev(px)), y = Math.min(DH - 1, dev(py));
    const c = at(x, y);
    let l = x, r = x, t = y, b = y;
    while (l > 0 && same(at(l - 1, y), c)) l--;
    while (r < DW - 1 && same(at(r + 1, y), c)) r++;
    while (t > 0 && same(at(x, t - 1), c)) t--;
    while (b < DH - 1 && same(at(x, b + 1), c)) b++;
    return { l, r, t, b, x, y, w: css(r - l + 1), h: css(b - t + 1) };
  }

  // a loose box closes in on what's inside it (anything unlike its corner)
  function snap(box) {
    const x0 = dev(box.x), y0 = dev(box.y), x1 = Math.min(DW - 1, dev(box.x + box.w) - 1), y1 = Math.min(DH - 1, dev(box.y + box.h) - 1);
    const bg = at(x0, y0);
    let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (same(at(x, y), bg)) continue;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
    if (maxX < 0) return box;
    return { x: minX / dpr, y: minY / dpr, w: (maxX - minX + 1) / dpr, h: (maxY - minY + 1) / dpr };
  }

  // everything of one colour that's connected: a button's fill, a card's inside
  function element(px, py) {
    const sx = Math.min(DW - 1, dev(px)), sy = Math.min(DH - 1, dev(py));
    const c = at(sx, sy);
    const seen = new Uint8Array(DW * DH);
    const stack = [sy * DW + sx];
    seen[stack[0]] = 1;
    let minX = sx, maxX = sx, minY = sy, maxY = sy, n = 0;
    while (stack.length && n < 2e6) {
      const p = stack.pop(); n++;
      const x = p % DW, y = (p - x) / DW;
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
      for (const q of [p - 1, p + 1, p - DW, p + DW]) {
        if (q < 0 || q >= DW * DH || seen[q]) continue;
        if ((q === p - 1 && x === 0) || (q === p + 1 && x === DW - 1)) continue;
        seen[q] = 1;
        if (same(q * 4, c)) stack.push(q);
      }
    }
    return { x: minX / dpr, y: minY / dpr, w: (maxX - minX + 1) / dpr, h: (maxY - minY + 1) / dpr };
  }

  // ---------------------------------------------------------------------------
  // numbers, in the chosen format
  // ---------------------------------------------------------------------------
  const tw = (n) => (n % 4 === 0 ? String(n / 4) : n % 2 === 0 && n <= 16 ? String(n / 4) : `[${n}px]`);
  function fmtSize(w, h) {
    if (as === 'css') return `width: ${w}px; height: ${h}px;`;
    if (as === 'tailwind') return `w-${tw(w)} h-${tw(h)}`;
    return `${w} × ${h}`;
  }
  function fmtGap(n, axis) {
    if (as === 'css') return `${axis === 'x' ? 'column' : 'row'}-gap: ${n}px;`;
    if (as === 'tailwind') return `gap-${axis}-${tw(n)}`;
    return String(n);
  }
  function fmtPad(t, r, b, l) {
    const short = t === b && r === l ? (t === r ? [t] : [t, r]) : [t, r, b, l];
    if (as === 'css') return `padding: ${short.map((v) => v + 'px').join(' ')};`;
    if (as === 'tailwind') {
      if (t === b && r === l) return t === r ? `p-${tw(t)}` : `px-${tw(r)} py-${tw(t)}`;
      return `pt-${tw(t)} pr-${tw(r)} pb-${tw(b)} pl-${tw(l)}`;
    }
    return short.join(' ');
  }

  // what ctrl+c copies (drawn in white): the newest thing you made, or the live measure
  function current() {
    const rel = relation();
    if (rel) return rel.text;
    const last = marks[marks.length - 1];
    if (last && last.kind === 'box') return fmtSize(Math.round(last.w), Math.round(last.h));
    if (last && last.kind === 'space') return fmtSize(last.w, last.h);
    if (pointer) { const s = space(pointer.x, pointer.y); return fmtSize(s.w, s.h); }
    return null;
  }

  // the two newest boxes: their gap, or the padding when one is inside the other
  function relation() {
    const boxes = marks.filter((m) => m.kind === 'box');
    if (boxes.length < 2) return null;
    const a = boxes[boxes.length - 2], b = boxes[boxes.length - 1];
    const inside = (o, i) => i.x >= o.x - 0.5 && i.y >= o.y - 0.5 && i.x + i.w <= o.x + o.w + 0.5 && i.y + i.h <= o.y + o.h + 0.5;
    const R = Math.round;
    if (inside(a, b) || inside(b, a)) {
      const o = inside(a, b) ? a : b, i = o === a ? b : a;
      const t = R(i.y - o.y), r = R(o.x + o.w - i.x - i.w), bt = R(o.y + o.h - i.y - i.h), l = R(i.x - o.x);
      return { kind: 'pad', o, i, t, r, b: bt, l, text: fmtPad(t, r, bt, l) };
    }
    const gx = b.x >= a.x + a.w ? b.x - (a.x + a.w) : a.x >= b.x + b.w ? a.x - (b.x + b.w) : null;
    const gy = b.y >= a.y + a.h ? b.y - (a.y + a.h) : a.y >= b.y + b.h ? a.y - (b.y + b.h) : null;
    if (gx !== null && (gy === null || gx >= gy)) return { kind: 'gap', axis: 'x', a, b, n: R(gx), text: fmtGap(R(gx), 'x') };
    if (gy !== null) return { kind: 'gap', axis: 'y', a, b, n: R(gy), text: fmtGap(R(gy), 'y') };
    return null;
  }

  // ---------------------------------------------------------------------------
  // drawing (white, one screen pixel, with a dark halo)
  // ---------------------------------------------------------------------------
  const g = octx;
  function line(x1, y1, x2, y2) {
    // snap to device pixel centres so a line is exactly one pixel
    const s = (v) => (Math.round(v * dpr) + 0.5) / dpr;
    g.beginPath(); g.moveTo(s(x1), s(y1)); g.lineTo(s(x2), s(y2));
    g.lineWidth = 3 / dpr; g.strokeStyle = 'rgba(0,0,0,.55)'; g.stroke();
    g.lineWidth = 1 / dpr; g.strokeStyle = '#ffffff'; g.stroke();
  }
  function rectLine(b) { line(b.x, b.y, b.x + b.w, b.y); line(b.x, b.y + b.h, b.x + b.w, b.y + b.h); line(b.x, b.y, b.x, b.y + b.h); line(b.x + b.w, b.y, b.x + b.w, b.y + b.h); }
  const placed = [];
  function label(text, x, y, white) {
    g.font = '400 11px "DM Mono", ui-monospace, monospace';
    const w = Math.ceil(g.measureText(text).width) + 12, h = 19;
    let lx = Math.round(Math.max(2, Math.min(W - w - 2, x - w / 2))), ly = Math.round(Math.max(2, Math.min(H - h - 2, y - h / 2)));
    // never pile numbers on top of each other: move along
    for (let k = 0; k < 6 && placed.some((p) => lx < p.x + p.w && p.x < lx + w && ly < p.y + p.h && p.y < ly + h); k++) ly += h + 3;
    placed.push({ x: lx, y: ly, w, h });
    g.fillStyle = '#111111'; g.fillRect(lx, ly, w, h);
    g.strokeStyle = '#2a2a2a'; g.lineWidth = 1; g.strokeRect(lx + 0.5, ly + 0.5, w - 1, h - 1);
    g.fillStyle = white ? '#ffffff' : '#8a8a8a';
    g.textBaseline = 'middle';
    g.fillText(text, lx + 6, ly + h / 2 + 0.5);
  }
  const plain = (fn, ...args) => { const keep = as; as = 'plain'; const t = fn(...args); as = keep; return t; };

  function drawSpace(s, white) {
    const y = s.y / dpr, x = s.x / dpr, l = s.l / dpr, r = (s.r + 1) / dpr, t = s.t / dpr, b = (s.b + 1) / dpr;
    line(l, y, r, y); line(l, y - 4, l, y + 4); line(r, y - 4, r, y + 4);
    line(x, t, x, b); line(x - 4, t, x + 4, t); line(x - 4, b, x + 4, b);
    label(plain(fmtSize, s.w, s.h), x + 34, y + 22, white);
  }

  function draw() {
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    placed.length = 0;
    const rel = relation();
    marks.forEach((m, i) => {
      const newest = i === marks.length - 1 && !rel && !drag;
      if (m.kind === 'box') { rectLine(m); label(plain(fmtSize, Math.round(m.w), Math.round(m.h)), m.x + m.w / 2, m.y + m.h + 14, newest); }
      else drawSpace(m.s, newest);
    });
    if (rel && rel.kind === 'gap') {
      const { a, b } = rel;
      if (rel.axis === 'x') {
        const left = a.x < b.x ? a : b, right = left === a ? b : a;
        const y = (Math.max(a.y, b.y) + Math.min(a.y + a.h, b.y + b.h)) / 2 || (left.y + left.h / 2);
        line(left.x + left.w, y, right.x, y);
        label(String(rel.n), (left.x + left.w + right.x) / 2, y - 16, true);
      } else {
        const top = a.y < b.y ? a : b, bot = top === a ? b : a;
        const x = (Math.max(a.x, b.x) + Math.min(a.x + a.w, b.x + b.w)) / 2 || (top.x + top.w / 2);
        line(x, top.y + top.h, x, bot.y);
        label(String(rel.n), x + 24, (top.y + top.h + bot.y) / 2, true);
      }
    } else if (rel && rel.kind === 'pad') {
      const { o, i } = rel;
      const cx = i.x + i.w / 2, cy = i.y + i.h / 2;
      line(cx, o.y, cx, i.y); line(cx, i.y + i.h, cx, o.y + o.h);
      line(o.x, cy, i.x, cy); line(i.x + i.w, cy, o.x + o.w, cy);
      label(String(rel.t), cx + 16, (o.y + i.y) / 2, true);
      label(String(rel.b), cx + 16, (i.y + i.h + o.y + o.h) / 2, true);
      label(String(rel.l), (o.x + i.x) / 2, cy - 14, true);
      label(String(rel.r), (i.x + i.w + o.x + o.w) / 2, cy - 14, true);
    }
    if (drag) {
      const b = boxOf(drag);
      rectLine(b);
      label(plain(fmtSize, Math.round(b.w), Math.round(b.h)), b.x + b.w / 2, b.y + b.h + 14, true);
    } else if (pointer) {
      drawSpace(space(pointer.x, pointer.y), !marks.length);
    }
    if (pointer) {
      const { x, y } = pointer;
      line(x - 7, y, x - 2, y); line(x + 2, y, x + 7, y); line(x, y - 7, x, y - 2); line(x, y + 2, x, y + 7);
    }
  }

  const boxOf = (d) => ({ x: Math.min(d.x0, d.x1), y: Math.min(d.y0, d.y1), w: Math.abs(d.x1 - d.x0), h: Math.abs(d.y1 - d.y0) });

  // ---------------------------------------------------------------------------
  // input
  // ---------------------------------------------------------------------------
  const rel = (e) => { const r = desk.getBoundingClientRect(); return { x: Math.max(0, Math.min(W - 1, e.clientX - r.left)), y: Math.max(0, Math.min(H - 1, e.clientY - r.top)) }; };

  desk.addEventListener('pointermove', (e) => {
    pointer = rel(e);
    if (drag) { drag.x1 = pointer.x; drag.y1 = pointer.y; drag.moved = drag.moved || Math.hypot(drag.x1 - drag.x0, drag.y1 - drag.y0) > 3; }
    draw();
  });
  desk.addEventListener('pointerleave', () => { if (!drag) { pointer = null; draw(); } });
  desk.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    desk.focus({ preventScroll: true });
    try { desk.setPointerCapture(e.pointerId); } catch (_) {}
    const p = rel(e);
    pointer = p;
    drag = { x0: p.x, y0: p.y, x1: p.x, y1: p.y, alt: e.altKey, moved: false };
  });
  desk.addEventListener('pointerup', (e) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (d.moved) {
      let b = boxOf(d);
      if (!d.alt && !e.altKey) b = snap(b);
      marks.push({ kind: 'box', ...b });
    } else {
      // a click pins the space you're in (a double-click makes it an element instead)
      const p = { x: d.x0, y: d.y0 };
      clearTimeout(clickTimer);
      clickTimer = setTimeout(() => { const s = space(p.x, p.y); marks.push({ kind: 'space', s, w: s.w, h: s.h }); draw(); }, 220);
    }
    draw();
  });
  desk.addEventListener('dblclick', (e) => {
    clearTimeout(clickTimer);
    const p = rel(e);
    marks.push({ kind: 'box', ...element(p.x, p.y) });
    draw();
  });

  let toastTimer = null;
  function toast(text, dim) {
    toastEl.innerHTML = `${text}${dim ? `<span class="dim">${dim.replace(/</g, '&lt;')}</span>` : ''}`;
    toastEl.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('on'), 1800);
  }
  async function copy(text) {
    if (!text) return;
    try { await navigator.clipboard.writeText(text); toast('copied', text); } catch (_) { toast('could not copy', text); }
  }

  let over = false;
  desk.addEventListener('mouseenter', () => { over = true; });
  desk.addEventListener('mouseleave', () => { over = false; });
  document.addEventListener('keydown', (e) => {
    if (!over && document.activeElement !== desk) return;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === 'c') { e.preventDefault(); copy(current()); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (k === 'c' && pointer) {
      const i = at(Math.min(DW - 1, dev(pointer.x)), Math.min(DH - 1, dev(pointer.y)));
      copy('#' + [data[i], data[i + 1], data[i + 2]].map((v) => v.toString(16).padStart(2, '0')).join(''));
      e.preventDefault();
    } else if (e.key === 'Backspace') { marks.pop(); draw(); e.preventDefault(); }
    else if (e.key === 'Delete' || e.key === 'Escape') { marks.length = 0; draw(); e.preventDefault(); }
    else if (e.key === 'Enter') { copy(current()); e.preventDefault(); }
    else if (e.key.startsWith('Arrow') && pointer) {
      const n = e.shiftKey ? 10 : 1;
      pointer = {
        x: Math.max(0, Math.min(W - 1, pointer.x + (k === 'arrowright' ? n : k === 'arrowleft' ? -n : 0))),
        y: Math.max(0, Math.min(H - 1, pointer.y + (k === 'arrowdown' ? n : k === 'arrowup' ? -n : 0))),
      };
      draw();
      e.preventDefault();
    }
  });

  document.querySelectorAll('[data-as]').forEach((b) => b.addEventListener('click', () => {
    as = b.dataset.as;
    document.querySelectorAll('[data-as]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    const t = current();
    if (t) toast('copy as ' + as, t);
  }));

  let last = '';
  new ResizeObserver(() => {
    const r = desk.getBoundingClientRect();
    const key = `${Math.round(r.width)}x${Math.round(r.height)}@${window.devicePixelRatio}`;
    if (key === last) return;
    last = key;
    marks.length = 0;
    paint();
  }).observe(desk);
  // the label font may arrive after the first paint
  if (document.fonts) document.fonts.ready.then(draw);
})();
