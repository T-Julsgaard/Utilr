'use strict';

// The palette: the colors you picked, newest first, as square swatches.
//   click / enter     copy (in the format set under the gear)
//   right click       copy as hex / rgb / hsl, remove
//   arrows            move          del   remove          tab   hex → rgb → hsl
//   p / +             pick another  esc   close
(() => {
  const api = window.paletr;
  const Keys = window.PaletrKeys;
  const Color = window.PaletrColor;
  const $ = (id) => document.getElementById(id);
  const grid = $('grid'), empty = $('empty'), menu = $('menu'), gear = $('btn-menu');
  const confirmEl = $('confirm');

  let S = null;          // state from main
  let drawn = '';        // the colors the grid was last built from
  let sel = -1;          // keyboard selection
  let hover = -1;        // swatch under the pointer
  let msg = null;        // { left, right } shown in the status for a moment
  let msgTimer = null;

  // menus: the gear's (settings) or a swatch's (right click)
  let menuKind = null;   // null | 'gear' | 'swatch'
  let page = 'main';     // gear pages: 'main' | 'format'
  let menuHex = null;    // the swatch a right-click menu is for
  let active = -1;       // keyboard row in an open menu
  let recording = false; // recording a new pick key
  let keyNote = null, noteTimer = null;

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

  // --- the grid ---------------------------------------------------------------

  function renderGrid() {
    const key = S.colors.join();
    if (key !== drawn) {
      drawn = key;
      grid.innerHTML = S.colors.map((c, i) =>
        `<button class="tile" role="option" data-i="${i}" aria-label="${c}" style="background:${c}"></button>`).join('');
    }
    sel = S.colors.length ? Math.min(Math.max(sel, -1), S.colors.length - 1) : -1;
    hover = Math.min(hover, S.colors.length - 1);
    for (const t of grid.children) t.classList.toggle('sel', +t.dataset.i === sel);
    empty.hidden = S.colors.length > 0;
    $('empty-key').textContent = Keys.label(S.key);
  }

  function renderStatus() {
    const i = hover >= 0 ? hover : sel;
    const c = S.colors[i];
    let left, right;
    if (msg) ({ left, right } = msg);
    else if (c) {
      left = Color.format(c, S.format);
      right = S.format === 'hex' ? Color.format(c, 'rgb') : c;
    } else {
      left = plural(S.colors.length, 'color');
      right = 'copy as ' + S.format;
    }
    $('st-left').textContent = left;
    $('st-right').textContent = right;
  }

  function render() {
    if (!S) return;
    renderGrid();
    renderStatus();
    if (menuKind) renderMenu();
  }

  function say(left, right, ms = 1400) {
    clearTimeout(msgTimer);
    msg = { left, right };
    document.body.classList.add('flash');
    renderStatus();
    msgTimer = setTimeout(() => { msg = null; document.body.classList.remove('flash'); renderStatus(); }, ms);
  }

  async function copy(hex, fmt) {
    if (!hex) return;
    const text = await api.copy(hex, fmt);
    if (text) say(text, 'copied');
  }

  function remove(hex) {
    if (!hex) return;
    api.remove(hex);
    say(hex, 'removed');
  }

  function select(i) {
    if (!S.colors.length) return;
    sel = Math.max(0, Math.min(S.colors.length - 1, i));
    render();
    const t = grid.children[sel];
    if (t) t.scrollIntoView({ block: 'nearest' });
  }

  // how many swatches fit on a row, read from the layout
  function columns() {
    const tiles = grid.children;
    if (!tiles.length) return 1;
    const top = tiles[0].offsetTop;
    let n = 0;
    while (n < tiles.length && tiles[n].offsetTop === top) n++;
    return Math.max(1, n);
  }

  grid.addEventListener('mousemove', (e) => {
    const t = e.target.closest('.tile');
    const i = t ? +t.dataset.i : -1;
    if (i !== hover) { hover = i; renderStatus(); }
  });
  grid.addEventListener('mouseleave', () => { hover = -1; renderStatus(); });
  grid.addEventListener('click', (e) => {
    const t = e.target.closest('.tile');
    if (!t) return;
    sel = +t.dataset.i;
    render();
    copy(S.colors[sel]);
  });
  grid.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const t = e.target.closest('.tile');
    if (!t) return;
    sel = +t.dataset.i;
    render();
    openMenu('swatch', { x: e.clientX, y: e.clientY });
  });

  // --- menus --------------------------------------------------------------------

  function row({ act, label, value = '', mark = '', cls = '', valueCls = '', disabled = false }) {
    return `<button class="mi ${cls}" role="menuitem" data-act="${esc(act)}"${disabled ? ' disabled' : ''}>` +
      `<span class="mi-l"><span class="mi-mark">${mark}</span>${esc(label)}</span>` +
      `<span class="mi-r ${valueCls}">${esc(value)}</span></button>`;
  }
  const sep = '<div class="sep"></div>';

  function keyValue() {
    if (recording) return { value: 'press keys…', valueCls: 'rec' };
    if (keyNote) return { value: keyNote.text, valueCls: keyNote.bad ? 'bad' : '' };
    return { value: Keys.label(S.key) + (S.keyOk ? '' : ' (taken)'), valueCls: S.keyOk ? '' : 'bad' };
  }

  function renderMenu() {
    let html = '';
    if (menuKind === 'swatch') {
      const c = menuHex;
      for (const f of Color.FORMATS) html += row({ act: 'copy:' + f, label: f, value: Color.format(c, f), mark: f === S.format ? '&gt;' : '' });
      html += sep;
      html += row({ act: 'remove', label: 'remove', value: 'del', cls: 'danger' });
    } else if (page === 'format') {
      const sample = S.colors[sel] || S.colors[0] || '#1e90ff';
      html += row({ act: 'back', label: 'back', value: 'esc', mark: '‹' });
      html += sep;
      for (const f of Color.FORMATS) html += row({ act: 'format:' + f, label: f, value: Color.format(sample, f), mark: f === S.format ? '&gt;' : '' });
    } else {
      html += row({ act: 'format', label: 'copy as', value: S.format + ' ›' });
      html += row({ act: 'key', label: 'pick shortcut', ...keyValue() });
      html += sep;
      html += row({ act: 'pick', label: 'pick a color', value: 'p' });
      html += sep;
      html += row({ act: 'clear', label: 'clear palette', cls: 'danger', disabled: !S.colors.length });
    }
    menu.innerHTML = html;
    const rows = menu.querySelectorAll('.mi');
    rows.forEach((r, i) => r.classList.toggle('active', i === active));
  }

  function place(at) {
    const w = menu.offsetWidth, h = menu.offsetHeight;
    let x, y;
    if (at) {
      x = Math.min(at.x, innerWidth - w - 6);
      y = at.y + h > innerHeight - 6 ? Math.max(6, at.y - h) : at.y;
    } else {
      // under the gear, against the right edge, like notr's
      const bar = document.querySelector('.bar').getBoundingClientRect();
      x = innerWidth - w - 6;
      y = bar.bottom;
    }
    menu.style.left = Math.max(6, x) + 'px';
    menu.style.top = Math.max(6, y) + 'px';
    menu.style.maxHeight = Math.max(60, innerHeight - Math.max(6, y) - 6) + 'px';
  }

  function openMenu(kind, at) {
    stopRecording();
    menuKind = kind;
    page = 'main';
    active = -1;
    menuHex = kind === 'swatch' ? S.colors[sel] : null;
    menu.hidden = false;
    renderMenu();
    place(at);
    gear.setAttribute('aria-expanded', kind === 'gear' ? 'true' : 'false');
    window.Ghost.menuOpen(true);
  }

  function closeMenu() {
    if (!menuKind) return;
    stopRecording();
    menuKind = null;
    menu.hidden = true;
    gear.setAttribute('aria-expanded', 'false');
    window.Ghost.menuOpen(false);
  }

  function stopRecording() {
    if (!recording) return;
    recording = false;
    api.recordKey(false);
    if (menuKind) renderMenu();
  }

  function note(text, bad) {
    clearTimeout(noteTimer);
    keyNote = { text, bad };
    if (menuKind) renderMenu();
    noteTimer = setTimeout(() => { keyNote = null; if (menuKind) renderMenu(); }, 1600);
  }

  function act(a) {
    if (a === 'back') { page = 'main'; active = -1; renderMenu(); return; }
    if (a === 'format') { page = 'format'; active = -1; renderMenu(); place(); return; }
    if (a.startsWith('format:')) { api.setSettings({ format: a.slice(7) }); page = 'main'; return; }
    if (a.startsWith('copy:')) { const hex = menuHex; closeMenu(); copy(hex, a.slice(5)); return; }
    if (a === 'remove') { const hex = menuHex; closeMenu(); remove(hex); return; }
    if (a === 'key') {
      if (recording) { stopRecording(); return; }
      recording = true;
      api.recordKey(true);
      renderMenu();
      return;
    }
    if (a === 'pick') { closeMenu(); api.pick(); return; }
    if (a === 'clear') { closeMenu(); askClear(); }
  }

  menu.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b || b.disabled) return;
    if (recording && b.dataset.act !== 'key') stopRecording();
    act(b.dataset.act);
  });
  menu.addEventListener('mousedown', (e) => e.preventDefault());
  gear.addEventListener('click', () => (menuKind === 'gear' ? closeMenu() : openMenu('gear')));
  document.addEventListener('mousedown', (e) => {
    if (menuKind && !menu.contains(e.target) && !gear.contains(e.target)) closeMenu();
  });
  window.addEventListener('blur', () => { stopRecording(); });
  window.addEventListener('resize', () => { if (menuKind === 'gear') place(); });

  function moveActive(dir) {
    const rows = [...menu.querySelectorAll('.mi')];
    if (!rows.length) return;
    let i = active;
    for (let k = 0; k < rows.length; k++) {
      i = (i + dir + rows.length) % rows.length;
      if (!rows[i].disabled) break;
    }
    active = i;
    rows.forEach((r, j) => r.classList.toggle('active', j === active));
  }

  // --- clear: a strip, not a dialog ---------------------------------------------

  function askClear() {
    if (!S.colors.length) return;
    $('confirm-label').textContent = `clear ${plural(S.colors.length, 'color')}?`;
    confirmEl.hidden = false;
  }
  const closeConfirm = () => { confirmEl.hidden = true; };
  $('yes').addEventListener('click', () => { closeConfirm(); api.clear(); say('palette cleared', ''); });
  $('no').addEventListener('click', closeConfirm);

  // --- keys -----------------------------------------------------------------------

  function recordKey(e) {
    e.preventDefault();
    if (e.key === 'Escape') { stopRecording(); return; }
    if (['Control', 'Alt', 'Shift', 'Meta', 'AltGraph'].includes(e.key)) return;
    const combo = Keys.normalize(Keys.fromEvent(e));
    recording = false;
    api.recordKey(false);
    if (!combo) { note('add ctrl or alt', true); return; }
    if (combo === S.key) { renderMenu(); return; }
    api.setSettings({ key: combo });
  }

  document.addEventListener('keydown', (e) => {
    if (!S) return;
    if (recording) { recordKey(e); return; }

    if (!confirmEl.hidden) {
      e.preventDefault();
      if (e.key === 'y' || e.key === 'Enter') $('yes').click();
      else if (e.key === 'n' || e.key === 'Escape') closeConfirm();
      return;
    }

    if (menuKind) {
      if (e.key === 'Escape') { e.preventDefault(); if (page !== 'main') act('back'); else closeMenu(); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); moveActive(1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); moveActive(-1); return; }
      if (e.key === 'Enter') {
        e.preventDefault();
        const r = menu.querySelectorAll('.mi')[active];
        if (r && !r.disabled) r.click();
        return;
      }
      if (e.key === 'ArrowLeft' && page !== 'main') { e.preventDefault(); act('back'); return; }
      return;
    }

    const mod = e.ctrlKey || e.metaKey;
    const cols = columns();
    const go = (d) => { e.preventDefault(); select(sel < 0 ? 0 : sel + d); };
    switch (e.key) {
      case 'ArrowRight': go(1); return;
      case 'ArrowLeft': go(-1); return;
      case 'ArrowDown': go(cols); return;
      case 'ArrowUp': go(-cols); return;
      case 'Home': e.preventDefault(); select(0); return;
      case 'End': e.preventDefault(); select(S.colors.length - 1); return;
      case 'Enter': e.preventDefault(); copy(S.colors[sel]); return;
      case 'Delete': case 'Backspace': e.preventDefault(); remove(S.colors[sel]); return;
      case 'Tab': {
        e.preventDefault();
        const all = Color.FORMATS;
        const f = all[(all.indexOf(S.format) + (e.shiftKey ? -1 : 1) + all.length) % all.length];
        api.setSettings({ format: f });
        say('copy as ' + f, '');
        return;
      }
      case 'Escape': e.preventDefault(); api.close(); return;
      default:
    }
    if (mod && e.code === 'KeyC') { e.preventDefault(); copy(S.colors[sel]); return; }
    if (mod && e.code === 'KeyW') { e.preventDefault(); api.close(); return; }
    if (!mod && !e.altKey && (e.key === 'p' || e.key === '+')) { e.preventDefault(); api.pick(); }
  });

  $('btn-pick').addEventListener('click', () => api.pick());
  $('btn-close').addEventListener('click', () => api.close());

  api.onState((s) => {
    const fresh = S && s.colors[0] && s.colors[0] !== S.colors[0];
    S = s;
    if (fresh) sel = 0; // a new pick: it's the one selected
    render();
  });
  api.onKeyTaken((label) => note(label + ' is taken', true));
  api.state().then((s) => { S = s; render(); });
})();
