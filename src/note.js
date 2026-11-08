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
      init: async () => ({ note: { id: 'preview', dot: 'green', html: '' }, settings: s }),
      update: noop, newNote: noop, closeNote: noop, quit: noop, cycle: noop,
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

  let note = null;
  let platform = 'win32';
  let S = null; // settings shared by all notes: theme, fonts, status, shortcuts
  let lastRange = null;

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
          if (BLOCK.test(c.nodeName) && out && !out.endsWith('\n')) { out += '\n'; lastWasBr = false; }
          walk(c);
        }
      }
    })(root);
    if (full && lastWasBr) out = out.slice(0, -1);
    return out;
  }

  const fullText = () => serialize(editor, true);

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
    editor.style.fontSize = f.size ? f.size + 'px' : '';
    editor.style.fontWeight = f.bold ? '700' : '';
    editor.style.fontStyle = f.italic ? 'italic' : '';
  }

  function applySettings(next) {
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
  function onEdit() {
    api.update({ html: editor.innerHTML });
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

  function setDot(dot) {
    note.dot = dot;
    body.dataset.dot = dot;
    api.update({ dot });
  }

  api.onSettings(applySettings);

  // -------------------------------------------------------------------------
  // shortcuts
  // -------------------------------------------------------------------------
  // The bracketed keys can be edited in place; the rest are fixed.
  const SHORTCUTS_HINT = 'to change a shortcut, just edit the key in its [brackets]';
  const shortcutLines = () => [
    SHORTCUTS_HINT,
    ...Keys.ACTIONS.map((a) => `${Keys.LABELS[a]} [${S.shortcuts[a]}]`),
    'switch note: tab',
    'resize note: ctrl + arrows',
    'move note: alt + arrows',
    'separator: /line + enter',
  ];

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

  // "/line" + Enter on a line of its own -> a separator line across the note.
  function slashCommand() {
    const sel = getSelection();
    if (!sel.rangeCount || !sel.isCollapsed) return false;
    const pre = document.createRange();
    pre.selectNodeContents(editor);
    pre.setEnd(sel.focusNode, sel.focusOffset);
    const box = document.createElement('div');
    box.appendChild(pre.cloneContents());
    const lineBefore = serialize(box, false).split('\n').pop();
    if (lineBefore.trim().toLowerCase() !== '/line') return false;
    // select the typed command (and any spaces around it) and swap it for the line
    for (let i = 0; i < lineBefore.length; i++) sel.modify('extend', 'backward', 'character');
    if (sel.toString().trim().toLowerCase() !== '/line') { sel.collapseToEnd(); return false; }
    document.execCommand('insertHTML', false, '<hr>');
    onEdit();
    return true;
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
        dec: () => setFont({ size: Math.max(8, (font().size || themeSize()) - 1) }),
        inc: () => setFont({ size: Math.min(48, (font().size || themeSize()) + 1) }),
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
      { label: platform === 'win32' ? 'start with windows' : 'start at login', check: S.startup, hint: onOff(S.startup), keep: true, run: () => setSetting({ startup: !S.startup }) },
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
    if (fullText().trim() === '' || !S.confirmDelete) { api.closeNote(); return; }
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

    // ctrl+arrows resize the note, alt+arrows move it, for as long as the key
    // is held (ctrl+shift+arrows still select words)
    const arrow = ARROWS[e.key];
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
    if (ARROWS[e.key]) api.kbdStop(ARROWS[e.key]);
    else if (e.key === 'Control' || e.key === 'Alt') {
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
    if (document.hasFocus()) {
      body.classList.add('focused');
      focusEditor();
    }
  })();
})();
