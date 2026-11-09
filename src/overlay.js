'use strict';

// The capture overlay: one per display. Shows the frozen screen, dimmed;
// drag a rectangle and it lifts out. Release = snip. Click = whole screen.
//   shift   keep it square        space   move the selection while dragging
//   enter   whole screen          esc / right click   cancel
(() => {
  const api = window.snipr;
  const $ = (id) => document.getElementById(id);
  const canvas = $('shot'), ctx = canvas.getContext('2d', { alpha: false });
  const shade = $('shade'), sel = $('sel'), gx = $('gx'), gy = $('gy');
  const readout = $('readout'), hint = $('hint');

  const MIN = 4; // smaller than this is a click, not a drag
  let sid = null;        // capture session from main
  let scale = 1;         // device pixels per css pixel on this display
  let live = false;      // accepting input
  let start = null;      // drag origin
  let last = null;       // last pointer position
  let rect = null;       // current selection {x, y, width, height}
  let space = null;      // pointer position when space went down (moving the selection)
  let hintTimer = null;

  // --- drawing the frozen screen ------------------------------------------

  // main sends the raw BGRA bitmap: swap to RGBA and put it straight on the canvas
  function paint(bitmap, width, height) {
    canvas.width = width;
    canvas.height = height;
    const src = new Uint32Array(bitmap.buffer, bitmap.byteOffset, (bitmap.byteLength / 4) | 0);
    const img = ctx.createImageData(width, height);
    const dst = new Uint32Array(img.data.buffer);
    const n = Math.min(src.length, dst.length);
    for (let i = 0; i < n; i++) {
      const p = src[i];
      dst[i] = 0xff000000 | ((p & 0xff) << 16) | (p & 0xff00) | ((p >>> 16) & 0xff);
    }
    ctx.putImageData(img, 0, 0);
  }

  // --- selection ----------------------------------------------------------

  const clampX = (x) => Math.max(0, Math.min(innerWidth, x));
  const clampY = (y) => Math.max(0, Math.min(innerHeight, y));

  function computeRect(p, square) {
    let w = p.x - start.x, h = p.y - start.y;
    if (square) {
      const s = Math.max(Math.abs(w), Math.abs(h));
      w = Math.sign(w || 1) * s;
      h = Math.sign(h || 1) * s;
    }
    const x1 = clampX(Math.min(start.x, start.x + w)), x2 = clampX(Math.max(start.x, start.x + w));
    const y1 = clampY(Math.min(start.y, start.y + h)), y2 = clampY(Math.max(start.y, start.y + h));
    return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
  }

  const big = (r) => r && r.width >= MIN && r.height >= MIN;

  function render() {
    if (big(rect)) {
      sel.hidden = false;
      shade.hidden = true;
      Object.assign(sel.style, { left: rect.x + 'px', top: rect.y + 'px', width: rect.width + 'px', height: rect.height + 'px' });
      const w = Math.round(rect.width * scale), h = Math.round(rect.height * scale);
      readout.innerHTML = `${w} <span class="d">×</span> ${h}`;
      readout.hidden = false;
      placeReadout();
    } else {
      sel.hidden = true;
      shade.hidden = false;
      readout.hidden = true;
    }
  }

  // under the selection, right-aligned; inside it when there's no room below
  function placeReadout() {
    const rw = readout.offsetWidth, rh = readout.offsetHeight, gap = 10; // clear of the corner mark
    let x = rect.x + rect.width - rw;
    let y = rect.y + rect.height + gap;
    if (y + rh > innerHeight - 4) y = rect.y - rh - gap;
    if (y < 4) y = rect.y + rect.height - rh - gap;
    x = Math.max(4, Math.min(innerWidth - rw - 4, x));
    readout.style.left = x + 'px';
    readout.style.top = y + 'px';
  }

  function guides(p) {
    const show = p && !start;
    gx.hidden = gy.hidden = !show;
    if (show) {
      gx.style.left = Math.round(p.x) + 'px';
      gy.style.top = Math.round(p.y) + 'px';
    }
  }

  function hideHint() {
    clearTimeout(hintTimer);
    hint.classList.add('gone');
  }

  // --- finishing ----------------------------------------------------------

  function done(r) {
    if (!live) return;
    live = false;
    guides(null);
    api.overlayDone(sid, r);
  }
  const whole = () => ({ x: 0, y: 0, width: innerWidth, height: innerHeight });

  function cancel() {
    if (!live) return;
    live = false;
    api.overlayCancel();
  }

  function reset() {
    live = false;
    start = rect = last = space = null;
    sel.hidden = true;
    shade.hidden = false;
    readout.hidden = true;
    hint.hidden = true;
    guides(null);
    clearTimeout(hintTimer);
    ctx.fillStyle = '#111111';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  // --- input --------------------------------------------------------------

  const pt = (e) => ({ x: e.clientX, y: e.clientY });

  window.addEventListener('pointerdown', (e) => {
    if (!live) return;
    if (e.button === 2) { cancel(); return; }
    if (e.button !== 0) return;
    hideHint();
    start = pt(e);
    last = start;
    rect = null;
    try { document.body.setPointerCapture(e.pointerId); } catch (_) {}
    guides(null);
  });

  window.addEventListener('pointermove', (e) => {
    if (!live) return;
    const p = pt(e);
    if (start && space) {
      // space held: move the whole selection instead of resizing it
      const dx = p.x - last.x, dy = p.y - last.y;
      start = { x: start.x + dx, y: start.y + dy };
    }
    last = p;
    if (start) {
      rect = computeRect(p, e.shiftKey);
      render();
    } else {
      guides(p);
    }
  });

  window.addEventListener('pointerup', (e) => {
    if (!live || !start || e.button !== 0) return;
    const r = rect;
    start = null;
    if (big(r)) done(r);
    else done(whole());
  });

  window.addEventListener('contextmenu', (e) => e.preventDefault());

  window.addEventListener('keydown', (e) => {
    if (!live) return;
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    else if (e.key === 'Enter') { e.preventDefault(); done(big(rect) ? rect : whole()); }
    else if (e.code === 'Space') { e.preventDefault(); if (!space) space = last; }
    else if (e.key === 'Shift' && start && last) { rect = computeRect(last, true); render(); }
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') space = null;
    else if (e.key === 'Shift' && start && last) { rect = computeRect(last, false); render(); }
  });

  // leaving this display: its crosshair goes; the one you enter takes over
  document.documentElement.addEventListener('mouseleave', () => { if (!start) guides(null); });
  window.addEventListener('blur', () => { space = null; });

  // --- from main ----------------------------------------------------------

  api.onOverlayOpen((o) => {
    reset();
    sid = o.sid;
    scale = o.scale || 1;
    paint(o.bitmap, o.width, o.height);
    if (o.active) {
      guides(o.cursor);
      hint.hidden = false;
      hint.classList.remove('gone');
      hintTimer = setTimeout(hideHint, 2600);
    }
    live = true;
    requestAnimationFrame(() => requestAnimationFrame(() => api.overlayReady(sid)));
  });

  api.onOverlayReset(reset);
})();
