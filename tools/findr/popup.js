'use strict';

// The popup: type, and every file and folder with that in its name.
//   type              find (words in any order, "a phrase", *.pdf, docs\name)
//   ↑ ↓ pgup pgdn tab move
//   enter / click     open it
//   ctrl+enter        open the folder it's in (shift+enter too)
//   ctrl+shift+c      copy its path (ctrl+c too, when nothing is selected)
//   shift+del         forget it (in the recent list)
//   ctrl+r            read the drives again
//   ctrl+,            settings          esc   clear the find, then close
(() => {
  const api = window.findr;
  const Keys = window.FindrKeys;
  const $ = (id) => document.getElementById(id);
  const body = document.body;
  const list = $('list');
  const find = $('find');
  const menuEl = $('menu');

  let S = null;         // settings
  let ST = null;        // the index: { roots, total, scanning }
  let items = [];       // what's shown
  let total = 0;
  let ms = 0;
  let recentMode = true;
  let sel = 0;
  let q = '';
  let ask = 0;          // so an old answer never overwrites a newer one
  let menuOpen = false;
  let menuSel = -1;
  let recording = false;
  let keyNote = null;
  let noteTimer = null;
  let flashTimer = null;
  let detailTimer = null;
  let againTimer = null;
  let charW = 0;

  // ---------------------------------------------------------------------------
  // formatting
  // ---------------------------------------------------------------------------

  const num = (n) => Math.round(n).toLocaleString('en-US');
  const drive = (root) => root.length <= 3 ? root.slice(0, 1).toLowerCase() + ':' : root.toLowerCase();

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
    const head = Math.max(6, Math.floor(n * 0.4));
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
  // the list
  // ---------------------------------------------------------------------------

  function emptyText() {
    const st = ST || {};
    const where = (st.roots || []).map((r) => drive(r.root)).join(' ');
    if (q) return st.scanning ? 'no match yet\nstill reading your drives' : 'no match';
    if (!st.total && st.scanning) return 'reading your drives\nthe first time takes a minute';
    if (!st.total) return 'starting…';
    return `type to find\n${num(st.total)} files and folders on ${where}`;
  }

  function render() {
    list.textContent = '';
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
    const width = list.clientWidth - 12 - 24; // the list's padding, the row's padding
    const fit = charW ? Math.floor(width / charW) : 0;
    const marks = recentMode ? [] : needles();
    const frag = document.createDocumentFragment();
    items.forEach((it, i) => {
      const row = document.createElement('div');
      row.className = 'hit' + (it.isDir ? ' dir' : '');
      row.dataset.i = i;
      row.setAttribute('role', 'option');
      const hl = document.createElement('div');
      hl.className = 'hl';
      const hn = document.createElement('span');
      hn.className = 'hn';
      fill(hn, it.name, marks);
      if (it.isDir && !/\\$/.test(it.name)) {
        const s = document.createElement('span');
        s.className = 'slash';
        s.textContent = '\\';
        hn.append(s);
      }
      const hm = document.createElement('span');
      hm.className = 'hm';
      hl.append(hn, hm);
      const hp = document.createElement('div');
      hp.className = 'hp';
      hp.textContent = middle(it.dir || '', fit);
      hp.title = it.dir || '';
      row.append(hl, hp);
      frag.append(row);
    });
    list.append(frag);
    select(Math.min(sel, items.length - 1));
    status();
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
    if (!items[i]) return;
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
    const left = $('st-left');
    if (st.scanning) {
      left.textContent = 'reading ' + (st.roots || []).filter((r) => r.scanning).map((r) => `${drive(r.root)} ${num(r.found)}`).join(' · ');
    } else if (q) {
      left.textContent = `${num(total)} found${ms ? ` in ${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms` : ''}`;
    } else {
      left.textContent = st.total ? `${num(st.total)} on ${(st.roots || []).map((r) => drive(r.root)).join(' ')}` : '';
    }
    $('st-right').textContent = items.length ? 'enter open · ctrl+enter folder · ctrl+shift+c path' : '';
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
    if (!items[sel]) return;
    const r = await api.open(sel, how);
    if (!r) return;
    if (r.note) flash(r.note);
    if (!r.ok && r.error) {
      flash(r.error);
      if (r.error === 'gone') refresh(true);
    }
  }

  function forgetCurrent() {
    if (!recentMode || !items[sel]) return;
    api.forget(sel);
    items.splice(sel, 1);
    total = items.length;
    render();
  }

  // ---------------------------------------------------------------------------
  // the settings menu
  // ---------------------------------------------------------------------------

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function row({ act: a, label, sub = '', value = '', mark = '', cls = '', valueCls = '', data = '' }) {
    return `<button class="mi ${cls}" role="menuitem" data-act="${a}" ${data}>` +
      `<span class="mi-l"><span class="mi-mark">${mark}</span>${esc(label)}${sub ? `<span class="sub">${esc(sub)}</span>` : ''}</span>` +
      `<span class="mi-r ${valueCls}">${esc(value)}</span></button>`;
  }

  function renderMenu() {
    if (!S) return;
    let keyValue = Keys.label(S.key) + (S.keyOk ? '' : ' (taken)');
    let keyCls = S.keyOk ? '' : 'bad';
    if (recording) { keyValue = 'press keys'; keyCls = 'rec'; } else if (keyNote) { keyValue = keyNote; keyCls = 'bad'; }
    let html = '<div class="mi head">drives</div>';
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
    html += row({ act: 'key', label: 'key', value: keyValue, valueCls: keyCls });
    html += '<div class="sep"></div>';
    html += row({ act: 'rescan', label: 'read drives again', value: 'ctrl+r' });
    menuEl.innerHTML = html;
    menuItems().forEach((b, i) => b.classList.toggle('active', i === menuSel));
  }
  const menuItems = () => [...menuEl.querySelectorAll('.mi[data-act]')];

  function openMenu() {
    menuOpen = true;
    menuSel = -1;
    renderMenu();
    menuEl.hidden = false;
    $('btn-menu').setAttribute('aria-expanded', 'true');
    window.Ghost.menuOpen(true);
  }
  function closeMenu() {
    if (!menuOpen) return;
    stopRecording();
    menuOpen = false;
    menuEl.hidden = true;
    $('btn-menu').setAttribute('aria-expanded', 'false');
    window.Ghost.menuOpen(false);
    find.focus();
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
    if (a === 'drive') {
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
  $('btn-menu').addEventListener('mousedown', (e) => e.preventDefault());
  $('btn-menu').addEventListener('click', () => (menuOpen ? closeMenu() : openMenu()));
  $('btn-close').addEventListener('click', () => api.hide());
  document.addEventListener('mousedown', (e) => {
    if (menuOpen && !menuEl.contains(e.target) && !e.target.closest('#btn-menu')) closeMenu();
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
    switch (e.key) {
      case 'Escape': e.preventDefault(); closeMenu(); break;
      case 'ArrowDown': e.preventDefault(); menuSel = (menuSel + 1) % all.length; renderMenu(); break;
      case 'ArrowUp': e.preventDefault(); menuSel = (menuSel - 1 + all.length) % all.length; renderMenu(); break;
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

    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); select(sel + 1); break;
      case 'ArrowUp': e.preventDefault(); select(sel - 1); break;
      case 'PageDown': e.preventDefault(); select(sel + 8); break;
      case 'PageUp': e.preventDefault(); select(sel - 8); break;
      case 'Tab': e.preventDefault(); select(sel + (e.shiftKey ? -1 : 1)); break;
      case 'Enter': e.preventDefault(); act(ctrl || e.shiftKey ? 'folder' : 'open'); break;
      case 'Escape':
        e.preventDefault();
        if (q) { find.value = ''; q = ''; refresh(); } else api.hide();
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
    act(e.ctrlKey || e.shiftKey ? 'folder' : 'open');
  });

  // ---------------------------------------------------------------------------
  // from main
  // ---------------------------------------------------------------------------

  // every time it opens: nothing typed, what you opened last, the list drops in.
  // (null: the same, but keep what's typed and ask again)
  api.onShow((r) => {
    if (!r) { refresh(true); return; }
    ask++;
    closeMenu();
    if (!charW) charW = $('ruler').getBoundingClientRect().width / 10;
    q = '';
    find.value = '';
    S = r.settings;
    take(r, false);
    list.classList.remove('in');
    void list.offsetWidth;
    list.classList.add('in');
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

  api.onSettings((s) => { S = s; if (menuOpen) renderMenu(); });
  api.onKeyTaken((text) => note(text));

  window.addEventListener('focus', () => { if (!menuOpen) find.focus(); });
})();
