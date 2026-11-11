'use strict';

// The popup: type, and every file and folder with that in its name.
//   type              find (words in any order, "a phrase", *.pdf, docs\name)
//   ↑ ↓ pgup pgdn tab move (in the bar and the line, ↓ first shows what you opened last)
//   enter / click     open it
//   ctrl+enter        open the folder it's in (shift+enter, or a click on its path, too)
//   ctrl+shift+c      copy its path (ctrl+c too, when nothing is selected)
//   shift+del         forget it (in the recent list)
//   ctrl+r            read the drives again
//   ctrl+,            settings (look: bar, window, line)
//   esc               clear the find, then close
(() => {
  const api = window.findr;
  const Keys = window.FindrKeys;
  const $ = (id) => document.getElementById(id);
  const body = document.body;
  const shell = $('shell');
  const list = $('list');
  const find = $('find');
  const menuEl = $('menu');
  const gears = [...document.querySelectorAll('.btn-menu')];

  let S = null;         // settings
  let ST = null;        // the index: { roots, total, scanning }
  let items = [];       // what's shown
  let total = 0;
  let ms = 0;
  let recentMode = true;
  let reveal = false;   // bar / line: the recent list, asked for with ↓
  let sel = 0;
  let q = '';
  let ask = 0;          // so an old answer never overwrites a newer one
  let menuOpen = false;
  let menuView = 'main'; // main | look
  let menuSel = -1;
  let recording = false;
  let keyNote = null;
  let noteTimer = null;
  let flashTimer = null;
  let detailTimer = null;
  let againTimer = null;
  let charW = 0;

  const look = () => (S && S.look) || 'bar';
  const compact = () => look() !== 'window'; // bar and line: one line per result, nothing until asked

  // ---------------------------------------------------------------------------
  // formatting
  // ---------------------------------------------------------------------------

  const num = (n) => Math.round(n).toLocaleString('en-US');
  const short = (n) => (n >= 10000 ? `${Math.round(n / 1000)}k` : num(n));
  const drive = (root) => (root.length <= 3 ? root.slice(0, 1).toLowerCase() + ':' : root.toLowerCase());

  function size(b) {
    if (b == null) return '';
    if (b < 1024) return `${b} b`;
    const u = ['kb', 'mb', 'gb', 'tb'];
    let v = b / 1024, i = 0;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
  }

  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const pad = (n) => String(n).padStart(2, '0');
  function when(t) {
    const d = new Date(t), now = new Date();
    if (d.toDateString() === now.toDateString()) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const day = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
    return d.getFullYear() === now.getFullYear() ? day : `${day} ${d.getFullYear()}`;
  }

  // a long folder keeps its start and its end: c:\users\…\project\src
  function middle(s, n) {
    if (!n || s.length <= n) return s;
    if (n < 8) return '…' + s.slice(s.length - Math.max(1, n - 1));
    const head = Math.max(4, Math.floor(n * 0.4));
    const tail = n - head - 1;
    return s.slice(0, head) + '…' + s.slice(s.length - tail);
  }

  // the plain pieces of what you typed, to mark in each name
  function needles() {
    const out = [];
    const re = /"([^"]*)"?|(\S+)/g;
    let m;
    while ((m = re.exec(q))) {
      const t = (m[1] !== undefined ? m[1] : m[2]).toLowerCase().replace(/\//g, '\\');
      for (const piece of t.split(/[*?\\]+/)) if (piece) out.push(piece);
    }
    return out;
  }

  function fill(el, text, marks) {
    if (!marks.length) { el.textContent = text; return; }
    const lower = text.toLowerCase();
    const hit = new Uint8Array(text.length);
    for (const n of marks) {
      for (let i = lower.indexOf(n); i !== -1; i = lower.indexOf(n, i + n.length)) hit.fill(1, i, i + n.length);
    }
    let at = 0;
    while (at < text.length) {
      let end = at;
      while (end < text.length && hit[end] === hit[at]) end++;
      const part = text.slice(at, end);
      if (hit[at]) { const m = document.createElement('mark'); m.textContent = part; el.append(m); } else el.append(part);
      at = end;
    }
  }

  // ---------------------------------------------------------------------------
  // the look
  // ---------------------------------------------------------------------------

  function applyLook() {
    for (const l of ['window', 'bar', 'line']) body.classList.toggle('l-' + l, look() === l);
    placeholder();
  }

  function placeholder() {
    const st = ST || {};
    if (!compact()) { find.placeholder = ''; return; }
    if (!st.total && st.scanning) find.placeholder = 'reading your drives…';
    else if (st.total) find.placeholder = `find in ${num(st.total)} files`;
    else find.placeholder = 'find a file';
  }

  // ---------------------------------------------------------------------------
  // the list
  // ---------------------------------------------------------------------------

  // bar / line: results only when there's something to show
  const showing = () => !compact() || !!q || reveal;

  function emptyText() {
    const st = ST || {};
    const where = (st.roots || []).map((r) => drive(r.root)).join(' ');
    if (q) return st.scanning ? 'no match yet · still reading your drives' : 'no match';
    if (compact()) return 'nothing opened yet';
    if (!st.total && st.scanning) return 'reading your drives\nthe first time takes a minute';
    if (!st.total) return 'starting…';
    return `type to find\n${num(st.total)} files and folders on ${where}`;
  }

  function render() {
    body.classList.toggle('open', showing());
    body.classList.toggle('typing', !!q);
    list.textContent = '';
    if (!showing()) { status(); return; }
    if (!items.length) {
      const e = document.createElement('div');
      e.className = 'empty';
      e.textContent = emptyText();
      list.append(e);
    } else if (recentMode) {
      const l = document.createElement('div');
      l.className = 'label';
      l.textContent = 'recent';
      list.append(l);
    }
    const marks = recentMode ? [] : needles();
    const frag = document.createDocumentFragment();
    items.forEach((it, i) => {
      const row = document.createElement('div');
      row.className = 'hit' + (it.isDir ? ' dir' : '');
      row.dataset.i = i;
      row.setAttribute('role', 'option');
      const hn = document.createElement('span');
      hn.className = 'hn';
      fill(hn, it.name, marks);
      if (it.isDir && !/\\$/.test(it.name)) {
        const s = document.createElement('span');
        s.className = 'slash';
        s.textContent = '\\';
        hn.append(s);
      }
      const hp = document.createElement('span');
      hp.className = 'hp';
      hp.title = it.dir || '';
      const hm = document.createElement('span');
      hm.className = 'hm';
      row.append(hn, hp, hm);
      frag.append(row);
    });
    list.append(frag);
    fitPaths();
    select(Math.min(sel, items.length - 1));
    status();
  }

  // each folder cut to the room its row has (DM Mono: every character is as wide)
  function fitPaths() {
    if (!charW) return;
    const els = list.querySelectorAll('.hit .hp');
    const widths = [...els].map((el) => el.clientWidth); // one layout, then all the writes
    els.forEach((el, i) => {
      // the text alone, so only the path itself (not the room after it) is a link
      const t = document.createElement('span');
      t.className = 'hpt';
      t.textContent = middle(items[i].dir || '', Math.floor(widths[i] / charW));
      el.replaceChildren(t);
    });
  }

  const rows = () => list.querySelectorAll('.hit');

  function select(i, scroll = true) {
    if (!items.length) { sel = 0; return; }
    sel = Math.max(0, Math.min(items.length - 1, i));
    for (const el of rows()) el.classList.toggle('sel', +el.dataset.i === sel);
    const el = rows()[sel];
    if (scroll && el) el.scrollIntoView({ block: 'nearest' });
    detailsSoon();
  }

  // size and date of the selected one, asked for when you stop on it
  function detailsSoon() {
    clearTimeout(detailTimer);
    for (const m of list.querySelectorAll('.hm')) m.textContent = '';
    const i = sel, n = ask;
    if (!items[i] || !showing()) return;
    detailTimer = setTimeout(async () => {
      const d = await api.details(i);
      if (!d || n !== ask || i !== sel) return;
      const el = rows()[i];
      if (!el) return;
      el.querySelector('.hm').textContent = d.gone ? 'gone' : [size(d.size), when(d.mtime)].filter(Boolean).join(' · ');
    }, 70);
  }

  function status() {
    const st = ST || {};
    body.classList.toggle('indexing', !!st.scanning);
    const reading = (st.roots || []).filter((r) => r.scanning).map((r) => `${drive(r.root)} ${short(r.found)}`).join(' · ');
    // window: the status line
    const left = $('st-left');
    if (st.scanning) left.textContent = 'reading ' + reading;
    else if (q) left.textContent = `${num(total)} found${ms ? ` in ${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms` : ''}`;
    else left.textContent = st.total ? `${num(st.total)} on ${(st.roots || []).map((r) => drive(r.root)).join(' ')}` : '';
    $('st-right').textContent = items.length ? 'enter open · ctrl+enter folder · ctrl+shift+c path' : '';
    // bar / line: a count in the find line
    $('count').textContent = q ? `${num(total)}${st.scanning ? ' · reading' : ''}` : st.scanning ? 'reading ' + reading : '';
    placeholder();
  }

  function take(r, keep) {
    items = r.items;
    total = r.total;
    ms = r.ms || 0;
    recentMode = !!r.recent;
    if (r.status) ST = r.status;
    sel = keep ? Math.min(sel, items.length - 1) : 0;
    render();
    if (!keep) list.scrollTop = 0;
  }

  async function refresh(keep = false) {
    const n = ++ask;
    const r = await api.search(q);
    if (!r || n !== ask) return;
    take(r, keep);
  }

  // ---------------------------------------------------------------------------
  // acting on a result
  // ---------------------------------------------------------------------------

  function flash(text) {
    const el = $('note');
    clearTimeout(flashTimer);
    el.textContent = text;
    el.classList.add('on');
    flashTimer = setTimeout(() => el.classList.remove('on'), 1400);
  }

  async function act(how) {
    if (!items[sel] || !showing()) return;
    const r = await api.open(sel, how);
    if (!r) return;
    if (r.note) flash(r.note);
    if (!r.ok && r.error) {
      flash(r.error);
      if (r.error === 'gone') refresh(true);
    }
  }

  function forgetCurrent() {
    if (!recentMode || !items[sel] || !showing()) return;
    api.forget(sel);
    items.splice(sel, 1);
    total = items.length;
    render();
  }

  // ---------------------------------------------------------------------------
  // the settings menu (and its look submenu)
  // ---------------------------------------------------------------------------

  const LOOKS = [
    { id: 'bar', about: 'just a search bar' },
    { id: 'window', about: 'details and a status line' },
    { id: 'line', about: 'a line across the top' },
  ];

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function row({ act: a, label, sub = '', value = '', mark = '', cls = '', valueCls = '', data = '' }) {
    return `<button class="mi ${cls}" role="menuitem" data-act="${a}" ${data}>` +
      `<span class="mi-l"><span class="mi-mark">${mark}</span>${esc(label)}${sub ? `<span class="sub">${esc(sub)}</span>` : ''}</span>` +
      `<span class="mi-r ${valueCls}">${esc(value)}</span></button>`;
  }

  function renderMenu() {
    if (!S) return;
    let html = '';
    if (menuView === 'look') {
      html += row({ act: 'back', label: 'back', mark: '‹', value: 'esc' });
      html += '<div class="sep"></div>';
      for (const l of LOOKS) html += row({ act: 'look', data: `data-look="${l.id}"`, label: l.id, sub: l.about, mark: S.look === l.id ? '&gt;' : '' });
    } else {
      let keyValue = Keys.label(S.key) + (S.keyOk ? '' : ' (taken)');
      let keyCls = S.keyOk ? '' : 'bad';
      if (recording) { keyValue = 'press keys'; keyCls = 'rec'; } else if (keyNote) { keyValue = keyNote; keyCls = 'bad'; }
      html += row({ act: 'looks', label: 'look', value: `${S.look} ›` });
      html += '<div class="sep"></div>';
      html += '<div class="mi head">drives</div>';
      for (const d of S.drives) {
        const count = ST && (ST.roots || []).find((r) => drive(r.root) === d.letter + ':');
        html += row({
          act: 'drive', data: `data-letter="${d.letter}"`, label: `${d.letter}:`,
          sub: [d.type, d.label].filter(Boolean).join(' · ').toLowerCase(),
          value: d.on ? (count ? num(count.scanning ? count.found : count.count) : 'on') : 'off',
          mark: d.on ? '&gt;' : '',
        });
      }
      for (const f of S.folders) html += row({ act: 'none', label: f.toLowerCase(), mark: '&gt;', value: 'folder' });
      html += '<div class="sep"></div>';
      html += row({ act: 'recent', label: 'remember opened', value: S.recent ? 'on' : 'off', mark: S.recent ? '&gt;' : '' });
      html += row({ act: 'key', label: 'shortcut', value: keyValue, valueCls: keyCls });
      html += '<div class="sep"></div>';
      html += row({ act: 'rescan', label: 'read drives again', value: 'ctrl+r' });
    }
    menuEl.innerHTML = html;
    const all = menuItems();
    if (menuSel >= all.length) menuSel = all.length - 1;
    all.forEach((b, i) => b.classList.toggle('active', i === menuSel));
  }
  const menuItems = () => [...menuEl.querySelectorAll('.mi[data-act]')];

  function openMenu(view = 'main') {
    menuOpen = true;
    menuView = view;
    // the look menu opens on the current look, so ↑ ↓ flips through them
    menuSel = view === 'look' ? 2 + LOOKS.findIndex((l) => l.id === look()) - 1 : -1;
    renderMenu();
    menuEl.hidden = false;
    for (const g of gears) g.setAttribute('aria-expanded', 'true');
    window.Ghost.menuOpen(true);
  }
  function closeMenu() {
    if (!menuOpen) return;
    stopRecording();
    menuOpen = false;
    menuEl.hidden = true;
    for (const g of gears) g.setAttribute('aria-expanded', 'false');
    window.Ghost.menuOpen(false);
    find.focus();
  }
  function showView(view) {
    stopRecording();
    menuView = view;
    menuSel = view === 'look' ? LOOKS.findIndex((l) => l.id === look()) + 1 : 0;
    renderMenu();
  }

  function stopRecording() {
    if (!recording) return;
    recording = false;
    api.recordKey(false);
    renderMenu();
  }

  function note(text) {
    clearTimeout(noteTimer);
    keyNote = text;
    renderMenu();
    noteTimer = setTimeout(() => { keyNote = null; renderMenu(); }, 1600);
  }

  function rescan() {
    api.rescan();
    flash('reading drives again');
  }

  function menuAct(b) {
    const a = b.dataset.act;
    if (a !== 'key') stopRecording();
    if (a === 'looks') showView('look');
    else if (a === 'back') showView('main');
    else if (a === 'look') { if (b.dataset.look !== look()) api.setSettings({ look: b.dataset.look }); }
    else if (a === 'drive') {
      const d = S.drives.find((x) => x.letter === b.dataset.letter);
      if (d) api.setSettings({ drive: { letter: d.letter, on: !d.on } });
    } else if (a === 'recent') api.setSettings({ recent: !S.recent });
    else if (a === 'rescan') { rescan(); closeMenu(); }
    else if (a === 'key') {
      if (recording) { stopRecording(); return; }
      recording = true;
      api.recordKey(true);
      renderMenu();
    }
  }

  menuEl.addEventListener('mousedown', (e) => e.preventDefault()); // the find keeps focus
  menuEl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (b) menuAct(b);
  });
  for (const g of gears) {
    g.addEventListener('mousedown', (e) => e.preventDefault());
    g.addEventListener('click', () => (menuOpen ? closeMenu() : openMenu()));
  }
  $('btn-close').addEventListener('click', () => api.hide());
  document.addEventListener('mousedown', (e) => {
    const inMenu = menuEl.contains(e.target) || e.target.closest('.btn-menu');
    if (menuOpen && !inMenu) closeMenu();
    // bar / line: the window is bigger than what you see; a click past it is
    // a click elsewhere
    if (compact() && !inMenu && !shell.contains(e.target)) { e.preventDefault(); api.hide(); }
  });

  function menuKey(e) {
    if (recording) {
      e.preventDefault();
      if (e.key === 'Escape') { stopRecording(); return; }
      if (['Control', 'Alt', 'Shift', 'Meta', 'AltGraph'].includes(e.key)) return;
      const combo = Keys.normalize(Keys.fromEvent(e));
      recording = false;
      api.recordKey(false);
      if (!combo) { note('add ctrl or alt'); return; }
      if (combo === S.key) { renderMenu(); return; }
      api.setSettings({ key: combo });
      return;
    }
    const all = menuItems();
    const move = (d) => { menuSel = (menuSel + d + all.length) % all.length; renderMenu(); };
    switch (e.key) {
      case 'Escape': e.preventDefault(); if (menuView !== 'main') showView('main'); else closeMenu(); break;
      case 'ArrowDown': e.preventDefault(); move(1); break;
      case 'ArrowUp': e.preventDefault(); move(-1); break;
      case 'ArrowRight': if (menuView === 'main' && all[menuSel] && all[menuSel].dataset.act === 'looks') { e.preventDefault(); showView('look'); } break;
      case 'ArrowLeft': case 'Backspace': if (menuView !== 'main') { e.preventDefault(); showView('main'); } break;
      case 'Enter': case ' ': e.preventDefault(); if (all[menuSel]) menuAct(all[menuSel]); break;
      default:
        if ((e.ctrlKey || e.metaKey) && e.key === ',') { e.preventDefault(); closeMenu(); }
    }
  }

  // ---------------------------------------------------------------------------
  // keys
  // ---------------------------------------------------------------------------

  find.addEventListener('input', () => {
    q = find.value;
    if (!q) reveal = false;
    refresh();
  });

  document.addEventListener('keydown', (e) => {
    if (menuOpen) { menuKey(e); return; }
    const ctrl = e.ctrlKey || e.metaKey;
    const picked = find.selectionStart !== find.selectionEnd;
    if (ctrl && e.key === ',') { e.preventDefault(); openMenu(); return; }
    if (ctrl && e.code === 'KeyR') { e.preventDefault(); rescan(); return; }
    if (ctrl && e.code === 'KeyW') { e.preventDefault(); api.hide(); return; }
    if (ctrl && e.code === 'KeyC' && (e.shiftKey || !picked)) { e.preventDefault(); act('copy'); return; }
    if (e.shiftKey && e.key === 'Delete') { e.preventDefault(); forgetCurrent(); return; }

    // bar / line, nothing typed: ↓ shows what you opened last, ↑ hides it again
    if (compact() && !q && !reveal && e.key === 'ArrowDown') { e.preventDefault(); reveal = true; render(); return; }
    if (compact() && !q && reveal && e.key === 'ArrowUp' && sel === 0) { e.preventDefault(); reveal = false; render(); return; }

    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); select(sel + 1); break;
      case 'ArrowUp': e.preventDefault(); select(sel - 1); break;
      case 'PageDown': e.preventDefault(); select(sel + 8); break;
      case 'PageUp': e.preventDefault(); select(sel - 8); break;
      case 'Tab': e.preventDefault(); select(sel + (e.shiftKey ? -1 : 1)); break;
      case 'Enter': e.preventDefault(); act(ctrl || e.shiftKey ? 'folder' : 'open'); break;
      case 'Escape':
        e.preventDefault();
        if (q) { find.value = ''; q = ''; reveal = false; refresh(); }
        else if (reveal) { reveal = false; render(); }
        else api.hide();
        break;
      default:
    }
  });

  list.addEventListener('mousemove', (e) => {
    const r = e.target.closest('.hit');
    if (r && +r.dataset.i !== sel) select(+r.dataset.i, false);
  });
  list.addEventListener('mousedown', (e) => e.preventDefault()); // the find keeps focus
  list.addEventListener('click', (e) => {
    const r = e.target.closest('.hit');
    if (!r) return;
    select(+r.dataset.i, false);
    // a click on the path goes to that folder
    act(e.ctrlKey || e.shiftKey || e.target.closest('.hpt') ? 'folder' : 'open');
  });

  // ---------------------------------------------------------------------------
  // from main
  // ---------------------------------------------------------------------------

  // Every time it opens: nothing typed, what you opened last, it drops in.
  // After a new look: what you'd typed, and the look menu, stay.
  // (null: the same popup, ask again)
  api.onShow((r) => {
    if (!r) { refresh(true); return; }
    ask++;
    closeMenu();
    S = r.settings;
    applyLook();
    if (!charW) charW = $('ruler').getBoundingClientRect().width / 10;
    q = r.q || '';
    find.value = q;
    reveal = false;
    take(r, false);
    for (const el of [list, shell]) {
      el.classList.remove('in');
      void el.offsetWidth;
      el.classList.add('in');
    }
    if (r.menu) openMenu(r.menu);
    find.focus();
  });

  api.onHide(() => { closeMenu(); });

  // While the drives are being read, a search you typed fills in as they are.
  api.onStatus((st) => {
    const was = ST && ST.total;
    ST = st;
    if (menuOpen) renderMenu();
    if (q && (st.scanning || was !== st.total) && !againTimer) {
      againTimer = setTimeout(() => { againTimer = null; if (q) refresh(true); }, 700);
    }
    if (!items.length) render(); else status();
  });

  api.onSettings((s) => { S = s; applyLook(); if (menuOpen) renderMenu(); });
  api.onKeyTaken((text) => note(text));

  window.addEventListener('focus', () => { if (!menuOpen) find.focus(); });
})();
