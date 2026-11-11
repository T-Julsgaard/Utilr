'use strict';
// paletr in the browser: a loupe over a picture drawn on a canvas. The color is
// read from the canvas's own pixels (device px, never a blend), and a click
// really copies it.
(() => {
  const $ = (id) => document.getElementById(id);
  const desk = $('desk'), scr = $('screen'), loupe = $('loupe'), lc = $('lc'), chip = $('chip');
  const sw = $('sw'), pcount = $('pcount'), fmtLabel = $('fmtlabel'), toastEl = $('toast');
  const sctx = scr.getContext('2d', { willReadFrequently: true });
  const lctx = lc.getContext('2d');
  const FORMATS = ['hex', 'rgb', 'hsl'];
  let fmt = 'hex';
  let across = 11;                 // pixels across the loupe: 7 to 21, odd
  let dpr = 1, W = 0, H = 0, DW = 0, DH = 0, data = null;
  let at = null;                   // the ringed pixel, device px
  let palette = [];

  // ---------------------------------------------------------------------------
  // the picture: a sky, hills, a sun, a few swatches and some type
  // ---------------------------------------------------------------------------
  function paint() {
    const r = desk.getBoundingClientRect();
    dpr = window.devicePixelRatio || 1;
    W = Math.round(r.width); H = Math.round(r.height);
    DW = Math.round(W * dpr); DH = Math.round(H * dpr);
    scr.width = DW; scr.height = DH; scr.style.width = W + 'px'; scr.style.height = H + 'px';
    const g = sctx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const sky = g.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, '#1d2b64'); sky.addColorStop(0.55, '#f8a978'); sky.addColorStop(1, '#f6d365');
    g.fillStyle = sky; g.fillRect(0, 0, W, H);
    g.fillStyle = '#ffd56b'; g.beginPath(); g.arc(W * 0.28, H * 0.52, Math.min(W, H) * 0.12, 0, Math.PI * 2); g.fill();
    const hill = (y, amp, col, ph) => {
      g.fillStyle = col; g.beginPath(); g.moveTo(0, H);
      for (let x = 0; x <= W; x += 8) g.lineTo(x, y + Math.sin(x / (W / 5) + ph) * amp + Math.sin(x / 47 + ph * 2) * amp * 0.25);
      g.lineTo(W, H); g.fill();
    };
    hill(H * 0.66, 22, '#5b4b8a', 0.3); hill(H * 0.76, 18, '#3c2f63', 1.7); hill(H * 0.86, 14, '#1f1838', 2.6);
    // swatches, top right
    const cols = ['#3c78d8', '#2bb3a3', '#f2b53c', '#ff7a6b', '#8a6cf0', '#e8e3d9', '#111111', '#d6d6d6'];
    const s = 30, gx = W - 24 - (cols.length / 2) * (s + 6), gy = 24;
    cols.forEach((c, i) => { g.fillStyle = c; g.fillRect(gx + (i % 4) * (s + 6), gy + Math.floor(i / 4) * (s + 6), s, s); });
    // a gradient strip
    const hue = g.createLinearGradient(gx, 0, gx + 4 * (s + 6) - 6, 0);
    ['#ff0000', '#ffff00', '#00ff00', '#00ffff', '#0000ff', '#ff00ff', '#ff0000'].forEach((c, i) => hue.addColorStop(i / 6, c));
    g.fillStyle = hue; g.fillRect(gx, gy + 2 * (s + 6), 4 * (s + 6) - 6, 14);
    // type
    g.fillStyle = '#fdf3e7'; g.font = '300 34px "DM Mono", ui-monospace, monospace';
    g.fillText('golden hour', 28, 58);
    g.fillStyle = 'rgba(253, 243, 231, .7)'; g.font = '300 13px "DM Mono", ui-monospace, monospace';
    g.fillText('every pixel here has a color. point at one.', 30, 84);
    data = sctx.getImageData(0, 0, DW, DH).data;
  }

  // ---------------------------------------------------------------------------
  // colors
  // ---------------------------------------------------------------------------
  const rgbAt = (x, y) => { const i = (y * DW + x) * 4; return [data[i], data[i + 1], data[i + 2]]; };
  const hex = ([r, g, b]) => '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
  function hsl([r, g, b]) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
    let h = 0, s = 0;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h *= 60;
    }
    return `hsl(${Math.round(h)}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%)`;
  }
  const show = (c, f = fmt) => (f === 'hex' ? hex(c) : f === 'rgb' ? `rgb(${c.join(', ')})` : hsl(c));

  // ---------------------------------------------------------------------------
  // the loupe
  // ---------------------------------------------------------------------------
  function drawLoupe() {
    if (!at) { loupe.hidden = true; return; }
    loupe.hidden = false;
    const n = across, cell = lc.width / n, half = (n - 1) / 2;
    lctx.imageSmoothingEnabled = false;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x = at.x + i - half, y = at.y + j - half;
        lctx.fillStyle = x < 0 || y < 0 || x >= DW || y >= DH ? '#111111' : hex(rgbAt(x, y));
        lctx.fillRect(Math.floor(i * cell), Math.floor(j * cell), Math.ceil(cell), Math.ceil(cell));
      }
    }
    // the ringed pixel: white, with a dark edge so it reads on anything
    const x = Math.floor(half * cell), y = Math.floor(half * cell), c = Math.ceil(cell);
    lctx.strokeStyle = '#000'; lctx.lineWidth = 3; lctx.strokeRect(x - 1, y - 1, c + 2, c + 2);
    lctx.strokeStyle = '#fff'; lctx.lineWidth = 1.5; lctx.strokeRect(x - 1, y - 1, c + 2, c + 2);
    const col = rgbAt(at.x, at.y);
    chip.querySelector('i').style.background = hex(col);
    chip.querySelector('span').textContent = show(col);
    // beside the pointer, and kept inside the desk
    const px = at.x / dpr, py = at.y / dpr, size = 154;
    let lx = px + 24, ly = py + 24;
    if (lx + size > W - 8) lx = px - 24 - size;
    if (ly + size + 32 > H - 8) ly = py - 24 - size - 32;
    loupe.style.transform = `translate(${Math.round(lx)}px, ${Math.round(ly)}px)`;
  }

  // ---------------------------------------------------------------------------
  // the palette
  // ---------------------------------------------------------------------------
  function renderPalette() {
    sw.innerHTML = palette.map((c, i) => `<button style="background:${hex(c)}" data-i="${i}" title="${show(c)}" aria-label="copy ${show(c)}"></button>`).join('');
    pcount.textContent = palette.length ? `${palette.length} color${palette.length === 1 ? '' : 's'}` : 'pick a color';
    fmtLabel.textContent = `${fmt} ›`;
  }
  sw.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) copy(palette[Number(b.dataset.i)], false);
  });

  let toastTimer = null;
  function toast(text, dim) {
    toastEl.innerHTML = `${text}${dim ? `<span class="dim">${dim}</span>` : ''}`;
    toastEl.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('on'), 1600);
  }
  async function copy(c, keep = true) {
    const text = show(c);
    try { await navigator.clipboard.writeText(text); toast('copied', text); } catch (_) { toast('could not copy', text); }
    if (keep) {
      // the same color again moves to the front instead of showing twice
      palette = [c, ...palette.filter((p) => hex(p) !== hex(c))].slice(0, 30);
      renderPalette();
    }
  }

  // ---------------------------------------------------------------------------
  // input
  // ---------------------------------------------------------------------------
  const onScreen = (e) => !e.target.closest('#pal');
  const toDev = (e) => {
    const r = desk.getBoundingClientRect();
    return { x: Math.max(0, Math.min(DW - 1, Math.floor((e.clientX - r.left) * dpr))), y: Math.max(0, Math.min(DH - 1, Math.floor((e.clientY - r.top) * dpr))) };
  };
  desk.addEventListener('pointermove', (e) => {
    if (!onScreen(e)) { at = null; drawLoupe(); desk.classList.remove('picking'); return; }
    desk.classList.add('picking');
    at = toDev(e);
    drawLoupe();
  });
  desk.addEventListener('pointerleave', () => { at = null; drawLoupe(); });
  // a click acts on release, so it never reaches what's underneath
  desk.addEventListener('pointerup', (e) => {
    if (e.button !== 0 || !onScreen(e) || !at) return;
    desk.focus({ preventScroll: true });
    copy(rgbAt(at.x, at.y));
  });
  desk.addEventListener('wheel', (e) => {
    if (!at) return;
    e.preventDefault();
    across = Math.max(7, Math.min(21, across + (e.deltaY > 0 ? 2 : -2)));
    drawLoupe();
  }, { passive: false });

  function setFmt(f) {
    fmt = f;
    document.querySelectorAll('[data-fmt]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.fmt === f)));
    renderPalette();
    drawLoupe();
  }
  document.querySelectorAll('[data-fmt]').forEach((b) => b.addEventListener('click', () => setFmt(b.dataset.fmt)));

  let over = false;
  desk.addEventListener('mouseenter', () => { over = true; });
  desk.addEventListener('mouseleave', () => { over = false; });
  document.addEventListener('keydown', (e) => {
    if (!over && document.activeElement !== desk) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Tab') { e.preventDefault(); setFmt(FORMATS[(FORMATS.indexOf(fmt) + (e.shiftKey ? 2 : 1)) % 3]); return; }
    if (!at) return;
    const n = e.shiftKey ? 10 : 1;
    const d = { ArrowLeft: [-n, 0], ArrowRight: [n, 0], ArrowUp: [0, -n], ArrowDown: [0, n] }[e.key];
    if (d) { at = { x: Math.max(0, Math.min(DW - 1, at.x + d[0])), y: Math.max(0, Math.min(DH - 1, at.y + d[1])) }; drawLoupe(); e.preventDefault(); }
    else if (e.key === 'Enter') { copy(rgbAt(at.x, at.y)); e.preventDefault(); }
    else if (e.key === '+' || e.key === '=') { across = Math.max(7, across - 2); drawLoupe(); e.preventDefault(); }
    else if (e.key === '-') { across = Math.min(21, across + 2); drawLoupe(); e.preventDefault(); }
  });

  let last = '';
  const repaint = () => {
    const r = desk.getBoundingClientRect();
    const key = `${Math.round(r.width)}x${Math.round(r.height)}@${window.devicePixelRatio}`;
    if (key === last) return;
    last = key;
    paint();
  };
  new ResizeObserver(repaint).observe(desk);
  if (document.fonts) document.fonts.ready.then(() => { last = ''; repaint(); });
  renderPalette();
})();
