'use strict';

// A snip: the capture in its own ghost window. At rest it is just the image.
// Hover for the chrome: tools on the left, copy / save / settings / close on
// the right, size and messages in the status line.
//
//   p pen   a arrow   b box   t text   x blur   v / esc  hand (drag the snip out)
//   ctrl+c copy   ctrl+s save   ctrl+shift+s save as   ctrl+z undo   ctrl+y redo
//   ctrl+n new snip   esc / ctrl+w close
(async () => {
  const api = window.snipr;
  const $ = (id) => document.getElementById(id);
  const body = document.body;
  const stage = $('stage'), canvas = $('canvas'), ctx = canvas.getContext('2d');
  const stLeft = $('st-left'), stRight = $('st-right');
  const menuEl = $('menu'), ctxEl = $('ctx'), confirmEl = $('confirm');
  const gear = $('btn-settings');

  // annotation inks. ghost: white with a dark halo, so it reads on anything
  const INK = {
    ghost: { color: '#ffffff', halo: 'rgba(0, 0, 0, .55)' },
    red: { color: '#ff7a6b', halo: 'rgba(0, 0, 0, .35)' },
    black: { color: '#111111', halo: 'rgba(255, 255, 255, .6)' },
  };
  const TOOL_KEYS = { KeyP: 'pen', KeyA: 'arrow', KeyB: 'box', KeyC: 'circle', KeyT: 'text', KeyX: 'blur', KeyV: 'none' };
  const Fonts = window.SniprFonts;
  const LINE = 1.25;         // text line height, in font sizes
  const DEFAULT_TEXT = 15;   // text size for a click without a box (logical px)
  const fontStack = (f) => `"${f || Fonts.DEFAULT}", monospace`;

  const init = await api.snipInit();
  if (!init) return;
  let S = init.settings;
  const W = init.width, H = init.height, scale = init.scale || 1;

  const base = await loadImage(init.png);
  canvas.width = W;
  canvas.height = H;
  const committed = document.createElement('canvas');
  committed.width = W;
  committed.height = H;
  const cctx = committed.getContext('2d');

  let shapes = [];      // committed marks, in image pixels
  let undone = [];      // for redo
  let current = null;   // the mark being drawn
  let tool = 'none';
  let dirty = false;    // marks not yet copied / saved / dragged out
  let version = 0;      // bumps on every change; the png cache follows it
  let cache = { v: -1, bytes: null };
  let view = 1;         // css size / natural (logical) size
  let textEl = null;

  // fonts load on demand; text marks redraw once theirs is ready
  const loadFont = async (f) => { try { await document.fonts.load(`400 16px ${fontStack(f)}`); } catch (_) {} };
  await loadFont(S.font);

  function loadImage(png) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(new Blob([png], { type: 'image/png' }));
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = reject;
      img.src = url;
    });
  }

  // --- layout -------------------------------------------------------------

  function layout() {
    const lw = W / scale, lh = H / scale;
    view = Math.min(1, stage.clientWidth / lw, stage.clientHeight / lh);
    canvas.style.width = Math.max(1, Math.round(lw * view)) + 'px';
    canvas.style.height = Math.max(1, Math.round(lh * view)) + 'px';
    if (textEl) commitText(); // the editor was placed for the old size
    status();
  }
  new ResizeObserver(layout).observe(stage);

  // --- status line ----------------------------------------------------------

  let msg = null, msgTimer = null;
  function status() {
    stLeft.textContent = `${W} × ${H}`;
    stRight.textContent = msg || (view < 0.995 ? Math.round(view * 100) + '%' : '');
    stRight.className = 'st-right' + (msg ? ' st-msg' : '');
  }
  function flash(text, ms = 1600) {
    clearTimeout(msgTimer);
    msg = text;
    body.classList.add('flash');
    status();
    msgTimer = setTimeout(() => { msg = null; body.classList.remove('flash'); status(); }, ms);
  }

  // --- drawing ------------------------------------------------------------

  const lineW = () => 3 * scale;
  const ink = (s) => INK[s.ink] || INK.ghost;

  // every mark is drawn twice: a wider halo, then the ink on top
  function stroke(c, s, width, path, { cap = 'butt', join = 'miter' } = {}) {
    const I = ink(s);
    c.save();
    path(c);
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.strokeStyle = I.halo;
    c.lineWidth = width + 3 * scale;
    c.stroke();
    c.lineCap = cap;
    c.lineJoin = join;
    c.strokeStyle = I.color;
    c.lineWidth = width;
    c.stroke();
    c.restore();
  }

  const norm = (a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) });

  // Blur that can't be undone. A plain mosaic keeps one average per block, and
  // those averages are enough to guess text back (render candidates, mosaic
  // them the same way, compare: what Depix does). So no block here is computed
  // from what's under it. The whole area gets ONE colour, its overall average,
  // and each block is that colour shifted by random noise. The only thing left
  // of the content is that single average; the block pattern is pure chance.
  //
  // Noise: 64 KB from crypto.getRandomValues (the OS's secure random source),
  // drawn once per blur mark and kept with it, so the mark looks the same on
  // every redraw (undo, redo, resize) and doesn't flicker while you drag.
  const NOISE_SIDE = 256;          // noise table: 256 × 256 blocks, one byte each
  const NOISE_AMP = 14;            // ± brightness per block, out of 255
  const makeNoise = () => crypto.getRandomValues(new Uint8Array(NOISE_SIDE * NOISE_SIDE));

  function pixelate(c, r, noise) {
    const x = Math.max(0, Math.floor(r.x)), y = Math.max(0, Math.floor(r.y));
    const w = Math.min(W - x, Math.ceil(r.w)), h = Math.min(H - y, Math.ceil(r.h));
    if (w < 1 || h < 1 || !noise) return;
    const b = Math.max(6, Math.round(9 * scale));
    const img = c.getImageData(x, y, w, h);
    const d = img.data;
    // one average for the whole area
    let r0 = 0, g0 = 0, b0 = 0;
    for (let i = 0; i < d.length; i += 4) { r0 += d[i]; g0 += d[i + 1]; b0 += d[i + 2]; }
    const n = w * h;
    r0 /= n; g0 /= n; b0 /= n;
    const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);
    // every pixel of the area is overwritten: blocks of that colour ± noise
    for (let by = 0, row = 0; by < h; by += b, row++) {
      for (let bx = 0, col = 0; bx < w; bx += b, col++) {
        const k = ((noise[(row % NOISE_SIDE) * NOISE_SIDE + (col % NOISE_SIDE)] / 255) * 2 - 1) * NOISE_AMP;
        const R = clamp(r0 + k), G = clamp(g0 + k), B = clamp(b0 + k);
        const bw = Math.min(b, w - bx), bh = Math.min(b, h - by);
        for (let yy = 0; yy < bh; yy++) {
          let i = ((by + yy) * w + bx) * 4;
          for (let xx = 0; xx < bw; xx++, i += 4) { d[i] = R; d[i + 1] = G; d[i + 2] = B; d[i + 3] = 255; }
        }
      }
    }
    c.putImageData(img, x, y);
  }

  function drawText(c, s) {
    const I = ink(s);
    const lh = s.size * LINE;
    c.save();
    c.font = `400 ${s.size}px ${fontStack(s.font)}`;
    // place each line the way css does: the font's ascent + descent, centred in the line box
    c.textBaseline = 'alphabetic';
    // (css rounds the font's ascent and descent to whole css pixels, so do the same here)
    const fm = c.measureText('Hg');
    const px = s.px || scale;                    // image pixels per css pixel when it was typed
    const asc = Math.round(fm.fontBoundingBoxAscent / px) * px;
    const desc = Math.round(fm.fontBoundingBoxDescent / px) * px;
    const base = Math.floor((lh - (asc + desc)) / 2 / px) * px + asc;
    c.fillStyle = I.color;
    c.shadowColor = I.halo;
    // the same soft glow the editor shows while you type (text-shadow 2px + 1px),
    // so placing the text changes nothing
    s.lines.forEach((line, i) => {
      const y = s.y + i * lh + base;
      c.shadowBlur = 2 * px;
      c.fillText(line, s.x, y);
      c.shadowBlur = 1 * px;
      c.fillText(line, s.x, y);
    });
    c.restore();
  }

  function drawShape(c, s) {
    if (s.type === 'pen') {
      stroke(c, s, s.w, (k) => {
        const p = s.pts;
        k.beginPath();
        k.moveTo(p[0].x, p[0].y);
        if (p.length === 1) k.lineTo(p[0].x + 0.01, p[0].y);
        for (let i = 1; i < p.length - 1; i++) {
          const mx = (p[i].x + p[i + 1].x) / 2, my = (p[i].y + p[i + 1].y) / 2;
          k.quadraticCurveTo(p[i].x, p[i].y, mx, my);
        }
        if (p.length > 1) k.lineTo(p[p.length - 1].x, p[p.length - 1].y);
      }, { cap: 'round', join: 'round' });
    } else if (s.type === 'arrow') {
      const { a, b } = s;
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const head = Math.min(len * 0.6, Math.max(12 * scale, s.w * 4.5));
      const h1 = { x: b.x - head * Math.cos(ang - 0.5), y: b.y - head * Math.sin(ang - 0.5) };
      const h2 = { x: b.x - head * Math.cos(ang + 0.5), y: b.y - head * Math.sin(ang + 0.5) };
      stroke(c, s, s.w, (k) => {
        k.beginPath();
        k.moveTo(a.x, a.y);
        k.lineTo(b.x, b.y);
        k.moveTo(h1.x, h1.y);
        k.lineTo(b.x, b.y);
        k.lineTo(h2.x, h2.y);
      }, { cap: 'square' });
    } else if (s.type === 'box') {
      const r = norm(s.a, s.b);
      stroke(c, s, s.w, (k) => { k.beginPath(); k.rect(r.x, r.y, r.w, r.h); });
    } else if (s.type === 'circle') {
      const r = norm(s.a, s.b);
      stroke(c, s, s.w, (k) => {
        k.beginPath();
        k.ellipse(r.x + r.w / 2, r.y + r.h / 2, Math.max(0.5, r.w / 2), Math.max(0.5, r.h / 2), 0, 0, Math.PI * 2);
      });
    } else if (s.type === 'textbox') {
      // the box you drag for text, before you type: a faint dashed frame
      const r = norm(s.a, s.b);
      c.save();
      c.setLineDash([4 * scale, 3 * scale]);
      c.lineWidth = Math.max(1, scale);
      c.strokeStyle = 'rgba(255, 255, 255, .7)';
      c.strokeRect(r.x + 0.5, r.y + 0.5, r.w, r.h);
      c.restore();
    } else if (s.type === 'blur') {
      pixelate(c, norm(s.a, s.b), s.noise);
    } else if (s.type === 'text') {
      drawText(c, s);
    }
  }

  function rebuild() {
    cctx.clearRect(0, 0, W, H);
    cctx.drawImage(base, 0, 0, W, H);
    for (const s of shapes) drawShape(cctx, s);
    render();
  }

  function render() {
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(committed, 0, 0);
    if (current) drawShape(ctx, current);
  }

  function changed() {
    version += 1;
    dirty = shapes.length > 0;
    rebuild();
    exportSoon();
  }

  function commit(s) {
    shapes.push(s);
    undone = [];
    changed();
  }
  function undo() {
    if (!shapes.length) return;
    undone.push(shapes.pop());
    changed();
  }
  function redo() {
    if (!undone.length) return;
    shapes.push(undone.pop());
    changed();
  }

  // --- png export (cached, so drag-out can be immediate) -------------------

  let exportTimer = null;
  function exportSoon() {
    clearTimeout(exportTimer);
    exportTimer = setTimeout(() => { png(); }, 250);
  }

  // null = unmarked: main uses the original capture as it is
  async function png() {
    if (!shapes.length) return null;
    if (cache.v === version) return cache.bytes;
    const v = version;
    const blob = await new Promise((res) => committed.toBlob(res, 'image/png'));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (v === version) cache = { v, bytes };
    return bytes;
  }

  function pngNow() {
    if (!shapes.length) return null;
    if (cache.v === version) return cache.bytes;
    const b64 = committed.toDataURL('image/png').split(',')[1];
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    cache = { v: version, bytes };
    return bytes;
  }

  // --- actions ------------------------------------------------------------

  async function copy() {
    commitText();
    await api.copy(await png());
    dirty = false;
    flash('copied');
    if (S.closeAfterCopy) setTimeout(() => api.closeSnip(), 350); // long enough to see "copied"
  }

  async function save(ask) {
    commitText();
    const r = await api.save(await png(), ask);
    if (!r) return;
    if (r.error) { flash('could not save', 2400); return; }
    dirty = false;
    flash('saved');
  }

  function requestClose() {
    commitText();
    if (dirty && S.confirmDiscard) { showConfirm(true); return; }
    api.closeSnip();
  }

  function setTool(t) {
    commitText();
    tool = t === tool ? 'none' : t;
    body.dataset.tool = tool;
    canvas.draggable = tool === 'none';
    for (const b of document.querySelectorAll('[data-tool]')) {
      if (b.tagName === 'BUTTON') b.classList.toggle('on', b.dataset.tool === tool);
    }
  }

  // --- pointer: drawing, or (hand tool) dragging the snip out ---------------

  function toImg(e) {
    const r = canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(W, (e.clientX - r.left) * (W / r.width))),
      y: Math.max(0, Math.min(H, (e.clientY - r.top) * (H / r.height))),
    };
  }

  // shift: arrows snap to 45°, boxes go square
  function constrain(s, p, shift) {
    if (!shift) return p;
    const dx = p.x - s.a.x, dy = p.y - s.a.y;
    if (s.type === 'arrow') {
      const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      const len = Math.hypot(dx, dy);
      return { x: s.a.x + Math.cos(ang) * len, y: s.a.y + Math.sin(ang) * len };
    }
    if (s.type === 'box' || s.type === 'blur' || s.type === 'circle') {
      const m = Math.max(Math.abs(dx), Math.abs(dy));
      return { x: s.a.x + Math.sign(dx || 1) * m, y: s.a.y + Math.sign(dy || 1) * m };
    }
    return p;
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    closeMenus();
    if (tool === 'none') return; // the native drag takes it from here
    e.preventDefault();
    commitText();
    canvas.setPointerCapture(e.pointerId);
    const p = toImg(e);
    // text starts as a box you drag: its height sets the size of the letters
    current = { type: tool === 'text' ? 'textbox' : tool, ink: S.ink, w: lineW(), a: p, b: p, pts: [p] };
    if (tool === 'blur') current.noise = makeNoise();
    render();
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!current) return;
    const p = toImg(e);
    if (current.type === 'pen') {
      const last = current.pts[current.pts.length - 1];
      if (Math.hypot(p.x - last.x, p.y - last.y) >= 1.5 * scale) current.pts.push(p);
    } else {
      current.b = constrain(current, p, e.shiftKey);
    }
    render();
  });

  const finish = () => {
    if (!current) return;
    const s = current;
    current = null;
    const r = norm(s.a, s.b);
    if (s.type === 'textbox') {
      render();
      const boxed = r.w > 8 * scale && r.h > 8 * scale; // a click gives the default size
      startText(r.x, r.y, boxed ? Math.max(8 * scale, r.h / LINE) : DEFAULT_TEXT * scale, boxed ? r : null);
      return;
    }
    const real = s.type === 'pen' ? true : s.type === 'arrow' ? Math.hypot(r.w, r.h) > 4 * scale : r.w > 3 && r.h > 3;
    if (real) {
      if (s.type !== 'pen') delete s.pts;
      commit(s);
    } else render();
  };
  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', finish);

  canvas.addEventListener('dragstart', (e) => {
    e.preventDefault();
    if (tool !== 'none') return;
    api.startDrag(pngNow());
    dirty = false;
  });

  // --- text ---------------------------------------------------------------

  // x, y, size in image pixels; box = the dragged box (the editor fills it)
  function startText(x, y, size, box) {
    commitText();
    const p = { x, y };
    const r = canvas.getBoundingClientRect(), sr = stage.getBoundingClientRect();
    const k = r.width / W; // css px per image px
    const I = INK[S.ink] || INK.ghost;
    const el = document.createElement('div');
    el.className = 'text-input';
    el.contentEditable = 'plaintext-only';
    el.spellcheck = false;
    // the editor sits in a layer exactly over the image that clips it, so text
    // you keep typing disappears behind the image's edge, like the drawn text will
    const layer = document.createElement('div');
    layer.className = 'text-layer';
    Object.assign(layer.style, { left: r.left - sr.left + 'px', top: r.top - sr.top + 'px', width: r.width + 'px', height: r.height + 'px' });
    layer.addEventListener('scroll', () => { layer.scrollLeft = 0; layer.scrollTop = 0; }); // never follow the caret
    Object.assign(el.style, {
      left: p.x * k + 'px',
      top: p.y * k + 'px',
      fontSize: size * k + 'px',
      color: I.color,
      textShadow: `0 0 2px ${I.halo}, 0 0 1px ${I.halo}`,
      caretColor: I.color,
      fontFamily: fontStack(S.font),
      lineHeight: String(LINE),
      minWidth: box ? box.w * k + 'px' : '',
      minHeight: box ? box.h * k + 'px' : '',
    });
    el.dataset.font = S.font;
    el.dataset.x = p.x;
    el.dataset.y = p.y;
    el.dataset.size = size;
    el.dataset.ink = S.ink;
    el.dataset.px = 1 / k;
    el.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); commitText(); }
      else if (ev.key === 'Escape') { ev.preventDefault(); cancelText(); }
    });
    el.addEventListener('blur', () => setTimeout(commitText, 0));
    layer.appendChild(el);
    stage.appendChild(layer);
    textEl = el;
    setTimeout(() => el.focus(), 0);
  }

  function cancelText() {
    if (!textEl) return;
    const el = textEl;
    textEl = null;
    (el.parentElement || el).remove();
  }

  function commitText() {
    if (!textEl) return;
    const el = textEl;
    textEl = null;
    const text = el.innerText.replace(/\n+$/, '');
    (el.parentElement || el).remove(); // the clipping layer goes with it
    if (!text.trim()) return;
    const s = { type: 'text', ink: el.dataset.ink, font: el.dataset.font, x: +el.dataset.x, y: +el.dataset.y, size: +el.dataset.size, px: +el.dataset.px, lines: text.split('\n') };
    loadFont(s.font).then(() => commit(s));
  }

  // --- menus: gear (settings) and right click (actions) ---------------------

  const settingsMenu = window.SniprMenu.create({ el: menuEl, api, onClose: () => closeMenus() });
  settingsMenu.set(S);

  function place(el, x, y) {
    el.style.left = Math.max(6, Math.min(innerWidth - el.offsetWidth - 6, x)) + 'px';
    el.style.top = Math.max(6, Math.min(innerHeight - el.offsetHeight - 6, y)) + 'px';
    el.style.maxHeight = Math.max(60, innerHeight - 12) + 'px';
  }

  function openSettings() {
    closeMenus();
    settingsMenu.reset();
    menuEl.hidden = false;
    gear.setAttribute('aria-expanded', 'true');
    Ghost.menuOpen(true);
    placeSettings();
  }

  // just under the bar, right-aligned with a 6px gap (like notr); again on every resize
  function placeSettings() {
    const top = document.querySelector('.bar').getBoundingClientRect().bottom + 2;
    menuEl.style.maxHeight = Math.max(60, innerHeight - top - 6) + 'px';
    menuEl.style.top = top + 'px';
    menuEl.style.left = Math.max(6, innerWidth - menuEl.offsetWidth - 6) + 'px';
  }

  const ctxRow = (act, label, right = '', { disabled = false, danger = false } = {}) =>
    `<button class="mi${danger ? ' danger' : ''}" role="menuitem" data-act="${act}"${disabled ? ' disabled' : ''}>` +
    `<span class="mi-l"><span class="mi-mark"></span>${label}</span><span class="mi-r">${right}</span></button>`;

  function openContext(x, y) {
    closeMenus();
    ctxEl.innerHTML =
      ctxRow('copy', 'copy', 'ctrl+c') +
      ctxRow('save', 'save', 'ctrl+s') +
      ctxRow('saveAs', 'save as…', 'ctrl+shift+s') +
      '<div class="sep"></div>' +
      ctxRow('undo', 'undo', 'ctrl+z', { disabled: !shapes.length }) +
      ctxRow('redo', 'redo', 'ctrl+y', { disabled: !undone.length }) +
      ctxRow('clear', 'clear marks', '', { disabled: !shapes.length }) +
      '<div class="sep"></div>' +
      ctxRow('new', 'new snip', 'ctrl+n') +
      ctxRow('folder', 'open folder') +
      '<div class="sep"></div>' +
      ctxRow('close', dirty ? 'discard' : 'close', 'esc', { danger: dirty });
    ctxEl.hidden = false;
    Ghost.menuOpen(true);
    place(ctxEl, x, y);
  }

  ctxEl.addEventListener('mousedown', (e) => e.preventDefault());
  ctxEl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b || b.disabled) return;
    closeMenus();
    const a = b.dataset.act;
    if (a === 'copy') copy();
    else if (a === 'save') save(false);
    else if (a === 'saveAs') save(true);
    else if (a === 'undo') undo();
    else if (a === 'redo') redo();
    else if (a === 'clear') { undone = shapes.reverse(); shapes = []; changed(); }
    else if (a === 'new') api.newSnip();
    else if (a === 'folder') api.openFolder();
    else if (a === 'close') requestClose();
  });

  function closeMenus() {
    const was = !menuEl.hidden || !ctxEl.hidden;
    if (!menuEl.hidden) settingsMenu.reset();
    menuEl.hidden = true;
    ctxEl.hidden = true;
    gear.setAttribute('aria-expanded', 'false');
    Ghost.menuOpen(false);
    return was;
  }

  gear.addEventListener('click', () => (menuEl.hidden ? openSettings() : closeMenus()));
  document.addEventListener('mousedown', (e) => {
    if (!menuEl.hidden && !menuEl.contains(e.target) && !gear.contains(e.target)) closeMenus();
    if (!ctxEl.hidden && !ctxEl.contains(e.target)) closeMenus();
  });
  window.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const t = e.target instanceof Element ? e.target : null;
    if ((t && t.closest('.bar')) || textEl) return;
    openContext(e.clientX, e.clientY);
  });

  // --- confirm strip --------------------------------------------------------

  function showConfirm(on) {
    confirmEl.hidden = !on;
    if (on) { closeMenus(); Ghost.menuOpen(true); } else Ghost.menuOpen(false);
  }
  $('confirm-yes').addEventListener('click', () => { showConfirm(false); api.closeSnip(); });
  $('confirm-no').addEventListener('click', () => showConfirm(false));
  $('confirm-dont').addEventListener('click', () => { api.setSettings({ confirmDiscard: false }); showConfirm(false); api.closeSnip(); });

  // --- bar buttons ------------------------------------------------------------

  for (const b of document.querySelectorAll('button[data-tool]')) {
    b.addEventListener('click', () => setTool(b.dataset.tool));
  }
  $('btn-copy').addEventListener('click', copy);
  $('btn-save').addEventListener('click', (e) => save(e.shiftKey));
  $('btn-close').addEventListener('click', requestClose);

  // --- keys ---------------------------------------------------------------

  document.addEventListener('keydown', (e) => {
    if (textEl) return;
    if (!menuEl.hidden && settingsMenu.handleKey(e)) return;

    if (!confirmEl.hidden) {
      e.preventDefault();
      if (e.key === 'y' || e.key === 'Enter') $('confirm-yes').click();
      else if (e.key === 'n' || e.key === 'Escape') $('confirm-no').click();
      else if (e.key === 'd') $('confirm-dont').click();
      return;
    }

    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Escape') {
      e.preventDefault();
      if (closeMenus()) return;
      if (current) { current = null; render(); return; }
      if (tool !== 'none') { setTool('none'); return; }
      requestClose();
      return;
    }
    if (mod && !e.altKey) {
      const c = e.code;
      if (c === 'KeyC') { e.preventDefault(); copy(); }
      else if (c === 'KeyS') { e.preventDefault(); save(e.shiftKey); }
      else if (c === 'KeyZ') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
      else if (c === 'KeyY') { e.preventDefault(); redo(); }
      else if (c === 'KeyW') { e.preventDefault(); requestClose(); }
      else if (c === 'KeyN') { e.preventDefault(); api.newSnip(); }
      return;
    }
    if (!e.altKey && !e.shiftKey && TOOL_KEYS[e.code]) {
      e.preventDefault();
      setTool(TOOL_KEYS[e.code]);
    }
  });

  // --- start --------------------------------------------------------------

  api.onSettings((s) => { S = s; settingsMenu.set(s); loadFont(s.font); if (!menuEl.hidden) placeSettings(); });

  window.addEventListener('resize', () => {
    if (!menuEl.hidden) placeSettings();
    if (!ctxEl.hidden) place(ctxEl, parseFloat(ctxEl.style.left) || 0, parseFloat(ctxEl.style.top) || 0);
  });

  // buttons never take focus from a click: no focus ring, and space / enter
  // can't re-press the last button you clicked
  document.addEventListener('mousedown', (e) => {
    if (e.target instanceof Element && e.target.closest('button')) e.preventDefault();
  });

  rebuild();
  layout();
  if (init.done && init.done.length) flash(init.done.join(' · '), 1800);
})();
