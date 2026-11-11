'use strict';

// The popup: everything copied today, newest first.
//   type            find
//   ↑ ↓ pgup pgdn   move              enter         paste (or copy, see settings)
//   shift+enter     copy only         shift+del     remove that clip
//   ctrl+p          pause / resume    ctrl+shift+del  clear all (asks first)
//   ctrl+,          settings          esc           clear the find, then close
(() => {
  const api = window.clipr;
  const Keys = window.CliprKeys;
  const $ = (id) => document.getElementById(id);
  const body = document.body;
  const list = $('list');
  const find = $('find');
  const menuEl = $('menu');
  const confirmEl = $('confirm');

  let S = null;        // settings
  let items = [];      // what's shown
  let count = 0;       // clips in all
  let sel = 0;
  let q = '';
  let ask = 0;         // so an old answer never overwrites a newer one
  let menuOpen = false;
  let menuSel = -1;
  let recording = false;
  let keyNote = null;
  let noteTimer = null;
  let confirming = false;

  // ---------------------------------------------------------------------------
  // the list
  // ---------------------------------------------------------------------------

  const pad = (n) => String(n).padStart(2, '0');
  const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  function when(t) {
    const d = new Date(t), now = new Date();
    const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return d.toDateString() === now.toDateString() ? hm : `${DAYS[d.getDay()]} ${hm}`;
  }

  // the text, with what you're looking for marked
  function fill(el, text) {
    text = text.replace(/^\s*\n/, '').replace(/\s+$/, '');
    if (!q) { el.textContent = text; return; }
    const lower = text.toLowerCase(), needle = q.toLowerCase();
    let at = 0;
    for (let i = lower.indexOf(needle); i !== -1; i = lower.indexOf(needle, at)) {
      if (i > at) el.append(text.slice(at, i));
      const m = document.createElement('mark');
      m.textContent = text.slice(i, i + needle.length);
      el.append(m);
      at = i + needle.length;
    }
    if (at < text.length) el.append(text.slice(at));
  }

  function render() {
    list.textContent = '';
    if (!items.length) {
      const e = document.createElement('div');
      e.className = 'empty';
      e.textContent = q ? 'no match' : S && S.paused ? 'paused' : 'nothing copied yet';
      list.append(e);
    }
    const frag = document.createDocumentFragment();
    items.forEach((it, i) => {
      const row = document.createElement('div');
      row.className = 'clip';
      row.dataset.i = i;
      row.setAttribute('role', 'option');
      const ct = document.createElement('div');
      ct.className = 'ct';
      fill(ct, it.text);
      const cm = document.createElement('div');
      cm.className = 'cm';
      const t = document.createElement('span');
      t.textContent = when(it.at);
      cm.append(t);
      if (it.lines > 1) {
        const l = document.createElement('span');
        l.textContent = `${it.lines} lines`;
        cm.append(l);
      }
      row.append(ct, cm);
      frag.append(row);
    });
    list.append(frag);
    select(Math.min(sel, items.length - 1));
    status();
  }

  function select(i, scroll = true) {
    if (!items.length) { sel = 0; return; }
    sel = Math.max(0, Math.min(items.length - 1, i));
    for (const el of list.children) el.classList.toggle('sel', +el.dataset.i === sel);
    const el = list.children[sel];
    if (scroll && el) el.scrollIntoView({ block: 'nearest' });
  }

  function status() {
    if (!S) return;
    body.classList.toggle('paused', !!S.paused);
    body.classList.toggle('finding', !!q);
    $('title').textContent = q ? 'find' : 'clipr';
    const left = $('st-left');
    if (S.paused) left.innerHTML = '<span class="on">paused</span>  ctrl+p resume';
    else left.textContent = q ? `${items.length} of ${count}` : `${count} today`;
    const pasting = S.canPaste && S.paste;
    $('st-right').textContent = items.length ? (pasting ? 'enter paste · shift+enter copy' : 'enter copy') : '';
  }

  // keep the same clip selected when the list changes under you
  async function refresh(keepId) {
    const n = ++ask;
    const r = await api.list(q);
    if (!r || n !== ask) return;
    items = r.items;
    count = r.count;
    S = r.settings;
    if (keepId !== undefined) {
      const i = items.findIndex((it) => it.id === keepId);
      sel = i < 0 ? Math.min(sel, items.length - 1) : i;
    } else {
      sel = 0;
    }
    render();
  }

  const current = () => items[sel];

  function pick(mode) {
    const it = current();
    if (it) api.pick(it.id, mode);
  }

  function removeCurrent() {
    const it = current();
    if (!it) return;
    const next = items[sel + 1] || items[sel - 1];
    api.remove(it.id);
    items.splice(sel, 1);
    count--;
    render();
    if (next) select(items.indexOf(next));
  }

  // ---------------------------------------------------------------------------
  // confirm strip: "clear all 14?  [y]es  [n]o"
  // ---------------------------------------------------------------------------

  function askClear() {
    if (!count) return;
    closeMenu();
    confirming = true;
    $('confirm-label').textContent = `clear all ${count}?`;
    confirmEl.hidden = false;
  }
  function endConfirm(yes) {
    confirming = false;
    confirmEl.hidden = true;
    if (yes) api.clear();
    find.focus();
  }
  $('confirm-yes').addEventListener('click', () => endConfirm(true));
  $('confirm-no').addEventListener('click', () => endConfirm(false));

  // ---------------------------------------------------------------------------
  // the settings menu
  // ---------------------------------------------------------------------------

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function row({ act, label, value = '', mark = '', cls = '', valueCls = '' }) {
    return `<button class="mi ${cls}" role="menuitem" data-act="${act}">` +
      `<span class="mi-l"><span class="mi-mark">${mark}</span>${esc(label)}</span>` +
      `<span class="mi-r ${valueCls}">${esc(value)}</span></button>`;
  }
  const toggleRow = (act, label, on) => row({ act, label, value: on ? 'on' : 'off', mark: on ? '&gt;' : '' });

  function renderMenu() {
    if (!S) return;
    let keyValue = Keys.label(S.key) + (S.keyOk ? '' : ' (taken)');
    let keyCls = S.keyOk ? '' : 'bad';
    if (recording) { keyValue = 'press keys'; keyCls = 'rec'; } else if (keyNote) { keyValue = keyNote; keyCls = 'bad'; }
    let html = '';
    if (S.canPaste) html += toggleRow('paste', 'paste on pick', S.paste);
    html += row({ act: 'at', label: 'appears at', value: S.at });
    html += row({ act: 'key', label: 'shortcut', value: keyValue, valueCls: keyCls });
    html += '<div class="sep"></div>';
    html += toggleRow('paused', 'pause recording', S.paused);
    html += row({ act: 'clear', label: 'clear history', value: 'ctrl+shift+del', cls: 'danger' });
    menuEl.innerHTML = html;
    menuItems().forEach((b, i) => b.classList.toggle('active', i === menuSel));
  }
  const menuItems = () => [...menuEl.querySelectorAll('.mi')];

  function openMenu() {
    if (confirming) return;
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

  function act(a) {
    if (a !== 'key') stopRecording();
    if (a === 'paste') api.setSettings({ paste: !S.paste });
    else if (a === 'at') api.setSettings({ at: S.at === 'pointer' ? 'center' : 'pointer' });
    else if (a === 'paused') api.setSettings({ paused: !S.paused });
    else if (a === 'clear') askClear();
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
    if (b) act(b.dataset.act);
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
      case 'Enter': case ' ': e.preventDefault(); if (all[menuSel]) act(all[menuSel].dataset.act); break;
      default:
        if (e.ctrlKey && e.key === ',') { e.preventDefault(); closeMenu(); }
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
    if (confirming) {
      e.preventDefault();
      if (e.key === 'y' || e.key === 'Enter') endConfirm(true);
      else if (e.key === 'n' || e.key === 'Escape') endConfirm(false);
      return;
    }
    if (menuOpen) { menuKey(e); return; }

    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key === ',') { e.preventDefault(); openMenu(); return; }
    if (ctrl && e.code === 'KeyP') { e.preventDefault(); api.setSettings({ paused: !S.paused }); return; }
    if (ctrl && e.shiftKey && e.key === 'Delete') { e.preventDefault(); askClear(); return; }
    if (e.shiftKey && e.key === 'Delete') { e.preventDefault(); removeCurrent(); return; }
    if (ctrl && e.code === 'KeyW') { e.preventDefault(); api.hide(); return; }

    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); select(sel + 1); break;
      case 'ArrowUp': e.preventDefault(); select(sel - 1); break;
      case 'PageDown': e.preventDefault(); select(sel + 7); break;
      case 'PageUp': e.preventDefault(); select(sel - 7); break;
      case 'Home': if (!q) { e.preventDefault(); select(0); } break;
      case 'End': if (!q) { e.preventDefault(); select(items.length - 1); } break;
      case 'Tab': e.preventDefault(); select(sel + (e.shiftKey ? -1 : 1)); break;
      case 'Enter': e.preventDefault(); pick(e.shiftKey ? 'copy' : 'paste'); break;
      case 'Escape':
        e.preventDefault();
        if (q) { find.value = ''; q = ''; refresh(); } else api.hide();
        break;
      default:
    }
  });

  list.addEventListener('mousemove', (e) => {
    const r = e.target.closest('.clip');
    if (r && +r.dataset.i !== sel) select(+r.dataset.i, false);
  });
  list.addEventListener('mousedown', (e) => e.preventDefault()); // the find keeps focus
  list.addEventListener('click', (e) => {
    const r = e.target.closest('.clip');
    if (!r) return;
    select(+r.dataset.i, false);
    pick(e.shiftKey ? 'copy' : 'paste');
  });

  // ---------------------------------------------------------------------------
  // from main
  // ---------------------------------------------------------------------------

  // every time it opens: newest on top, nothing typed, the list drops in
  api.onShow((r) => {
    ask++;
    closeMenu();
    if (confirming) { confirming = false; confirmEl.hidden = true; }
    q = '';
    find.value = '';
    items = r.items;
    count = r.count;
    S = r.settings;
    sel = 0;
    render();
    list.scrollTop = 0;
    list.classList.remove('in');
    void list.offsetWidth;
    list.classList.add('in');
    find.focus();
  });

  api.onHide(() => { closeMenu(); });
  api.onChanged(() => { const it = current(); refresh(it ? it.id : undefined); });
  api.onSettings((s) => { S = s; status(); if (menuOpen) renderMenu(); if (!items.length) render(); });
  api.onKeyTaken((text) => note(text));

  window.addEventListener('focus', () => { if (!menuOpen) find.focus(); });
})();
