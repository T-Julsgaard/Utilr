'use strict';

(() => {
  const Keys = window.NotrKeys;

  // -------------------------------------------------------------------------
  // bridge (falls back to a stub so note.html can be previewed in a browser)
  // -------------------------------------------------------------------------
  const api = window.notr || makeStub();

  function makeStub() {
    const q = new URLSearchParams(location.search);
    const noop = () => {};
    let settingsCb = noop;
    const s = {
      theme: q.get('theme') || 'ghost', fonts: {},
      status: { pos: false, chars: true }, shortcuts: { ...Keys.DEFAULTS },
      onTop: true, confirmDelete: true, startup: true,
    };
    return {
      init: async () => ({ note: { id: 'preview', dot: 'green', html: '' }, settings: s, tabs: [] }),
      update: noop, newNote: noop, closeNote: noop, quit: noop, cycle: noop,
      save: noop, openSaved: noop, onTabs: noop,
      setSettings: (p) => {
        if (p.theme) s.theme = p.theme;
        if (p.font) s.fonts[p.font.theme] = { ...(s.fonts[p.font.theme] || {}), ...p.font.value };
        if (p.status) Object.assign(s.status, p.status);
        if (typeof p.onTop === 'boolean') s.onTop = p.onTop;
        if (typeof p.confirmDelete === 'boolean') s.confirmDelete = p.confirmDelete;
        if (typeof p.startup === 'boolean') s.startup = p.startup;
        if (p.shortcut) s.shortcuts[p.shortcut.action] = Keys.normalize(p.shortcut.combo);
        settingsCb(JSON.parse(JSON.stringify(s)));
      },
      edit: (cmd) => document.execCommand(cmd),
      kbdStart: noop, kbdStop: noop,
      onSettings: (cb) => { settingsCb = cb; },
      onFocusEditor: noop,
    };
  }

  // -------------------------------------------------------------------------
  // constants
  // -------------------------------------------------------------------------
  const THEMES = [
    { id: 'ghost', label: 'ghost', sw: '#8a8a8a' },
    { id: 'mono', label: 'bare mono', sw: '#f2f2f2' },
    { id: 'paper', label: 'paper', sw: '#f4f4f0' },
    { id: 'dots', label: 'dots', sw: '#ffb000' },
    { id: 'gutter', label: 'gutter', sw: '#5fd7ff' },
    { id: 'green', label: 'green', sw: '#39ff88' },
    { id: 'amber', label: 'amber crt', sw: '#ffb000' },
  ];
  const FONTS = [
    'JetBrains Mono', 'IBM Plex Mono', 'DM Mono', 'Martian Mono', 'Space Mono', 'VT323',
    'Cascadia Mono', 'Consolas', 'Segoe UI', 'Georgia', 'Arial',
  ];
  const SIZES = [10, 11, 12, 13, 14, 16, 18, 20, 24, 28, 32];
  const DOTS = ['green', 'amber', 'blue'];
  const NO_FONT = { family: null, size: null, bold: false, italic: false };

  // -------------------------------------------------------------------------
  // elements + state
  // -------------------------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const body = document.body;
  const editor = $('editor');
  const scroller = $('body');
  const menuEl = $('menu');
  const confirmEl = $('confirm');
  const btnSettings = $('btn-settings');
  const btnSave = $('btn-save');
  const tabsEl = $('tabs');

  let note = null;
  let tabs = []; // saved notes: [{ id, slot, open, title }]
  let platform = 'win32';
  let S = null; // settings shared by all notes: theme, fonts, status, shortcuts
  let lastRange = null;
  // ctrl+f+up / down: a font size for this note only, for as long as it's
  // open. Not saved; the size in settings is for every note and clears it.
  let noteSize = null;

  const font = () => ({ ...NO_FONT, ...((S && S.fonts[S.theme]) || {}) });

  // -------------------------------------------------------------------------
  // text helpers
  // -------------------------------------------------------------------------
  const BLOCK = /^(DIV|P|LI|H[1-6]|PRE|BLOCKQUOTE|UL|OL)$/;

  // A separator line as plain text (what lands in other apps when you copy one).
  const HR_TEXT = '─'.repeat(24);

  // Plain text of a node, with line breaks. In `full` mode a trailing <br>
  // is ignored (it's only there so the browser can show an empty last line).
  // A separator (<hr>) is a line of its own: empty, or `hrText` when given.
  function serialize(root, full, hrText = '') {
    let out = '';
    let lastWasBr = false;
    (function walk(n) {
      for (const c of n.childNodes) {
        if (c.nodeType === 3) {
          const t = c.data.replace(/​/g, '');
          if (t) { out += t; lastWasBr = false; }
        } else if (c.nodeName === 'BR') {
          out += '\n';
          lastWasBr = true;
        } else if (c.nodeName === 'HR') {
          // a separator is a line of its own
          if (out && !out.endsWith('\n')) out += '\n';
          out += hrText + '\n';
          lastWasBr = false;
        } else if (c.nodeType === 1) {
          if (c.classList.contains('ink')) continue; // the drawing: no text, no line
          if (BLOCK.test(c.nodeName) && out && !out.endsWith('\n')) { out += '\n'; lastWasBr = false; }
          walk(c);
        }
      }
    })(root);
    if (full && lastWasBr) out = out.slice(0, -1);
    return out;
  }

  const fullText = () => serialize(editor, true);
  // a note with nothing in it: no text, and no drawing with a stroke in it
  const hasDrawing = () => !!editor.querySelector('.ink path, .drawing path');
  const isEmpty = () => fullText().trim() === '' && !hasDrawing();

  function caretPos() {
    const sel = getSelection();
    if (!sel.rangeCount) return null;
    const r = sel.getRangeAt(0);
    if (!editor.contains(r.endContainer)) return null;
    const pre = document.createRange();
    pre.selectNodeContents(editor);
    pre.setEnd(r.endContainer, r.endOffset);
    const box = document.createElement('div');
    box.appendChild(pre.cloneContents());
    const lines = serialize(box, false).split('\n');
    return { ln: lines.length, col: lines[lines.length - 1].length + 1 };
  }

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // -------------------------------------------------------------------------
  // keep the caret in view while typing / moving with the arrow keys
  // -------------------------------------------------------------------------
  // Where the caret is on screen. Always measured on the single character or
  // <br> right next to it, never on a whole element: formatting wrappers
  // (<b>, <span>) can hold the entire note, and measuring those made the view
  // jump to the bottom.
  const usable = (rc) => rc && (rc.height > 0 || rc.width > 0);

  function charRect(text, i) {
    const r = document.createRange();
    r.setStart(text, i);
    r.setEnd(text, i + 1);
    const rs = r.getClientRects();
    return rs.length ? rs[0] : null;
  }

  // First (atStart) or last measurable leaf inside a node: a character, <br> or <hr>.
  function leafRect(node, atStart) {
    if (!node) return null;
    if (node.nodeType === 3) {
      const t = node.data;
      if (!t.length) return null;
      return charRect(node, atStart ? 0 : t.length - 1);
    }
    if (node.nodeName === 'BR' || node.nodeName === 'HR') {
      const rc = node.getBoundingClientRect();
      return usable(rc) ? rc : null;
    }
    const kids = [...node.childNodes];
    if (!atStart) kids.reverse();
    for (const k of kids) {
      const rc = leafRect(k, atStart);
      if (rc) return rc;
    }
    return null;
  }

  // The leaf right after (or before) a position, walking out of wrappers.
  function neighbourRect(container, offset, forward) {
    let node = container, off = offset;
    while (node && node !== scroller) {
      const kids = node.childNodes;
      for (let i = forward ? off : off - 1; forward ? i < kids.length : i >= 0; i += forward ? 1 : -1) {
        const rc = leafRect(kids[i], forward);
        if (rc) return { rc, br: !forward && kids[i].nodeName === 'BR' };
      }
      if (node === editor) break;
      const parent = node.parentNode;
      off = [...parent.childNodes].indexOf(node) + (forward ? 1 : 0);
      node = parent;
    }
    return null;
  }

  function caretRect() {
    const sel = getSelection();
    if (!sel.rangeCount || !editor.contains(sel.focusNode)) return null;
    const n = sel.focusNode, o = sel.focusOffset;

    const r = document.createRange();
    r.setStart(n, o);
    r.collapse(true);
    const rects = r.getClientRects();
    if (rects.length && usable(rects[0])) return rects[0];

    if (n.nodeType === 3) {
      if (o < n.data.length) { const rc = charRect(n, o); if (usable(rc)) return rc; }
      if (o > 0) { const rc = charRect(n, o - 1); if (usable(rc)) return rc; }
    }
    const container = n.nodeType === 3 ? n.parentNode : n;
    const offset = n.nodeType === 3 ? [...container.childNodes].indexOf(n) + (o > 0 ? 1 : 0) : o;
    const after = neighbourRect(container, offset, true);
    if (after) return after.rc;
    const before = neighbourRect(container, offset, false);
    if (before) {
      // caret right after a <br>: it sits on the next line
      if (before.br) {
        const h = before.rc.height || parseFloat(getComputedStyle(editor).lineHeight) || 16;
        return { top: before.rc.bottom, bottom: before.rc.bottom + h, height: h, width: 0 };
      }
      return before.rc;
    }
    return null;
  }

  let revealQueued = false;
  function revealCaret() {
    if (revealQueued) return;
    revealQueued = true;
    requestAnimationFrame(() => {
      revealQueued = false;
      if (document.activeElement !== editor) return;
      const r = caretRect();
      if (!r || (!r.height && !r.width && !r.top)) return;
      // grow the caret box to its full line (line-height is taller than the text)
      const fn = getSelection().focusNode;
      const el = fn && (fn.nodeType === 1 ? fn : fn.parentElement);
      const lh = el ? parseFloat(getComputedStyle(el).lineHeight) : NaN;
      const lead = lh > r.height ? (lh - r.height) / 2 : 0;
      const rect = { top: r.top - lead, bottom: r.bottom + lead };
      const box = scroller.getBoundingClientRect();
      // keep the same breathing room the note has at its top and bottom
      const cs = getComputedStyle(editor);
      const top = parseFloat(cs.paddingTop) || 0;
      const bottom = Math.max(6, parseFloat(cs.paddingBottom) || 0);
      if (rect.bottom > box.bottom - bottom) scroller.scrollTop += rect.bottom - (box.bottom - bottom);
      else if (rect.top < box.top + top) scroller.scrollTop -= (box.top + top) - rect.top;
    });
  }

  // -------------------------------------------------------------------------
  // rendering
  // -------------------------------------------------------------------------
  function renderStatus() {
    const showPos = !!S.status.pos, showChars = !!S.status.chars;
    body.classList.toggle('no-status', !showPos && !showChars);
    $('st-pos').hidden = !showPos;
    $('st-chars').hidden = !showChars;
    if (showChars) {
      const n = fullText().length;
      $('st-chars').textContent = n + (n === 1 ? ' char' : ' chars');
    }
    if (showPos) {
      const p = caretPos();
      if (p) $('st-pos').textContent = `ln ${p.ln}, col ${p.col}`;
    }
  }

  function applyFont() {
    const f = font();
    editor.style.fontFamily = f.family ? `"${f.family}", ui-monospace, monospace` : '';
    const size = noteSize || f.size;
    editor.style.fontSize = size ? size + 'px' : '';
    editor.style.fontWeight = f.bold ? '700' : '';
    editor.style.fontStyle = f.italic ? 'italic' : '';
  }

  // the size every note uses: a change to it (or to the theme) drops this note's own size
  const sizeKey = (s) => s.theme + '|' + ((s.fonts[s.theme] || {}).size || '');

  function applySettings(next) {
    if (S && sizeKey(S) !== sizeKey(next)) noteSize = null;
    S = next;
    body.dataset.theme = S.theme;
    applyFont();
    renderStatus();
    if (!menuEl.hidden) renderMenu();
  }

  const themeSize = () => parseFloat(getComputedStyle(body).getPropertyValue('--size')) || 13;

  // -------------------------------------------------------------------------
  // saving + settings
  // -------------------------------------------------------------------------
  // First line with text: the hover text of the note's tab.
  const preview = (text) => (text.split('\n').find((l) => l.trim()) || '').trim().slice(0, 60);

  function onEdit() {
    const text = fullText();
    const empty = text.trim() === '' && !hasDrawing();
    api.update({ html: editor.innerHTML, preview: preview(text), empty });
    // all text gone: no longer saved (main drops the tab and tells every note)
    if (empty && isSaved()) { tabs = tabs.filter((t) => t.id !== note.id); renderTabs(); }
    renderSaveBtn(empty);
    renderStatus();
    revealCaret();
    queueShortcutScan();
  }

  // Change a setting locally right away, then tell every other note.
  function setSetting(patch) {
    const next = JSON.parse(JSON.stringify(S));
    if (patch.theme) next.theme = patch.theme;
    if (patch.font) next.fonts[patch.font.theme] = { ...font(), ...patch.font.value };
    if (patch.status) Object.assign(next.status, patch.status);
    if (typeof patch.onTop === 'boolean') next.onTop = patch.onTop;
    if (typeof patch.confirmDelete === 'boolean') next.confirmDelete = patch.confirmDelete;
    if (typeof patch.startup === 'boolean') next.startup = patch.startup;
    applySettings(next);
    api.setSettings(patch);
  }
  const setFont = (value) => setSetting({ font: { theme: S.theme, value } });
  const clampSize = (px) => Math.min(48, Math.max(8, px));
  // ⚙ size − / +: every note
  const stepSize = (d) => setFont({ size: clampSize((font().size || themeSize()) + d) });
  // ctrl+f+up / down: just this note, until it's closed
  function stepNoteSize(d) {
    const base = font().size || themeSize();
    const next = clampSize((noteSize || base) + d);
    noteSize = next === base ? null : next;
    applyFont();
    revealCaret();
  }

  function setDot(dot) {
    note.dot = dot;
    body.dataset.dot = dot;
    api.update({ dot });
  }

  api.onSettings(applySettings);

  // -------------------------------------------------------------------------
  // saved notes: the floppy button + the numbered tabs next to the +
  // -------------------------------------------------------------------------
  const isSaved = () => !!note && tabs.some((t) => t.id === note.id);

  function renderSaveBtn(empty = isEmpty()) {
    const saved = isSaved();
    btnSave.classList.toggle('saved', saved);
    btnSave.setAttribute('aria-pressed', String(saved));
    btnSave.setAttribute('aria-disabled', String(!saved && empty));
    btnSave.title = saved ? 'Saved' : 'Save';
    btnSave.querySelector('.txt').textContent = saved ? '[*]' : '[s]';
  }

  let tabsShown = false; // the first render (note opening) doesn't animate
  function renderTabs() {
    const known = new Set([...tabsEl.children].map((b) => b.dataset.id));
    const animateNew = tabsShown;
    tabsShown = true;
    tabsEl.innerHTML = '';
    for (const t of tabs) {
      const b = document.createElement('button');
      const current = note && t.id === note.id;
      b.className = 'tab' + (current ? ' current' : '') + (t.open ? '' : ' closed') + (animateNew && !known.has(t.id) ? ' fresh' : '');
      b.dataset.id = t.id;
      b.textContent = String(t.slot);
      b.title = t.title ? `${t.slot} · ${t.title}` : `saved note ${t.slot}`;
      b.setAttribute('aria-label', b.title);
      b.addEventListener('click', () => {
        if (current) { focusEditor(); return; }
        api.openSaved(t.id);
      });
      tabsEl.appendChild(b);
    }
    renderSaveBtn();
  }

  function saveNote() {
    if (isSaved() || isEmpty()) { focusEditor(); return; }
    // the html is already sent on every edit; send it once more so main has
    // exactly this text when it saves
    onEdit();
    api.save();
    btnSave.classList.add('pop');
    setTimeout(() => btnSave.classList.remove('pop'), 300);
    focusEditor();
  }

  btnSave.addEventListener('click', saveNote);
  if (api.onTabs) api.onTabs((next) => { tabs = next || []; renderTabs(); });
  if (!api.save) btnSave.hidden = true; // web demo: nothing to save to

  // -------------------------------------------------------------------------
  // shortcuts
  // -------------------------------------------------------------------------
  // The bracketed keys can be edited in place; the rest are fixed. Grouped
  // with a blank line and a small heading between groups, easier to scan.
  const SHORTCUTS_HINT = 'to change a shortcut, just edit it in its [brackets]';
  const shortcutLines = () => {
    const bound = (a) => `${Keys.LABELS[a]} [${S.shortcuts[a]}]`;
    const groups = [
      ['notes', [bound('add'), bound('del'), bound('open'), 'switch note: tab']],
      ['window', ['resize note: ctrl + arrows', 'move note: alt + arrows']],
      ['text', ['font size, this note: ctrl + f + up / down', 'separator: /line + enter', 'draw: /draw + enter (any key stops)']],
    ];
    return [SHORTCUTS_HINT, ...groups.flatMap(([name, lines]) => ['', `── ${name}`, ...lines])];
  };

  // Settings -> shortcuts: write the list into the note (at the end).
  function insertShortcuts() {
    editor.focus();
    const sel = getSelection();
    const r = document.createRange();
    r.selectNodeContents(editor);
    r.collapse(false);
    sel.removeAllRanges();
    sel.addRange(r);
    const text = fullText();
    const lead = text.length === 0 ? '' : text.endsWith('\n') ? '' : '<br>';
    document.execCommand('insertHTML', false, lead + shortcutLines().map(esc).join('<br>'));
    onEdit();
  }

  // Editing a key inside the brackets ("open notr [ctrl+alt+n]") changes the
  // shortcut. Waits until typing pauses so half-typed keys are never used.
  let scanTimer = null;
  function queueShortcutScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scanShortcuts, 700);
  }
  function scanShortcuts() {
    for (const { action, combo } of Keys.parseLines(fullText())) {
      if (!combo || combo === S.shortcuts[action]) continue;
      if (Keys.ACTIONS.some((a) => a !== action && S.shortcuts[a] === combo)) continue;
      api.setSettings({ shortcut: { action, combo } });
    }
  }

  // -------------------------------------------------------------------------
  // editor behaviour
  // -------------------------------------------------------------------------
  editor.addEventListener('input', onEdit);

  editor.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (e.key === 'Enter' && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      if (slashCommand()) return;
      // keep the note flat: line breaks instead of nested <div>s
      document.execCommand('insertLineBreak');
    }
  });

  // A slash command + Enter on a line of its own:
  //   /line  a separator line across the note
  //   /draw  draw anywhere on the note, until a key is pressed (see "drawing" below)
  const SLASH = {
    '/line': () => document.execCommand('insertHTML', false, '<hr>'),
    '/draw': () => { document.execCommand('delete'); startDraw(); },
  };
  function slashCommand() {
    const sel = getSelection();
    if (!sel.rangeCount || !sel.isCollapsed) return false;
    const pre = document.createRange();
    pre.selectNodeContents(editor);
    pre.setEnd(sel.focusNode, sel.focusOffset);
    const box = document.createElement('div');
    box.appendChild(pre.cloneContents());
    const lineBefore = serialize(box, false).split('\n').pop();
    const cmd = lineBefore.trim().toLowerCase();
    if (!SLASH[cmd]) return false;
    // select the typed command (and any spaces around it) and swap it for what it makes
    for (let i = 0; i < lineBefore.length; i++) sel.modify('extend', 'backward', 'character');
    if (sel.toString().trim().toLowerCase() !== cmd) { sel.collapseToEnd(); return false; }
    SLASH[cmd]();
    onEdit();
    return true;
  }

  // -------------------------------------------------------------------------
  // drawing: "/draw" + Enter, then draw anywhere on the note
  // -------------------------------------------------------------------------
  // Draw mode: the pointer draws, over the text or below it, with no box and
  // no border. The first key you press ends it: enter and esc only end it,
  // any other key also does what it always does (so you just carry on
  // typing). ctrl+z takes back the last stroke; right-click for more.
  //
  // The strokes live in one layer per note: a <div class="ink"> with an <svg>
  // in it, first in the editor, laid over the text and taking no room of its
  // own. It's part of the note's HTML, so it's saved with the note, and it's
  // drawn in the theme's text colour (currentColor). It stays where it was
  // drawn: text that moves or rewraps moves under it.
  const SVGNS = 'http://www.w3.org/2000/svg';
  let drawMode = false;
  let stroke = null; // { path, pts } while a stroke is being drawn

  function inkLayer(make) {
    let layer = editor.querySelector(':scope > .ink');
    if (!layer && make) {
      layer = document.createElement('div');
      layer.className = 'ink';
      layer.contentEditable = 'false';
      layer.innerHTML = `<svg xmlns="${SVGNS}"></svg>`;
      editor.prepend(layer);
    }
    return layer;
  }
  const inkSvg = (make) => { const l = inkLayer(make); return l && l.querySelector('svg'); };

  // While drawing, the layer grows to the lowest point so far. An svg with no
  // height draws nothing at all, so without this a new layer's first stroke
  // only showed once it was finished.
  function growInk(y) {
    const layer = inkLayer(false);
    if (layer && y + 4 > (parseFloat(layer.style.height) || 0)) layer.style.height = Math.ceil(y + 4) + 'px';
  }

  // The layer is as tall as its lowest stroke, so the note scrolls to it.
  // No strokes: no layer.
  function fitInk() {
    const layer = inkLayer(false);
    if (!layer) return;
    const paths = layer.querySelectorAll('path');
    if (!paths.length) { layer.remove(); return; }
    let bottom = 0;
    for (const p of paths) { const b = p.getBBox(); bottom = Math.max(bottom, b.y + b.height); }
    layer.style.height = Math.ceil(bottom + 4) + 'px';
  }

  const r1 = (n) => Math.round(n * 10) / 10;
  // A smooth line through the points: curves from midpoint to midpoint.
  function strokePath(pts) {
    const [x0, y0] = pts[0];
    let d = `M${r1(x0)} ${r1(y0)}`;
    if (pts.length === 1) return d + 'l0 0'; // a dot (the round cap draws it)
    for (let i = 1; i < pts.length - 1; i++) {
      const [x, y] = pts[i], [nx, ny] = pts[i + 1];
      d += `Q${r1(x)} ${r1(y)} ${r1((x + nx) / 2)} ${r1((y + ny) / 2)}`;
    }
    const [lx, ly] = pts[pts.length - 1];
    return d + `L${r1(lx)} ${r1(ly)}`;
  }

  function startDraw() {
    closeMenu();
    drawMode = true;
    body.classList.add('draw-mode');
  }
  function stopDraw() {
    if (!drawMode) return;
    drawMode = false;
    stroke = null;
    body.classList.remove('draw-mode');
    fitInk();
    onEdit();
    focusEditor();
  }
  function undoStroke() {
    const svg = inkSvg(false);
    if (svg && svg.lastElementChild) svg.lastElementChild.remove();
    fitInk();
    onEdit();
  }
  function clearInk() {
    const layer = inkLayer(false);
    if (layer) layer.remove();
    onEdit();
  }

  // A point in the note's own coordinates (they scroll with the text).
  function inkPoint(ev) {
    const r = editor.getBoundingClientRect();
    return [ev.clientX - r.left, ev.clientY - r.top];
  }

  // In draw mode the editor lets the pointer through (see note.css), so the
  // scrolling area under it gets it.
  scroller.addEventListener('pointerdown', (e) => {
    if (!drawMode || e.button !== 0) return;
    if (e.offsetX >= scroller.clientWidth) return; // the scrollbar
    e.preventDefault(); // the caret stays where it was
    closeMenu();
    scroller.setPointerCapture(e.pointerId);
    const path = document.createElementNS(SVGNS, 'path');
    inkSvg(true).appendChild(path);
    stroke = { path, pts: [inkPoint(e)] };
    growInk(stroke.pts[0][1]);
    path.setAttribute('d', strokePath(stroke.pts));
  });

  scroller.addEventListener('pointermove', (e) => {
    if (!stroke) return;
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    for (const ev of evs.length ? evs : [e]) {
      const [x, y] = inkPoint(ev);
      const [px, py] = stroke.pts[stroke.pts.length - 1];
      if (Math.hypot(x - px, y - py) >= 1.5) { stroke.pts.push([x, y]); growInk(y); }
    }
    stroke.path.setAttribute('d', strokePath(stroke.pts));
  });

  function endStroke() {
    if (!stroke) return;
    stroke = null;
    fitInk();
    onEdit();
  }
  scroller.addEventListener('pointerup', endStroke);
  scroller.addEventListener('pointercancel', endStroke);
  scroller.addEventListener('lostpointercapture', endStroke);

  // The first key ends draw mode (before anything else sees it).
  const LONE_MODS = ['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock'];
  window.addEventListener('keydown', (e) => {
    if (!drawMode || e.isComposing || LONE_MODS.includes(e.key)) return;
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.code === 'KeyZ') {
      e.preventDefault();
      e.stopPropagation();
      undoStroke();
      return;
    }
    const onlyStops = e.key === 'Enter' || e.key === 'Escape';
    stopDraw();
    if (onlyStops) { e.preventDefault(); e.stopPropagation(); }
  }, true);

  function drawItems() {
    const svg = inkSvg(false);
    const strokes = svg ? svg.querySelectorAll('path').length : 0;
    return [
      { label: 'undo stroke', hint: 'ctrl+z', disabled: !strokes, keep: true, run: undoStroke },
      { label: 'clear drawing', disabled: !strokes, keep: true, run: clearInk },
      { sep: true },
      { label: 'stop drawing', hint: 'any key', run: stopDraw },
    ];
  }

  // Copying a separator: other apps get a drawn line (──────) as text, and a
  // real line in apps that take formatted text. Pasting it back into notr
  // turns it into a separator again.
  function copySelection(e) {
    const sel = getSelection();
    if (!sel.rangeCount || sel.isCollapsed) return false;
    const range = sel.getRangeAt(0);
    if (!editor.contains(range.commonAncestorContainer)) return false;
    const box = document.createElement('div');
    box.appendChild(range.cloneContents());
    if (!box.querySelector('hr')) return false; // nothing special: let the browser copy
    e.preventDefault();
    e.clipboardData.setData('text/plain', serialize(box, false, HR_TEXT));
    e.clipboardData.setData('text/html', box.innerHTML);
    return true;
  }
  editor.addEventListener('copy', copySelection);
  editor.addEventListener('cut', (e) => {
    if (copySelection(e)) document.execCommand('delete');
  });

  const isHrLine = (line) => /^\s*[─━]{3,}\s*$/.test(line);

  // paste as plain text so notes stay clean
  editor.addEventListener('paste', (e) => {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData('text/plain');
    if (!text) return;
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    let html = '';
    lines.forEach((line, i) => {
      const hr = isHrLine(line);
      if (i > 0 && !hr && !isHrLine(lines[i - 1])) html += '<br>';
      html += hr ? '<hr>' : esc(line);
    });
    document.execCommand('insertHTML', false, html);
  });

  document.addEventListener('selectionchange', () => {
    const sel = getSelection();
    if (sel.rangeCount && editor.contains(sel.anchorNode)) {
      lastRange = sel.getRangeAt(0).cloneRange();
      if (S && S.status.pos) renderStatus();
      revealCaret();
    }
  });

  function restoreSelection() {
    const sel = getSelection();
    if (sel.rangeCount && editor.contains(sel.anchorNode)) return;
    editor.focus();
    if (lastRange) {
      sel.removeAllRanges();
      sel.addRange(lastRange);
    }
  }

  function focusEditor() {
    editor.focus();
    const sel = getSelection();
    if (lastRange) {
      sel.removeAllRanges();
      sel.addRange(lastRange);
    } else if (!editor.contains(sel.anchorNode)) {
      const r = document.createRange();
      r.selectNodeContents(editor);
      r.collapse(false);
      sel.removeAllRanges();
      sel.addRange(r);
    }
  }

  // -------------------------------------------------------------------------
  // formatting commands (right-click menu)
  // -------------------------------------------------------------------------
  function exec(cmd, value) {
    restoreSelection();
    document.execCommand('styleWithCSS', false, cmd === 'fontName');
    document.execCommand(cmd, false, value);
    document.execCommand('styleWithCSS', false, false);
    onEdit();
  }

  function unwrap(el) { el.replaceWith(...el.childNodes); }

  function applySize(px) {
    restoreSelection();
    const sel = getSelection();
    if (!sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    if (!editor.contains(range.commonAncestorContainer)) return;

    if (range.collapsed) {
      // no selection: what you type next gets this size
      const span = document.createElement('span');
      span.style.fontSize = px + 'px';
      span.textContent = '​';
      range.insertNode(span);
      const r = document.createRange();
      r.setStart(span.firstChild, 1);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
    } else {
      document.execCommand('styleWithCSS', false, false);
      document.execCommand('fontSize', false, '7');
      const made = [];
      editor.querySelectorAll('font[size="7"]').forEach((f) => {
        const s = document.createElement('span');
        s.style.fontSize = px + 'px';
        while (f.firstChild) s.appendChild(f.firstChild);
        f.replaceWith(s);
        made.push(s);
      });
      editor.querySelectorAll('span').forEach((s) => {
        if (/xxx-large/.test(s.style.fontSize)) { s.style.fontSize = px + 'px'; made.push(s); }
      });
      made.forEach((s) => s.querySelectorAll('[style]').forEach((c) => {
        c.style.fontSize = '';
        if (!c.getAttribute('style') && c.nodeName === 'SPAN') unwrap(c);
      }));
      if (made.length) {
        const r = document.createRange();
        r.setStartBefore(made[0]);
        r.setEndAfter(made[made.length - 1]);
        sel.removeAllRanges();
        sel.addRange(r);
      }
    }
    onEdit();
  }

  function selectAll() {
    editor.focus();
    const r = document.createRange();
    r.selectNodeContents(editor);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }

  const hasSelection = () => {
    const sel = getSelection();
    return sel.rangeCount > 0 && !sel.isCollapsed && editor.contains(sel.anchorNode);
  };
  const cmdState = (c) => { try { return document.queryCommandState(c); } catch (_) { return false; } };

  // -------------------------------------------------------------------------
  // menus
  // -------------------------------------------------------------------------
  let menuKind = null;
  let menuStack = [];
  let menuAt = null;

  const onOff = (v) => (v ? 'on' : 'off');

  function settingsItems() {
    const f = font();
    const t = THEMES.find((x) => x.id === S.theme) || THEMES[0];
    return [
      { label: 'theme', hint: t.label + ' ›', sub: themeItems },
      { sep: true },
      { label: 'font', hint: (f.family ? f.family.toLowerCase() : 'theme default') + ' ›', sub: fontItems },
      {
        type: 'stepper', label: 'size', value: f.size || themeSize(),
        dec: () => stepSize(-1),
        inc: () => stepSize(1),
        reset: () => setFont({ size: null }),
      },
      { label: 'bold', check: f.bold, hint: onOff(f.bold), keep: true, run: () => setFont({ bold: !font().bold }) },
      { label: 'italic', check: f.italic, hint: onOff(f.italic), keep: true, run: () => setFont({ italic: !font().italic }) },
      { sep: true },
      { label: 'line / col', check: S.status.pos, hint: onOff(S.status.pos), keep: true, run: () => setSetting({ status: { pos: !S.status.pos } }) },
      { label: 'chars', check: S.status.chars, hint: onOff(S.status.chars), keep: true, run: () => setSetting({ status: { chars: !S.status.chars } }) },
      { sep: true },
      { label: 'always on top', check: S.onTop, hint: onOff(S.onTop), keep: true, run: () => setSetting({ onTop: !S.onTop }) },
      { label: 'ask before delete', check: S.confirmDelete, hint: onOff(S.confirmDelete), keep: true, run: () => setSetting({ confirmDelete: !S.confirmDelete }) },
      // in utilr, starting at login is utilr's setting, not notr's
      ...(S.hosted ? [] : [{ label: platform === 'win32' ? 'start with windows' : 'start at login', check: S.startup, hint: onOff(S.startup), keep: true, run: () => setSetting({ startup: !S.startup }) }]),
      { sep: true },
      { label: 'shortcuts', hint: 'write in note', run: insertShortcuts },
    ];
  }

  function themeItems() {
    return THEMES.map((t) => ({
      label: t.label, check: t.id === S.theme, swatch: t.sw, keep: true,
      run: () => setSetting({ theme: t.id }),
    }));
  }

  function fontItems() {
    const cur = font().family;
    return [
      { label: 'theme default', check: !cur, keep: true, run: () => setFont({ family: null }) },
      ...FONTS.map((name) => ({
        label: name.toLowerCase(), font: name, check: cur === name, keep: true,
        run: () => setFont({ family: name }),
      })),
    ];
  }

  function contextItems() {
    const sel = hasSelection();
    return [
      { label: 'cut', hint: 'ctrl+x', disabled: !sel, run: () => api.edit('cut') },
      { label: 'copy', hint: 'ctrl+c', disabled: !sel, run: () => api.edit('copy') },
      { label: 'paste', hint: 'ctrl+v', run: () => { restoreSelection(); api.edit('paste'); } },
      { label: 'select all', run: selectAll },
      { sep: true },
      { label: 'bold', hint: 'ctrl+b', check: cmdState('bold'), run: () => exec('bold') },
      { label: 'italic', hint: 'ctrl+i', check: cmdState('italic'), run: () => exec('italic') },
      { label: 'underline', hint: 'ctrl+u', check: cmdState('underline'), run: () => exec('underline') },
      { label: 'font', hint: '›', sub: () => FONTS.map((name) => ({ label: name.toLowerCase(), font: name, run: () => exec('fontName', name) })) },
      { label: 'size', hint: '›', sub: () => SIZES.map((px) => ({ label: px + ' px', run: () => applySize(px) })) },
      { sep: true },
      { label: 'clear formatting', disabled: !sel, run: () => exec('removeFormat') },
      { sep: true },
      { label: 'draw', hint: '/draw', run: startDraw },
      ...(inkSvg(false) ? [{ label: 'clear drawing', run: clearInk }] : []),
    ];
  }

  function openMenu(kind, itemsFn, at) {
    menuKind = kind;
    menuStack = [itemsFn];
    menuAt = at;
    menuEl.hidden = false;
    body.classList.add('menu-open');
    btnSettings.setAttribute('aria-expanded', kind === 'settings' ? 'true' : 'false');
    renderMenu();
  }

  function closeMenu() {
    if (menuEl.hidden) return;
    menuEl.hidden = true;
    menuEl.innerHTML = '';
    menuKind = null;
    menuStack = [];
    body.classList.remove('menu-open');
    btnSettings.setAttribute('aria-expanded', 'false');
  }

  function renderMenu() {
    const items = menuStack[menuStack.length - 1]();
    menuEl.innerHTML = '';
    if (menuStack.length > 1) {
      const back = button('mi head', `<span class="mi-l"><span class="mi-mark">‹</span>back</span><span class="mi-r">esc</span>`);
      back.addEventListener('click', () => { menuStack.pop(); renderMenu(); });
      menuEl.appendChild(back);
      menuEl.appendChild(Object.assign(document.createElement('div'), { className: 'sep' }));
    }
    for (const it of items) {
      if (it.sep) {
        menuEl.appendChild(Object.assign(document.createElement('div'), { className: 'sep' }));
        continue;
      }
      if (it.type === 'stepper') {
        const row = document.createElement('div');
        row.className = 'stepper';
        row.innerHTML = `<span class="label"><span class="mi-mark"></span>${esc(it.label)}</span>
          <span class="st-ctrl"><button data-a="dec" aria-label="Smaller">−</button><button class="val" data-a="reset" title="Reset to theme size">${it.value}</button><button data-a="inc" aria-label="Bigger">+</button></span>`;
        row.addEventListener('click', (e) => {
          const a = e.target.closest('button') && e.target.closest('button').dataset.a;
          if (a) { it[a](); renderMenu(); }
        });
        menuEl.appendChild(row);
        continue;
      }
      const mark = it.check ? '>' : '';
      const sw = it.swatch ? `<span class="sw" style="background:${it.swatch}"></span>` : '';
      const labelStyle = it.font ? ` style="font-family:'${it.font}', monospace"` : '';
      const b = button('mi' + (it.danger ? ' danger' : ''),
        `<span class="mi-l"><span class="mi-mark">${mark}</span><span${labelStyle}>${esc(it.label)}</span>${sw}</span><span class="mi-r">${esc(it.hint || '')}</span>`);
      b.disabled = !!it.disabled;
      b.setAttribute('role', 'menuitem');
      b.addEventListener('click', () => {
        if (it.sub) { menuStack.push(it.sub); renderMenu(); return; }
        if (it.keep) { it.run(); renderMenu(); return; }
        closeMenu();
        it.run();
      });
      menuEl.appendChild(b);
    }
    positionMenu();
  }

  function button(cls, html) {
    const b = document.createElement('button');
    b.className = cls;
    b.innerHTML = html;
    return b;
  }

  function positionMenu() {
    const vw = innerWidth, vh = innerHeight;
    if (menuKind === 'settings') {
      // Always below the title bar, so the gear and × stay visible and
      // clickable. In a small note the menu gets shorter and scrolls.
      const top = document.querySelector('.bar').getBoundingClientRect().bottom + 2;
      menuEl.style.maxHeight = Math.max(60, vh - top - 6) + 'px';
      const w = menuEl.offsetWidth;
      menuEl.style.left = Math.max(6, vw - w - 6) + 'px';
      menuEl.style.top = top + 'px';
      return;
    }
    menuEl.style.maxHeight = '';
    const w = menuEl.offsetWidth, h = menuEl.offsetHeight;
    menuEl.style.left = Math.max(6, Math.min(menuAt.x, vw - w - 6)) + 'px';
    menuEl.style.top = Math.max(6, Math.min(menuAt.y, vh - h - 6)) + 'px';
  }

  // keep the editor's selection while clicking menu items
  menuEl.addEventListener('mousedown', (e) => e.preventDefault());

  btnSettings.addEventListener('click', () => {
    if (menuKind === 'settings') closeMenu();
    else openMenu('settings', settingsItems);
  });

  document.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const t = e.target instanceof Element ? e.target : null;
    if (!t || !t.closest('.body')) return;
    if (drawMode) { openMenu('context', drawItems, { x: e.clientX, y: e.clientY }); return; }
    const sel = getSelection();
    if (!editor.contains(sel.anchorNode)) focusEditor();
    openMenu('context', contextItems, { x: e.clientX, y: e.clientY });
  });

  document.addEventListener('mousedown', (e) => {
    if (menuEl.hidden) return;
    if (menuEl.contains(e.target) || btnSettings.contains(e.target)) return;
    closeMenu();
  });

  // -------------------------------------------------------------------------
  // title bar buttons
  // -------------------------------------------------------------------------
  $('btn-new').addEventListener('click', () => api.newNote());

  $('btn-dot').addEventListener('click', () => {
    setDot(DOTS[(DOTS.indexOf(note.dot) + 1) % DOTS.length]);
  });

  function askClose() {
    closeMenu();
    // a saved note is only closed, never deleted: nothing to ask
    if (isSaved() || isEmpty() || !S.confirmDelete) { api.closeNote(); return; }
    confirmEl.hidden = false;
    $('confirm-yes').focus();
  }
  function cancelClose() {
    confirmEl.hidden = true;
    focusEditor();
  }
  function deleteDontAsk() {
    api.setSettings({ confirmDelete: false });
    api.closeNote();
  }
  $('btn-close').addEventListener('click', askClose);
  $('confirm-yes').addEventListener('click', () => api.closeNote());
  $('confirm-no').addEventListener('click', cancelClose);
  $('confirm-dont').addEventListener('click', deleteDontAsk);

  // -------------------------------------------------------------------------
  // keyboard
  // -------------------------------------------------------------------------
  // ctrl+f+up / down is a chord: while ctrl and f are held, the up / down
  // arrows change this note's font size instead of resizing the note.
  let fHeld = false;
  const isF = (e) => e.code === 'KeyF';

  document.addEventListener('keydown', (e) => {
    if (!confirmEl.hidden) {
      const k = e.key.toLowerCase();
      if (k === 'y' || k === 'enter') { e.preventDefault(); api.closeNote(); }
      else if (k === 'n' || k === 'escape') { e.preventDefault(); cancelClose(); }
      else if (k === 'd') { e.preventDefault(); deleteDontAsk(); }
      return;
    }
    if (e.key === 'Escape') {
      if (menuStack.length > 1) { menuStack.pop(); renderMenu(); }
      else closeMenu();
      return;
    }
    if (!S) return;

    if (isF(e) && e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
      fHeld = true;
      api.kbdStop(); // a resize that was already gliding stops here
    }

    // ctrl+f+up / down: this note's font size, one step per press (or key repeat)
    const arrow = ARROWS[e.key];
    if (arrow && fHeld && e.ctrlKey) {
      e.preventDefault();
      if ((arrow === 'up' || arrow === 'down') && !e.shiftKey && !e.altKey && !e.metaKey) {
        stepNoteSize(arrow === 'up' ? 1 : -1);
      }
      return;
    }

    // ctrl+arrows resize the note, alt+arrows move it, for as long as the key
    // is held (ctrl+shift+arrows still select words)
    if (arrow && !e.shiftKey && !e.metaKey && e.ctrlKey !== e.altKey) {
      e.preventDefault();
      if (!e.repeat) api.kbdStart(e.ctrlKey ? 'resize' : 'move', arrow);
      return;
    }

    // tab / shift+tab: jump to the next / previous note
    if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      closeMenu();
      api.cycle(e.shiftKey ? -1 : 1);
      return;
    }

    const combo = Keys.fromEvent(e);
    if (!combo) return;
    if (combo === S.shortcuts.add) { e.preventDefault(); api.newNote(); }
    else if (combo === S.shortcuts.del) { e.preventDefault(); askClose(); }
  });

  const ARROWS = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
  document.addEventListener('keyup', (e) => {
    if (isF(e)) fHeld = false;
    if (ARROWS[e.key]) api.kbdStop(ARROWS[e.key]);
    else if (e.key === 'Control' || e.key === 'Alt') {
      if (e.key === 'Control') fHeld = false;
      api.kbdStop();
      if (e.key === 'Alt') e.preventDefault(); // don't let Windows open the window menu
    }
  });

  // -------------------------------------------------------------------------
  // window focus / hover
  // -------------------------------------------------------------------------
  window.addEventListener('focus', () => {
    body.classList.add('focused');
    if (confirmEl.hidden && document.activeElement !== editor) focusEditor();
  });
  window.addEventListener('blur', () => {
    body.classList.remove('focused');
    closeMenu();
    fHeld = false;
    api.kbdStop(); // never keep gliding after focus leaves
  });
  document.documentElement.addEventListener('mouseenter', () => body.classList.add('hover'));
  document.documentElement.addEventListener('mouseleave', () => body.classList.remove('hover'));
  window.addEventListener('resize', () => {
    if (!menuEl.hidden) positionMenu();
    revealCaret();
  });

  api.onFocusEditor(focusEditor);

  // -------------------------------------------------------------------------
  // start
  // -------------------------------------------------------------------------
  (async () => {
    const data = await api.init();
    if (!data) return;
    note = data.note;
    if (data.platform) platform = data.platform;
    editor.innerHTML = note.html || '';
    body.dataset.dot = note.dot || 'green';
    applySettings(data.settings);
    tabs = data.tabs || [];
    renderTabs();
    if (document.hasFocus()) {
      body.classList.add('focused');
      focusEditor();
    }
  })();
})();
