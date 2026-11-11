'use strict';

// The pick overlay: one per display. It shows the frozen screen as it was, at
// full color (no dimming: you're judging colors here). The pointer is a loupe:
// the pixels round it, magnified, the one in the middle ringed. Under it, the
// color as it will be copied.
//
//   click          copy it, and go          shift+click / shift+enter   copy it, keep picking
//   enter          copy the ringed pixel    arrows   move 1 px  (shift: 10 px)
//   scroll / + -   zoom                     tab      hex → rgb → hsl
//   esc / right click   cancel
(() => {
  const api = window.paletr;
  const Color = window.PaletrColor;
  const $ = (id) => document.getElementById(id);
  const shot = $('shot'), sctx = shot.getContext('2d', { alpha: false });
  const loupe = $('loupe'), lctx = loupe.getContext('2d', { alpha: false });
  const readout = $('readout'), chip = $('chip'), value = $('value'), note = $('note'), hint = $('hint');

  // cells across the loupe, and css px per cell; the loupe stays about 120 px
  const ZOOMS = [{ n: 21, c: 6 }, { n: 15, c: 8 }, { n: 11, c: 11 }, { n: 9, c: 14 }, { n: 7, c: 18 }];
  let zoom = 2;

  let sid = null;      // pick session from main
  let scale = 1;       // device pixels per css pixel on this display
  let W = 0, H = 0;    // the frozen screen, in device pixels
  let pixels = null;   // its RGBA bytes
  let live = false;    // accepting input
  let p = null;        // the ringed pixel {x, y} in device pixels; null = pointer not on this screen
  let fmt = 'hex';
  let down = null;     // which button went down on this overlay
  let frame = 0, noteTimer = null, hintTimer = null;

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // --- the frozen screen ----------------------------------------------------

  // main sends the raw BGRA bitmap: swap to RGBA and put it straight on the canvas
  function paint(bitmap, width, height) {
    W = shot.width = width;
    H = shot.height = height;
    const src = new Uint32Array(bitmap.buffer, bitmap.byteOffset, (bitmap.byteLength / 4) | 0);
    const img = sctx.createImageData(width, height);
    const dst = new Uint32Array(img.data.buffer);
    const n = Math.min(src.length, dst.length);
    for (let i = 0; i < n; i++) {
      const v = src[i];
      dst[i] = 0xff000000 | ((v & 0xff) << 16) | (v & 0xff00) | ((v >>> 16) & 0xff);
    }
    sctx.putImageData(img, 0, 0);
    pixels = img.data;
  }

  function colorAt(x, y) {
    const i = (y * W + x) * 4;
    return { r: pixels[i], g: pixels[i + 1], b: pixels[i + 2] };
  }

  // --- the loupe and its readout ----------------------------------------------

  const schedule = () => { if (!frame) frame = requestAnimationFrame(draw); };

  function draw() {
    frame = 0;
    if (!p || !pixels) { loupe.hidden = true; readout.hidden = true; return; }
    const z = ZOOMS[zoom];
    const cell = Math.max(2, Math.round(z.c * scale)); // device px per cell, so every cell is the same size
    const size = z.n * cell;
    const half = (z.n - 1) / 2;
    if (loupe.width !== size) loupe.width = loupe.height = size;
    const css = size / scale;
    loupe.style.width = loupe.style.height = css + 'px';

    lctx.imageSmoothingEnabled = false;
    lctx.fillStyle = '#111111';
    lctx.fillRect(0, 0, size, size);
    lctx.drawImage(shot, p.x - half, p.y - half, z.n, z.n, 0, 0, size, size);
    if (cell >= 8) {
      // a faint grid, grey so it reads on light and dark alike
      lctx.fillStyle = 'rgba(128, 128, 128, .2)';
      for (let i = 1; i < z.n; i++) {
        lctx.fillRect(i * cell, 0, 1, size);
        lctx.fillRect(0, i * cell, size, 1);
      }
    }
    const c = colorAt(p.x, p.y);
    const lw = Math.max(1, Math.round(scale));
    lctx.strokeStyle = Color.light(c) > 0.55 ? '#111111' : '#ffffff';
    lctx.lineWidth = lw;
    const o = half * cell;
    lctx.strokeRect(o - lw / 2, o - lw / 2, cell + lw, cell + lw);

    // the loupe sits centred on the pixel: it is the pointer
    const cx = (p.x + 0.5) / scale, cy = (p.y + 0.5) / scale;
    loupe.style.left = Math.round(cx - css / 2) + 'px';
    loupe.style.top = Math.round(cy - css / 2) + 'px';
    loupe.hidden = false;

    chip.style.background = Color.hex(c);
    value.textContent = Color.format(c, fmt);
    readout.hidden = false;
    const rw = readout.offsetWidth, rh = readout.offsetHeight, gap = 10;
    let y = cy + css / 2 + gap;
    if (y + rh > innerHeight - 4) y = cy - css / 2 - gap - rh;
    readout.style.left = Math.round(clamp(cx - rw / 2, 4, innerWidth - rw - 4)) + 'px';
    readout.style.top = Math.round(y) + 'px';
  }

  function flash(text) {
    clearTimeout(noteTimer);
    note.textContent = text;
    readout.classList.add('noted');
    noteTimer = setTimeout(() => { note.textContent = ''; readout.classList.remove('noted'); schedule(); }, 900);
    schedule();
  }

  function hideHint() {
    clearTimeout(hintTimer);
    hint.classList.add('gone');
  }

  // --- picking ----------------------------------------------------------------

  function pickNow(keep) {
    if (!live || !p) return;
    hideHint();
    if (!keep) live = false;
    api.overlayPick(sid, { x: p.x, y: p.y }, keep);
  }

  function cancel() {
    if (!live) return;
    live = false;
    api.overlayCancel();
  }

  function setZoom(dir) {
    zoom = clamp(zoom + dir, 0, ZOOMS.length - 1);
    schedule();
  }

  function cycleFormat(dir) {
    const all = Color.FORMATS;
    fmt = all[(all.indexOf(fmt) + dir + all.length) % all.length];
    api.overlayFormat(fmt);
    flash(fmt);
  }

  function reset() {
    live = false;
    p = null;
    pixels = null;
    down = null;
    clearTimeout(noteTimer);
    clearTimeout(hintTimer);
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    note.textContent = '';
    readout.classList.remove('noted');
    loupe.hidden = readout.hidden = hint.hidden = true;
    shot.width = shot.height = 1; // let go of the frozen screen
    sctx.fillStyle = '#111111';
    sctx.fillRect(0, 0, 1, 1);
  }

  // --- input --------------------------------------------------------------------

  const at = (e) => ({ x: clamp(Math.floor(e.clientX * scale), 0, W - 1), y: clamp(Math.floor(e.clientY * scale), 0, H - 1) });

  window.addEventListener('pointermove', (e) => {
    if (!live) return;
    p = at(e);
    schedule();
  });

  // Acted on when the button comes up, so the release never lands in the
  // program underneath once the overlay is gone.
  window.addEventListener('pointerdown', (e) => {
    if (!live) return;
    hideHint();
    down = e.button;
    if (!p && e.button === 0) { p = at(e); schedule(); }
  });
  window.addEventListener('pointerup', (e) => {
    if (!live || down !== e.button) return;
    down = null;
    if (e.button === 0) pickNow(e.shiftKey);
    else if (e.button === 2) cancel();
  });
  window.addEventListener('contextmenu', (e) => e.preventDefault());

  window.addEventListener('wheel', (e) => {
    if (!live || !e.deltaY) return;
    setZoom(e.deltaY < 0 ? 1 : -1);
  }, { passive: true });

  const NUDGE = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

  window.addEventListener('keydown', (e) => {
    if (!live) return;
    if (e.key === 'Escape') { e.preventDefault(); cancel(); return; }
    if (e.key === 'Enter') { e.preventDefault(); pickNow(e.shiftKey); return; }
    if (e.key === 'Tab') { e.preventDefault(); hideHint(); cycleFormat(e.shiftKey ? -1 : 1); return; }
    if (e.key === '+' || e.key === '=') { e.preventDefault(); setZoom(1); return; }
    if (e.key === '-' || e.key === '_') { e.preventDefault(); setZoom(-1); return; }
    const d = NUDGE[e.key];
    if (d) {
      e.preventDefault();
      hideHint();
      const step = e.shiftKey ? 10 : 1;
      if (!p) p = { x: Math.floor(W / 2), y: Math.floor(H / 2) };
      p = { x: clamp(p.x + d[0] * step, 0, W - 1), y: clamp(p.y + d[1] * step, 0, H - 1) };
      schedule();
    }
  });

  // the loupe follows the pointer from screen to screen, and so do the keys
  document.documentElement.addEventListener('mouseenter', () => { if (live) api.overlayFocus(); });
  document.documentElement.addEventListener('mouseleave', () => { if (live) { p = null; schedule(); } });

  // --- from main ------------------------------------------------------------------

  api.onOverlayOpen((o) => {
    reset();
    sid = o.sid;
    scale = o.scale || 1;
    fmt = Color.FORMATS.includes(o.format) ? o.format : 'hex';
    paint(o.bitmap, o.width, o.height);
    if (o.active && o.cursor) {
      const x = Math.floor(o.cursor.x * scale), y = Math.floor(o.cursor.y * scale);
      if (x >= 0 && y >= 0 && x < W && y < H) p = { x, y };
      hint.hidden = false;
      hint.classList.remove('gone');
      hintTimer = setTimeout(hideHint, 2600);
    }
    live = true;
    draw();
    requestAnimationFrame(() => requestAnimationFrame(() => api.overlayReady(sid)));
  });

  api.onOverlayPicked(() => flash('copied'));
  api.onOverlayFormat((f) => { if (Color.FORMATS.includes(f)) { fmt = f; schedule(); } });
  api.onOverlayReset(reset);
})();
