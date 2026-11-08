'use strict';
// The demo desk: plays the part of notr's main process (src/main.js) in the
// browser. Every note is an <iframe> running the real note UI from docs/app
// (copied from src/ by scripts/build-web.js); this file places, moves,
// resizes, themes and saves them the way the desktop app does.
(() => {
  const Keys = window.NotrKeys;
  const STORE = 'notr-demo-v1';
  const GAP = 14;
  const MIN = { w: 200, h: 150 };
  const KBD = { startSpeed: 140, maxSpeed: 1100, rampSeconds: 0.9 }; // px/s, same as the app
  const DOTS = ['green', 'amber', 'blue'];
  const THEME_BG = {
    ghost: '#111111', mono: '#000000', paper: '#f4f4f0', dots: '#101010',
    gutter: '#0c0c0e', green: '#0f1311', amber: '#140d02',
  };

  const deskEl = document.getElementById('desk');
  const emptyEl = document.getElementById('desk-empty');
  const shield = document.getElementById('drag-shield');
  const clone = (o) => JSON.parse(JSON.stringify(o));

  let state = null; // { seq, notes: [{ id, x, y, w, h, html, dot }], settings }
  const views = new Map(); // id -> { wrap, frame, note, onSettings, onFocus }
  let z = 10;
  let lastFocused = null;

  // -------------------------------------------------------------------------
  // storage (this browser only; the demo works without it)
  // -------------------------------------------------------------------------
  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE));
      // v2: new welcome note (without the shortcuts the demo no longer has)
      if (s && s.v === 2 && Array.isArray(s.notes) && s.settings) return s;
    } catch (_) {}
    return null;
  }
  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { localStorage.setItem(STORE, JSON.stringify(state)); } catch (_) {}
    }, 300);
  }

  const deskSize = () => ({ W: deskEl.clientWidth, H: deskEl.clientHeight });

  function defaultSettings() {
    return {
      theme: 'ghost', fonts: {}, status: { pos: false, chars: true },
      shortcuts: { ...Keys.DEFAULTS }, onTop: true, confirmDelete: true, startup: true,
    };
  }

  const WELCOME = [
    '<b>hi, this is notr.</b>',
    'type anything. it saves itself.',
    '<hr>',
    '+ top left · a new note',
    'drag the top · move',
    'drag an edge · resize',
    '/line + enter · a separator line',
    'right-click text · bold, font, size',
    '⚙ top right · themes and fonts',
  ];
  const TODAY = ['today', '<hr>', 'water the plants', 'reply to emails', 'oat milk, coffee, lemons', ''];

  const toHtml = (lines) => lines.reduce((out, l, i) => {
    if (l === '<hr>') return out + l;
    const prevHr = i > 0 && lines[i - 1] === '<hr>';
    return out + (i > 0 && !prevHr ? '<br>' : '') + l;
  }, '');

  function freshState() {
    const { W, H } = deskSize();
    const notes = [];
    if (W >= 640) {
      const a = { w: 340, h: Math.min(330, H - 2 * GAP) };
      const b = { w: 250, h: Math.min(230, H - 2 * GAP) };
      const x0 = Math.round((W - (a.w + GAP * 2 + b.w)) / 2);
      const y0 = Math.round((H - a.h) / 2);
      notes.push({ id: 'n1', x: x0, y: y0, ...a, html: toHtml(WELCOME), dot: 'green' });
      notes.push({ id: 'n2', x: x0 + a.w + GAP * 2, y: y0 + 46, ...b, html: toHtml(TODAY), dot: 'amber' });
    } else {
      const w = W - 2 * GAP;
      notes.push({ id: 'n1', x: GAP, y: GAP, w, h: 330, html: toHtml(WELCOME), dot: 'green' });
      notes.push({ id: 'n2', x: GAP, y: GAP * 2 + 330, w, h: Math.max(MIN.h, Math.min(220, H - 330 - GAP * 3)), html: toHtml(TODAY), dot: 'amber' });
    }
    return { v: 2, seq: 2, notes, settings: defaultSettings() };
  }

  // Keep a note inside the desk (the desk shrinks on small screens). Only
  // for showing it: the saved size stays, so it comes back when there's room.
  function fit(b) {
    const { W, H } = deskSize();
    const w = Math.max(Math.min(MIN.w, W), Math.min(b.w, W));
    const h = Math.max(Math.min(MIN.h, H), Math.min(b.h, H));
    return { x: Math.max(0, Math.min(b.x, W - w)), y: Math.max(0, Math.min(b.y, H - h)), w, h };
  }

  // -------------------------------------------------------------------------
  // placing new notes: beside the source, never on top of another note
  // (same rules as findSpotNextTo in src/main.js)
  // -------------------------------------------------------------------------
  const bounds = (n) => ({ x: n.x, y: n.y, w: n.w, h: n.h });
  const shown = (n) => fit(bounds(n)); // where a note actually is on the desk
  function overlaps(a, b) {
    const g = GAP - 1;
    return a.x < b.x + b.w + g && b.x < a.x + a.w + g && a.y < b.y + b.h + g && b.y < a.y + a.h + g;
  }
  function isFree(r, others) {
    const { W, H } = deskSize();
    return r.x >= 0 && r.y >= 0 && r.x + r.w <= W && r.y + r.h <= H && !others.some((o) => overlaps(r, o));
  }
  function findSpotNextTo(src) {
    const others = state.notes.map(shown);
    const { W, H } = deskSize();
    const w = Math.min(src.w, W), h = Math.min(src.h, H);
    const candidates = [
      { x: src.x + src.w + GAP, y: src.y },
      { x: src.x - w - GAP, y: src.y },
      { x: src.x, y: src.y + src.h + GAP },
      { x: src.x, y: src.y - h - GAP },
    ];
    for (const c of candidates) {
      const r = { ...c, w, h };
      if (isFree(r, others)) return r;
    }
    let best = null, bestD = Infinity;
    const tx = src.x + src.w + GAP, ty = src.y;
    for (let y = GAP; y + h <= H; y += 12) {
      for (let x = GAP; x + w <= W; x += 12) {
        const r = { x, y, w, h };
        if (!isFree(r, others)) continue;
        const d = (x - tx) ** 2 + (y - ty) ** 2 * 1.5;
        if (d < bestD) { bestD = d; best = r; }
      }
    }
    if (best) return best;
    return fit({ x: src.x + 28, y: src.y + 28, w, h });
  }

  function firstNoteBounds() {
    const { W, H } = deskSize();
    const w = Math.min(300, W - 2 * GAP), h = Math.min(300, H - 2 * GAP);
    return { x: Math.round((W - w) / 2), y: Math.round((H - h) / 3), w, h };
  }

  // -------------------------------------------------------------------------
  // note views
  // -------------------------------------------------------------------------
  const easeOut = (t) => 1 - Math.pow(1 - t, 3);
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  function animate(wrap, from, to, ms, done) {
    if (reduceMotion) ms = 1;
    const start = performance.now();
    const step = (now) => {
      const k = easeOut(Math.min(1, (now - start) / ms));
      const lerp = (a, b) => a + (b - a) * k;
      if (from.x !== undefined) {
        wrap.style.left = Math.round(lerp(from.x, to.x)) + 'px';
        wrap.style.top = Math.round(lerp(from.y, to.y)) + 'px';
      }
      if (from.opacity !== undefined) wrap.style.opacity = lerp(from.opacity, to.opacity);
      if (k < 1) requestAnimationFrame(step);
      else if (done) done();
    };
    requestAnimationFrame(step);
  }

  function setBox(wrap, b) {
    wrap.style.left = Math.round(b.x) + 'px';
    wrap.style.top = Math.round(b.y) + 'px';
    wrap.style.width = Math.round(b.w) + 'px';
    wrap.style.height = Math.round(b.h) + 'px';
  }

  function mount(note, { slideFrom = null, focus = false } = {}) {
    const wrap = document.createElement('div');
    wrap.className = 'dnote';
    wrap.style.zIndex = ++z;
    wrap.style.opacity = 0;
    wrap.style.background = THEME_BG[state.settings.theme];

    const frame = document.createElement('iframe');
    frame.dataset.id = note.id;
    frame.title = 'note';
    frame.setAttribute('allow', 'clipboard-read; clipboard-write');
    frame.src = 'app/note.html';
    wrap.appendChild(frame);

    for (const edge of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
      const g = document.createElement('div');
      g.className = 'grip grip-' + edge;
      g.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        g.setPointerCapture(e.pointerId);
        raise(note.id);
        dragStart(note.id, edge, e.screenX, e.screenY, true);
      });
      g.addEventListener('pointermove', (e) => dragMove(e.screenX, e.screenY));
      g.addEventListener('pointerup', dragEnd);
      g.addEventListener('pointercancel', dragEnd);
      wrap.appendChild(g);
    }

    const target = shown(note);
    const start = slideFrom
      ? { x: slideFrom.x + (target.x - slideFrom.x) * 0.3, y: slideFrom.y + (target.y - slideFrom.y) * 0.3 }
      : { x: target.x, y: target.y };
    setBox(wrap, { ...target, ...start });
    deskEl.appendChild(wrap);

    const v = { wrap, frame, note, onSettings: null, onFocus: null };
    views.set(note.id, v);
    emptyEl.hidden = true;

    frame.addEventListener('load', () => {
      if (slideFrom) animate(wrap, { ...start, opacity: 0 }, { ...target, opacity: 1 }, 280);
      else animate(wrap, { opacity: 0 }, { opacity: 1 }, 220);
      if (focus) {
        frame.contentWindow.focus();
        if (v.onFocus) v.onFocus();
        raise(note.id);
      }
    }, { once: true });
    return v;
  }

  function raise(id) {
    const v = views.get(id);
    if (!v) return;
    lastFocused = id;
    if (Number(v.wrap.style.zIndex) !== z) v.wrap.style.zIndex = ++z;
  }

  function unmountAll() {
    for (const v of views.values()) v.wrap.remove();
    views.clear();
  }

  function showEmpty() {
    emptyEl.hidden = state.notes.length > 0;
  }

  // -------------------------------------------------------------------------
  // the API each note talks to (see docs/app/bridge.js)
  // -------------------------------------------------------------------------
  function newNote(fromId) {
    const v = views.get(fromId) || views.get(lastFocused) || [...views.values()].pop();
    const src = v ? shown(v.note) : null;
    const b = src ? findSpotNextTo(src) : firstNoteBounds();
    const note = { id: 'n' + (++state.seq), ...b, html: '', dot: DOTS[state.seq % DOTS.length] };
    state.notes.push(note);
    save();
    mount(note, { slideFrom: src, focus: true });
  }

  function closeNote(id) {
    const v = views.get(id);
    state.notes = state.notes.filter((n) => n.id !== id);
    save();
    showEmpty();
    if (!v) return;
    views.delete(id);
    v.wrap.style.pointerEvents = 'none';
    animate(v.wrap, { opacity: Number(v.wrap.style.opacity) || 1 }, { opacity: 0 }, 160, () => v.wrap.remove());
  }

  function setSettings(patch) {
    if (!patch || typeof patch !== 'object') return;
    const s = state.settings;
    if (THEME_BG[patch.theme]) s.theme = patch.theme;
    if (patch.font && THEME_BG[patch.font.theme]) {
      const f = { ...(s.fonts[patch.font.theme] || {}), ...patch.font.value };
      s.fonts[patch.font.theme] = {
        family: typeof f.family === 'string' ? f.family : null,
        size: Number.isFinite(f.size) ? Math.min(48, Math.max(8, f.size)) : null,
        bold: !!f.bold,
        italic: !!f.italic,
      };
    }
    for (const k of ['onTop', 'confirmDelete', 'startup']) {
      if (typeof patch[k] === 'boolean') s[k] = patch[k];
    }
    if (patch.status) {
      if (typeof patch.status.pos === 'boolean') s.status.pos = patch.status.pos;
      if (typeof patch.status.chars === 'boolean') s.status.chars = patch.status.chars;
    }
    if (patch.shortcut && Keys.ACTIONS.includes(patch.shortcut.action)) {
      const combo = Keys.normalize(patch.shortcut.combo);
      const { action } = patch.shortcut;
      const taken = Keys.ACTIONS.some((a) => a !== action && s.shortcuts[a] === combo);
      if (combo && !taken) s.shortcuts[action] = combo;
    }
    save();
    broadcast();
  }

  function broadcast() {
    const s = state.settings;
    for (const v of views.values()) {
      v.wrap.style.background = THEME_BG[s.theme];
      if (v.onSettings) v.onSettings(clone(s));
    }
    document.querySelectorAll('[data-set-theme]').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.setTheme === s.theme));
    });
  }

  const esc = (t) => t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function edit(win, cmd) {
    const doc = win.document;
    if (cmd !== 'paste') { doc.execCommand(cmd); return; }
    if (!navigator.clipboard || !navigator.clipboard.readText) return;
    navigator.clipboard.readText().then((text) => {
      if (!text) return;
      doc.execCommand('insertHTML', false, esc(text.replace(/\r\n?/g, '\n')).replace(/\n/g, '<br>'));
    }).catch(() => {});
  }

  // -------------------------------------------------------------------------
  // dragging: title bar (from inside the note) and the edge grips
  // -------------------------------------------------------------------------
  let drag = null;
  const CURSORS = {
    move: 'default', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
    ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize',
  };

  function dragStart(id, edge, sx, sy, captured) {
    const v = views.get(id);
    if (!v) return;
    kbdStopAll();
    drag = { v, edge, sx, sy, b0: shown(v.note) };
    document.body.classList.add('dragging');
    // a shield over the page so other notes don't swallow the pointer
    if (!captured) { shield.hidden = false; }
    shield.style.cursor = CURSORS[edge];
    document.body.style.cursor = CURSORS[edge];
  }

  function dragMove(sx, sy) {
    if (!drag) return;
    const { W, H } = deskSize();
    const dx = sx - drag.sx, dy = sy - drag.sy;
    const b = { ...drag.b0 };
    const e = drag.edge;
    if (e === 'move') {
      b.x = Math.max(0, Math.min(W - b.w, b.x + dx));
      b.y = Math.max(0, Math.min(H - b.h, b.y + dy));
    } else {
      if (e.includes('e')) b.w = Math.max(MIN.w, Math.min(W - b.x, drag.b0.w + dx));
      if (e.includes('s')) b.h = Math.max(MIN.h, Math.min(H - b.y, drag.b0.h + dy));
      if (e.includes('w')) {
        const right = drag.b0.x + drag.b0.w;
        b.x = Math.max(0, Math.min(right - MIN.w, drag.b0.x + dx));
        b.w = right - b.x;
      }
      if (e.includes('n')) {
        const bottom = drag.b0.y + drag.b0.h;
        b.y = Math.max(0, Math.min(bottom - MIN.h, drag.b0.y + dy));
        b.h = bottom - b.y;
      }
    }
    Object.assign(drag.v.note, b);
    setBox(drag.v.wrap, b);
  }

  function dragEnd() {
    if (!drag) return;
    drag = null;
    shield.hidden = true;
    document.body.classList.remove('dragging');
    document.body.style.cursor = '';
    save();
  }

  shield.addEventListener('pointermove', (e) => dragMove(e.screenX, e.screenY));
  shield.addEventListener('pointerup', dragEnd);
  shield.addEventListener('pointercancel', dragEnd);

  // -------------------------------------------------------------------------
  // keyboard: ctrl+arrows resize, alt+arrows move, while held
  // (same feel as kbdStep in src/main.js)
  // -------------------------------------------------------------------------
  const kbd = new Map(); // id -> motion

  function kbdStep(m) {
    const now = performance.now();
    const dt = Math.min(0.05, (now - m.last) / 1000);
    m.last = now;
    const t = Math.min(1, (now - m.start) / 1000 / KBD.rampSeconds);
    const d = (KBD.startSpeed + (KBD.maxSpeed - KBD.startSpeed) * t * t) * dt;
    const dx = (m.dirs.has('right') ? 1 : 0) - (m.dirs.has('left') ? 1 : 0);
    const dy = (m.dirs.has('down') ? 1 : 0) - (m.dirs.has('up') ? 1 : 0);
    const { W, H } = deskSize();
    const b = m.b;
    if (m.mode === 'resize') {
      b.w = Math.max(MIN.w, Math.min(W - b.x, b.w + dx * d));
      b.h = Math.max(MIN.h, Math.min(H - b.y, b.h + dy * d));
    } else {
      b.x = Math.max(0, Math.min(W - b.w, b.x + dx * d));
      b.y = Math.max(0, Math.min(H - b.h, b.y + dy * d));
    }
    Object.assign(m.v.note, { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h) });
    setBox(m.v.wrap, b);
  }

  function kbdStart(id, mode, dir) {
    const v = views.get(id);
    if (!v || !['left', 'right', 'up', 'down'].includes(dir)) return;
    let m = kbd.get(id);
    if (m && m.mode !== mode) { kbdStop(id); m = null; }
    if (!m) {
      const now = performance.now();
      m = { v, mode, dirs: new Set(), start: now, last: now - 16, b: shown(v.note), timer: null };
      kbd.set(id, m);
    }
    m.dirs.add(dir);
    kbdStep(m); // a quick tap always does something
    if (!m.timer) m.timer = setInterval(() => kbdStep(m), 16);
  }

  function kbdStop(id, dir) {
    const m = kbd.get(id);
    if (!m) return;
    if (dir) m.dirs.delete(dir); else m.dirs.clear();
    if (m.dirs.size) return;
    clearInterval(m.timer);
    kbd.delete(id);
    save();
  }
  function kbdStopAll() { for (const id of [...kbd.keys()]) kbdStop(id); }

  // -------------------------------------------------------------------------
  // public: used by the notes (bridge.js) and the page
  // -------------------------------------------------------------------------
  window.notrDesk = {
    init(id) {
      const v = views.get(id);
      if (!v) return null;
      return { note: { id, html: v.note.html, dot: v.note.dot }, settings: clone(state.settings) };
    },
    update(id, patch) {
      const v = views.get(id);
      if (!v || !patch) return;
      if (typeof patch.html === 'string') v.note.html = patch.html;
      if (DOTS.includes(patch.dot)) v.note.dot = patch.dot;
      save();
    },
    shortcuts: () => ({ ...state.settings.shortcuts }),
    newNote, closeNote, setSettings, edit, raise,
    kbdStart, kbdStop,
    onSettings(id, cb) { const v = views.get(id); if (v) v.onSettings = cb; },
    onFocusEditor(id, cb) { const v = views.get(id); if (v) v.onFocus = cb; },
    dragStart: (id, edge, sx, sy) => dragStart(id, edge, sx, sy, false),
    dragMove, dragEnd,
  };

  // -------------------------------------------------------------------------
  // the page around the desk
  // -------------------------------------------------------------------------
  function start(fresh) {
    unmountAll();
    state = (!fresh && load()) || freshState();
    for (const n of state.notes) mount(n);
    showEmpty();
    broadcast();
  }

  document.getElementById('desk-open').addEventListener('click', () => newNote(null));
  document.getElementById('desk-reset').addEventListener('click', () => {
    try { localStorage.removeItem(STORE); } catch (_) {}
    start(true);
  });
  document.querySelectorAll('[data-set-theme]').forEach((b) => {
    b.addEventListener('click', () => {
      setSettings({ theme: b.dataset.setTheme });
      if (b.dataset.scroll) document.getElementById('try').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
    });
  });

  // keep every note on the desk when the page is resized
  let lastSize = deskSize();
  new ResizeObserver(() => {
    const now = deskSize();
    if (now.W === lastSize.W && now.H === lastSize.H) return;
    lastSize = now;
    for (const v of views.values()) setBox(v.wrap, shown(v.note));
  }).observe(deskEl);

  start(false);
})();
