'use strict';
// snipr in the browser: drag over the pretend screen, and the snip lifts off
// it in a ghost window you can mark up, blur, move and drag into the chat.
// (The app captures real pixels; here a snip is a copy of the page's own
// pretend screen, so nothing reaches your clipboard.)
(() => {
  const desk = document.getElementById('desk');
  const screenEl = document.getElementById('screen');
  const toastEl = document.getElementById('toast');
  const dropEl = document.getElementById('drop');
  const MAX_SNIPS = 4;
  const TOOLS = { p: 'pen', a: 'arrow', b: 'box', x: 'blur' };
  const LABEL = { hand: 'v', pen: 'p', arrow: 'a', box: 'b', blur: 'x' };
  const snips = [];
  let focused = null;

  const rel = (e) => {
    const r = desk.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, W: r.width, H: r.height };
  };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const capture = (el, e) => { try { el.setPointerCapture(e.pointerId); } catch (_) { /* a synthetic pointer */ } };

  let toastTimer = null;
  function toast(text, dim) {
    toastEl.innerHTML = `${text}${dim ? `<span class="dim">${dim}</span>` : ''}`;
    toastEl.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('on'), 1800);
  }

  // a copy of the pretend screen, shifted so (x, y) is its top left corner
  function screenCopy(x, y) {
    const r = desk.getBoundingClientRect();
    const c = screenEl.cloneNode(true);
    c.removeAttribute('id');
    c.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
    const holder = document.createElement('div');
    holder.style.cssText = `left:${-x}px;top:${-y}px;width:${r.width}px;height:${r.height}px;position:absolute`;
    holder.appendChild(c);
    return holder;
  }

  // ---------------------------------------------------------------------------
  // the capture: drag an area (shift: square, space: move it, esc: cancel)
  // ---------------------------------------------------------------------------
  let cap = null;

  desk.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('.snip')) return;
    e.preventDefault();
    desk.focus({ preventScroll: true });
    const p = rel(e);
    const sel = document.createElement('div');
    sel.className = 'sel';
    sel.innerHTML = '<i class="corner tl"></i><i class="corner br"></i><span class="size panel"></span>';
    desk.appendChild(sel);
    cap = { x0: p.x, y0: p.y, x1: p.x, y1: p.y, sel, moving: null, shift: e.shiftKey };
    capture(desk, e);
    draw();
  });

  function box() {
    let { x0, y0, x1, y1 } = cap;
    if (cap.shift) {
      const s = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
      x1 = x0 + Math.sign(x1 - x0 || 1) * s;
      y1 = y0 + Math.sign(y1 - y0 || 1) * s;
    }
    const r = desk.getBoundingClientRect();
    const x = clamp(Math.min(x0, x1), 0, r.width), y = clamp(Math.min(y0, y1), 0, r.height);
    const w = clamp(Math.max(x0, x1), 0, r.width) - x, h = clamp(Math.max(y0, y1), 0, r.height) - y;
    return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
  }

  function draw() {
    const b = box();
    Object.assign(cap.sel.style, { left: b.x + 'px', top: b.y + 'px', width: b.w + 'px', height: b.h + 'px' });
    cap.sel.querySelector('.size').textContent = `${b.w} × ${b.h}`;
    cap.sel.querySelector('.size').style.display = b.w > 2 || b.h > 2 ? '' : 'none';
  }

  desk.addEventListener('pointermove', (e) => {
    if (!cap) return;
    const p = rel(e);
    cap.shift = e.shiftKey;
    if (cap.moving) {
      const dx = p.x - cap.moving.x, dy = p.y - cap.moving.y;
      cap.x0 += dx; cap.x1 += dx; cap.y0 += dy; cap.y1 += dy;
      cap.moving = p;
    } else {
      cap.x1 = p.x; cap.y1 = p.y;
    }
    draw();
  });

  desk.addEventListener('pointerup', (e) => {
    if (!cap) return;
    let b = box();
    cap.sel.remove();
    cap = null;
    const r = desk.getBoundingClientRect();
    if (b.w < 6 || b.h < 6) b = { x: 0, y: 0, w: Math.round(r.width), h: Math.round(r.height) }; // a click: the whole screen
    openSnip(b);
  });

  // ---------------------------------------------------------------------------
  // a snip window
  // ---------------------------------------------------------------------------
  const ICONS = {
    pen: '<svg width="12" height="12" viewBox="0 0 12 12"><path d="M1.5 10.5c2-1 2.5-4 4.5-5s3.5.5 4.5-2" stroke="currentColor" stroke-width="1.3" fill="none"/></svg>',
    arrow: '<svg width="12" height="12" viewBox="0 0 12 12"><path d="M2 10L10 2M5 2h5v5" stroke="currentColor" stroke-width="1.3" fill="none"/></svg>',
    box: '<svg width="12" height="12" viewBox="0 0 12 12"><path d="M1.5 2.5h9v7h-9z" stroke="currentColor" stroke-width="1.3" fill="none"/></svg>',
    blur: '<svg width="12" height="12" viewBox="0 0 12 12"><path d="M1 1h3v3H1zM8 1h3v3H8zM4.5 4.5h3v3h-3zM1 8h3v3H1zM8 8h3v3H8z" fill="currentColor"/></svg>',
    close: '<svg width="10" height="10" viewBox="0 0 12 12"><path d="M1 1l10 10M11 1L1 11" stroke="currentColor" stroke-width="1.4" fill="none"/></svg>',
  };

  function openSnip(b) {
    while (snips.length >= MAX_SNIPS) closeSnip(snips[0]);
    const el = document.createElement('div');
    el.className = 'snip';
    Object.assign(el.style, { left: b.x + 'px', top: b.y + 'px', width: b.w + 'px', height: b.h + 'px' });
    el.innerHTML = `
      <div class="shot" data-tool="hand"></div>
      <div class="sbar">
        <span class="sz">${b.w} × ${b.h}</span>
        ${['pen', 'arrow', 'box', 'blur'].map((t) => `<button data-tool="${t}" title="${t} (${LABEL[t]})" aria-pressed="false">${ICONS[t]}</button>`).join('')}
        <button data-act="close" title="close (esc)">${ICONS.close}</button>
      </div>`;
    const shot = el.querySelector('.shot');
    shot.appendChild(screenCopy(b.x, b.y));
    const canvas = document.createElement('canvas');
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(b.w * dpr);
    canvas.height = Math.round(b.h * dpr);
    shot.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    const s = { el, shot, canvas, ctx, b, tool: 'hand', marks: [], live: null, offset: { x: 0, y: 0 } };
    snips.push(s);
    desk.appendChild(el);
    focus(s);
    toast('snipped', `${b.w} × ${b.h}`);
    wire(s);
  }

  function closeSnip(s) {
    const i = snips.indexOf(s);
    if (i >= 0) snips.splice(i, 1);
    s.el.style.transition = 'opacity .16s';
    s.el.style.opacity = '0';
    setTimeout(() => s.el.remove(), 170);
    if (focused === s) focused = snips[snips.length - 1] || null;
    if (focused) focus(focused);
  }

  let z = 20;
  function focus(s) {
    focused = s;
    snips.forEach((o) => o.el.classList.toggle('focus', o === s));
    s.el.style.zIndex = ++z;
  }

  function setTool(s, tool) {
    s.tool = s.tool === tool ? 'hand' : tool;
    s.shot.dataset.tool = s.tool;
    s.el.querySelectorAll('[data-tool]').forEach((btn) => btn.setAttribute('aria-pressed', String(btn.dataset.tool === s.tool)));
  }

  // marks: ghost ink (white with a dark halo), and a blur that keeps nothing
  function paint(s) {
    const { ctx, b } = s;
    ctx.clearRect(0, 0, b.w, b.h);
    for (const m of [...s.marks, s.live].filter(Boolean)) drawMark(ctx, m);
  }
  function ink(ctx) {
    ctx.strokeStyle = '#ffffff';
    ctx.fillStyle = '#ffffff';
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.shadowColor = 'rgba(0,0,0,.75)';
    ctx.shadowBlur = 3;
  }
  function drawMark(ctx, m) {
    ctx.save();
    if (m.type === 'blur') {
      for (const c of m.cells) { ctx.fillStyle = c.fill; ctx.fillRect(c.x, c.y, c.w, c.h); }
    } else {
      ink(ctx);
      ctx.beginPath();
      if (m.type === 'pen') {
        m.pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        ctx.stroke();
      } else if (m.type === 'box') {
        ctx.strokeRect(Math.min(m.a.x, m.b.x), Math.min(m.a.y, m.b.y), Math.abs(m.b.x - m.a.x), Math.abs(m.b.y - m.a.y));
      } else if (m.type === 'arrow') {
        const ang = Math.atan2(m.b.y - m.a.y, m.b.x - m.a.x);
        const head = 11;
        ctx.moveTo(m.a.x, m.a.y);
        ctx.lineTo(m.b.x, m.b.y);
        ctx.moveTo(m.b.x - head * Math.cos(ang - 0.45), m.b.y - head * Math.sin(ang - 0.45));
        ctx.lineTo(m.b.x, m.b.y);
        ctx.lineTo(m.b.x - head * Math.cos(ang + 0.45), m.b.y - head * Math.sin(ang + 0.45));
        ctx.stroke();
      }
    }
    ctx.restore();
  }
  // one average colour for the whole area, each block shifted by secure noise
  function blurCells(a, b) {
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y), w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
    const size = 9;
    const cells = [];
    const cols = Math.max(1, Math.ceil(w / size)), rows = Math.max(1, Math.ceil(h / size));
    const noise = new Uint8Array(cols * rows);
    crypto.getRandomValues(noise);
    let k = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const v = 30 + (noise[k++] % 22) - 11;
        cells.push({ x: x + c * size, y: y + r * size, w: Math.min(size, w - c * size), h: Math.min(size, h - r * size), fill: `rgb(${v},${v},${v + 2})` });
      }
    }
    return cells;
  }

  function wire(s) {
    const { el, shot } = s;
    el.addEventListener('pointerdown', () => focus(s));
    el.querySelectorAll('[data-tool]').forEach((btn) => btn.addEventListener('click', () => setTool(s, btn.dataset.tool)));
    el.querySelector('[data-act="close"]').addEventListener('click', () => closeSnip(s));

    // move the window by its bar
    const bar = el.querySelector('.sbar');
    bar.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      e.preventDefault();
      capture(bar, e);
      const start = rel(e), x0 = parseFloat(el.style.left), y0 = parseFloat(el.style.top);
      const move = (ev) => { const p = rel(ev); el.style.left = x0 + p.x - start.x + 'px'; el.style.top = y0 + p.y - start.y + 'px'; };
      const up = () => { bar.removeEventListener('pointermove', move); bar.removeEventListener('pointerup', up); };
      bar.addEventListener('pointermove', move);
      bar.addEventListener('pointerup', up);
    });

    // draw, or (hand) drag the image out
    shot.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      capture(shot, e);
      const r = shot.getBoundingClientRect();
      const at = (ev) => ({ x: clamp(ev.clientX - r.left, 0, s.b.w), y: clamp(ev.clientY - r.top, 0, s.b.h) });
      const a = at(e);
      if (s.tool === 'hand') return dragOut(s, e);
      s.live = s.tool === 'pen' ? { type: 'pen', pts: [a] } : { type: s.tool, a, b: a };
      const move = (ev) => {
        const p = at(ev);
        if (s.live.type === 'pen') s.live.pts.push(p);
        else if (ev.shiftKey && s.live.type === 'box') {
          const d = Math.max(Math.abs(p.x - a.x), Math.abs(p.y - a.y));
          s.live.b = { x: a.x + Math.sign(p.x - a.x || 1) * d, y: a.y + Math.sign(p.y - a.y || 1) * d };
        } else if (ev.shiftKey && s.live.type === 'arrow') {
          const ang = Math.round(Math.atan2(p.y - a.y, p.x - a.x) / (Math.PI / 4)) * (Math.PI / 4);
          const d = Math.hypot(p.x - a.x, p.y - a.y);
          s.live.b = { x: a.x + d * Math.cos(ang), y: a.y + d * Math.sin(ang) };
        } else s.live.b = p;
        if (s.live.type === 'blur') s.live.cells = blurCells(s.live.a, s.live.b);
        paint(s);
      };
      const up = () => {
        shot.removeEventListener('pointermove', move);
        shot.removeEventListener('pointerup', up);
        const m = s.live;
        s.live = null;
        const big = m && (m.type === 'pen' ? m.pts.length > 2 : Math.hypot(m.b.x - m.a.x, m.b.y - m.a.y) > 4);
        if (big) s.marks.push(m);
        paint(s);
      };
      shot.addEventListener('pointermove', move);
      shot.addEventListener('pointerup', up);
    });
  }

  // drag the snip by its image: drop it in the chat
  function dragOut(s, e) {
    const scale = Math.min(1, 150 / s.b.w);
    const ghost = document.createElement('div');
    ghost.className = 'dragout';
    const w = Math.round(s.b.w * scale), h = Math.round(s.b.h * scale);
    Object.assign(ghost.style, { width: w + 'px', height: h + 'px' });
    const inner = thumbOf(s, scale);
    ghost.appendChild(inner);
    desk.appendChild(ghost);
    const place = (ev) => { const p = rel(ev); ghost.style.left = p.x - w / 2 + 'px'; ghost.style.top = p.y - h / 2 + 'px'; };
    place(e);
    const overDrop = (ev) => {
      const r = dropEl.getBoundingClientRect();
      return ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top - 40 && ev.clientY <= r.bottom;
    };
    const move = (ev) => { place(ev); dropEl.classList.toggle('over', overDrop(ev)); };
    const up = (ev) => {
      s.shot.removeEventListener('pointermove', move);
      s.shot.removeEventListener('pointerup', up);
      dropEl.classList.remove('over');
      ghost.remove();
      if (overDrop(ev)) sendToChat(s);
    };
    s.shot.addEventListener('pointermove', move);
    s.shot.addEventListener('pointerup', up);
  }

  function thumbOf(s, scale) {
    const inner = document.createElement('div');
    inner.style.cssText = `width:${s.b.w}px;height:${s.b.h}px;transform:scale(${scale})`;
    const copy = screenCopy(s.b.x, s.b.y);
    inner.appendChild(copy);
    const c = document.createElement('canvas');
    c.width = s.canvas.width; c.height = s.canvas.height;
    c.style.cssText = `position:absolute;left:0;top:0;width:${s.b.w}px;height:${s.b.h}px`;
    c.getContext('2d').drawImage(s.canvas, 0, 0);
    inner.appendChild(c);
    return inner;
  }

  function sendToChat(s) {
    const chat = dropEl.parentElement;
    const scale = Math.min(1, (chat.clientWidth - 30) / s.b.w, 90 / s.b.h);
    const msg = document.createElement('div');
    msg.className = 'sent';
    const t = document.createElement('div');
    t.className = 'thumb';
    t.style.cssText = `width:${Math.round(s.b.w * scale)}px;height:${Math.round(s.b.h * scale)}px`;
    t.appendChild(thumbOf(s, scale));
    msg.innerHTML = '<b>you</b>';
    msg.appendChild(t);
    chat.insertBefore(msg, dropEl);
    toast('sent', 'to #design');
  }

  // ---------------------------------------------------------------------------
  // keys (while the pointer is on the demo, or it has focus)
  // ---------------------------------------------------------------------------
  let over = false;
  desk.addEventListener('mouseenter', () => { over = true; });
  desk.addEventListener('mouseleave', () => { over = false; });
  document.addEventListener('keydown', (e) => {
    if (!over && !desk.contains(document.activeElement)) return;
    if (cap) {
      if (e.key === 'Escape') { cap.sel.remove(); cap = null; e.preventDefault(); }
      else if (e.key === ' ') { cap.moving = cap.moving || { x: cap.x1, y: cap.y1 }; e.preventDefault(); }
      return;
    }
    if (!focused) return;
    const k = e.key.toLowerCase();
    if (e.key === 'Escape') { closeSnip(focused); e.preventDefault(); }
    else if ((e.ctrlKey || e.metaKey) && k === 'z') { focused.marks.pop(); paint(focused); e.preventDefault(); }
    else if ((e.ctrlKey || e.metaKey) && k === 'c') { toast('copied', 'with your marks (in the app)'); e.preventDefault(); }
    else if (!e.ctrlKey && !e.altKey && !e.metaKey && TOOLS[k]) { setTool(focused, TOOLS[k]); e.preventDefault(); }
    else if (!e.ctrlKey && !e.altKey && !e.metaKey && k === 'v') { if (focused.tool !== 'hand') setTool(focused, focused.tool); e.preventDefault(); }
  });
  document.addEventListener('keyup', (e) => { if (cap && e.key === ' ') cap.moving = null; });

  document.getElementById('reset').addEventListener('click', () => {
    [...snips].forEach(closeSnip);
    dropEl.parentElement.querySelectorAll('.sent').forEach((m) => m.remove());
  });
})();
