// The launcher: four pages.
//   tools       what's installed (click to open, › for its actions) and what isn't
//   quick view  which tools sit in the quick view, in what order
//   keys        every system-wide key in utilr, utilr's own and each tool's
//   settings    start with windows, where the quick view appears, quit
(() => {
  'use strict';

  const api = window.utilr;
  const Keys = window.UtilrKeys;
  const Dock = window.UtilrDock;
  const esc = Dock.esc;
  const $ = (id) => document.getElementById(id);
  const view = $('view');

  const TABS = ['tools', 'quick', 'keys', 'settings'];
  const PLACES = { center: 'center', cursor: 'at the pointer', left: 'left edge', right: 'right edge' };
  const PLACE_ORDER = ['center', 'cursor', 'left', 'right'];

  let S = null;              // state from utilr
  let tab = new URLSearchParams(location.search).get('tab');
  if (!TABS.includes(tab)) tab = 'tools';
  let expanded = null;       // tool whose actions are folded out
  let selected = -1;         // keyboard selection on the tools page
  const busy = new Set();    // tools being installed right now
  let recording = null;      // { owner, id } while a key is being recorded
  let keyNote = null;        // { owner, id, text } said in place of a key for a moment
  let noteTimer = null;
  let confirmYes = null;
  let flash = null;          // a message in the status line
  let flashTimer = null;

  const tool = (id) => S.tools.find((t) => t.id === id);
  const installed = () => S.tools.filter((t) => t.running);
  const available = () => S.tools.filter((t) => !t.running);

  // -------------------------------------------------------------------------
  // status line
  // -------------------------------------------------------------------------

  function renderStatus() {
    if (!S) return;
    const left = $('st-left');
    left.textContent = flash ? flash.text : `${installed().length} of ${S.tools.length} installed`;
    left.style.color = flash && flash.bad ? 'var(--danger)' : '';
    $('st-right').textContent = 'utilr ' + S.version;
  }

  function say(text, bad = false, ms = 2600) {
    flash = { text, bad };
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { flash = null; renderStatus(); }, ms);
    renderStatus();
    // the status line is part of the hover chrome: show it while it speaks
    document.body.classList.add('hover');
  }

  // -------------------------------------------------------------------------
  // pages
  // -------------------------------------------------------------------------

  const keyHint = (t) => (t.keys[0] ? Keys.label(t.keys[0].combo) : '');

  function toolRow(t, i) {
    const on = t.running;
    const isBusy = busy.has(t.id);
    const cls = ['tool', on ? 'installed' : 'available', expanded === t.id ? 'expanded' : '', selected === i ? 'sel' : ''].join(' ');
    const side = on
      ? `<span class="hint">${esc(keyHint(t))}</span>` +
        `<button class="act go" data-act="open" data-id="${t.id}" tabindex="-1">open</button>` +
        `<button class="act chev" data-act="more" data-id="${t.id}" aria-label="${esc(t.name)} actions" aria-expanded="${expanded === t.id}" tabindex="-1">›</button>`
      : `<button class="act install" data-act="install" data-id="${t.id}"${isBusy ? ' disabled' : ''}>${isBusy ? 'installing…' : 'install'}</button>`;
    let html =
      `<div class="${cls}" data-act="${on ? 'open' : 'install'}" data-id="${t.id}" data-i="${i}">` +
      `<div class="tile">${t.glyph}</div>` +
      `<div class="txt"><div class="name">${esc(t.name)}</div><div class="desc">${esc(t.description)}</div></div>` +
      `<div class="side">${side}</div></div>`;
    if (on && expanded === t.id) {
      html += '<div class="more">';
      for (const a of t.actions) {
        const k = t.keys.find((x) => x.id === a.key);
        html += row({ act: 'action', id: t.id, extra: `data-action="${esc(a.id)}"`, label: a.label, value: k ? Keys.label(k.combo) : '' });
      }
      html += row({ act: 'remove', id: t.id, label: 'remove', value: '', cls: 'danger' });
      html += '</div>';
    }
    return html;
  }

  function pageTools() {
    const inst = installed(), avail = available();
    let html = `<div class="sect"><span>installed</span><span>${inst.length}</span></div>`;
    html += inst.length
      ? inst.map((t, i) => toolRow(t, i)).join('')
      : '<div class="empty">nothing yet. install a tool below, it takes a second.</div>';
    html += `<div class="sect"><span>available</span><span>${avail.length}</span></div>`;
    html += avail.length
      ? avail.map((t, i) => toolRow(t, inst.length + i)).join('')
      : '<div class="empty">everything is installed. more tools come with updates.</div>';
    return html;
  }

  function row({ act, id = '', label, value = '', cls = '', valueCls = '', mark = '', extra = '', plain = false }) {
    return `<button class="mi ${cls}${plain ? ' plain' : ''}" data-act="${act}" data-id="${esc(id)}" ${extra}${plain ? ' tabindex="-1"' : ''}>` +
      `<span class="mi-l"><span class="mi-mark">${mark}</span>${esc(label)}</span>` +
      `<span class="mi-r ${valueCls}">${esc(value)}</span></button>`;
  }

  // a system-wide key: click it, then press the new keys
  function keyRow(owner, k) {
    const rec = recording && recording.owner === owner && recording.id === k.id;
    const note = keyNote && keyNote.owner === owner && keyNote.id === k.id ? keyNote.text : null;
    const value = rec ? 'press keys' : note || (k.combo ? Keys.label(k.combo) + (k.ok ? '' : ' (taken)') : 'none');
    const valueCls = rec ? 'rec' : note || !k.ok ? 'bad' : '';
    return row({ act: 'key', id: k.id, extra: `data-owner="${esc(owner)}"`, label: k.label, value, valueCls });
  }

  function pageQuick() {
    const pinned = Dock.items(S);
    const rest = installed().filter((t) => !S.pinned.includes(t.id));
    let side = `<div class="sect"><span>pinned</span><span>${pinned.length} / ${S.maxPinned}</span></div>`;
    side += pinned.length ? pinned.map((t, i) =>
      `<div class="pin"><span class="num">${i + 1}</span><span class="mini">${t.glyph}</span><span>${esc(t.name)}</span>` +
      `<span class="ctl">` +
      `<button class="act" data-act="up" data-id="${t.id}" aria-label="move ${esc(t.name)} up"${i === 0 ? ' disabled' : ''}>↑</button>` +
      `<button class="act" data-act="down" data-id="${t.id}" aria-label="move ${esc(t.name)} down"${i === pinned.length - 1 ? ' disabled' : ''}>↓</button>` +
      `<button class="act" data-act="unpin" data-id="${t.id}" aria-label="unpin ${esc(t.name)}">×</button>` +
      `</span></div>`).join('')
      : '<div class="empty">nothing pinned.</div>';
    if (rest.length) {
      side += '<div class="sect"><span>not pinned</span></div>';
      side += rest.map((t) =>
        `<div class="pin"><span class="num"></span><span class="mini">${t.glyph}</span><span>${esc(t.name)}</span>` +
        `<span class="ctl"><button class="act" data-act="pin" data-id="${t.id}"${pinned.length >= S.maxPinned ? ' disabled' : ''}>pin</button></span></div>`).join('');
    }
    if (!installed().length) side += '<div class="note">install a tool and it shows up here.</div>';
    side += '<div class="sep"></div>';
    side += keyRow('utilr', { ...S.keys.find((k) => k.id === 'quick'), label: 'key' });
    side += row({ act: 'place', label: 'appears', value: PLACES[S.settings.quickAt] + ' ›' });
    side += row({ act: 'try', label: 'try it', value: '›' });
    side += '<div class="note">in it: 1–8 open a tool, ↑ ↓ and enter, esc closes.</div>';

    return `<div class="qpage">` +
      `<div class="preview" aria-hidden="true"><div class="dock">${Dock.html(S)}</div><div class="qlabel">${esc(Dock.label(S, 0))}</div></div>` +
      `<div class="qside">${side}</div></div>`;
  }

  function pageKeys() {
    let html = '<div class="sect"><span>utilr</span></div>';
    for (const k of S.keys) html += keyRow('utilr', k);
    for (const t of installed()) {
      if (!t.keys.length) continue;
      html += `<div class="sect"><span>${esc(t.name)}</span></div>`;
      for (const k of t.keys) html += keyRow(t.id, k);
    }
    html += '<div class="note">click a key, then press the new one. esc cancels; backspace clears one of utilr\'s own. these work from anywhere, so each one belongs to one tool only.</div>';
    return html;
  }

  function pageSettings() {
    const login = S.platform === 'win32' ? 'start with windows' : 'start at login';
    let html = '<div class="sect"><span>utilr</span></div>';
    html += row({ act: 'startup', label: login, value: S.settings.startup ? 'on' : 'off', mark: S.settings.startup ? '&gt;' : '', valueCls: S.settings.startup ? 'on' : '' });
    html += row({ act: 'place', label: 'quick view appears', value: PLACES[S.settings.quickAt] + ' ›' });
    html += row({ act: 'data', label: 'data folder', value: 'open ›' });
    html += '<div class="sect"><span>versions</span></div>';
    html += row({ act: 'none', label: 'utilr', value: S.version, plain: true });
    for (const t of S.tools) html += row({ act: 'none', label: t.name, value: t.running ? t.version : 'not installed', plain: true });
    html += '<div class="sep"></div>';
    html += row({ act: 'quit', label: 'quit utilr', value: 'closes every tool' });
    return html;
  }

  const PAGES = { tools: pageTools, quick: pageQuick, keys: pageKeys, settings: pageSettings };

  function render(animate = false) {
    if (!S) return;
    for (const b of document.querySelectorAll('.tab')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
    const scroll = view.scrollTop;
    view.innerHTML = `<div class="page"${animate ? '' : ' style="animation:none"'}>${PAGES[tab]()}</div>`;
    if (!animate) view.scrollTop = scroll;
    renderStatus();
  }

  function go(next) {
    if (!TABS.includes(next) || next === tab) return;
    stopRecording();
    tab = next;
    expanded = null;
    selected = -1;
    view.scrollTop = 0;
    render(true);
  }

  // -------------------------------------------------------------------------
  // actions
  // -------------------------------------------------------------------------

  async function install(id) {
    const t = tool(id);
    if (!t || t.running || busy.has(id)) return;
    const willPin = Dock.items(S).length < S.maxPinned; // utilr pins new tools while there is room
    busy.add(id);
    render();
    const r = await api.install(id);
    busy.delete(id);
    if (r && r.ok) {
      say(`${t.name} installed${r.imported ? ', your ' + t.name + ' data came along' : willPin ? ', pinned to the quick view' : ''}`);
    } else {
      say(`could not install ${t.name}${r && r.error ? ': ' + r.error : ''}`, true, 4000);
    }
    render();
  }

  function askRemove(id) {
    const t = tool(id);
    if (!t) return;
    confirm(`remove ${t.name}? its data stays for next time`, async () => {
      if (expanded === id) expanded = null;
      await api.remove(id);
      say(`${t.name} removed`);
    });
  }

  function confirm(text, yes) {
    $('confirm-label').textContent = text;
    $('confirm').hidden = false;
    confirmYes = yes;
    window.Ghost.menuOpen(true);
    $('confirm-no').focus();
  }
  function closeConfirm(ok) {
    if ($('confirm').hidden) return;
    $('confirm').hidden = true;
    window.Ghost.menuOpen(false);
    const fn = confirmYes;
    confirmYes = null;
    if (ok && fn) fn();
  }
  $('confirm-yes').addEventListener('click', () => closeConfirm(true));
  $('confirm-no').addEventListener('click', () => closeConfirm(false));

  function startRecording(owner, id) {
    recording = { owner, id };
    keyNote = null;
    api.recordKeys(true);
    render();
  }
  function stopRecording() {
    if (!recording) return;
    recording = null;
    api.recordKeys(false);
    render();
  }
  function noteKey(owner, id, text) {
    keyNote = { owner, id, text };
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => { keyNote = null; render(); }, 2200);
  }

  async function onRecordKey(e) {
    const { owner, id } = recording;
    if (['Control', 'Alt', 'Shift', 'Meta', 'AltGraph'].includes(e.key)) return; // wait for the real key
    if (e.key === 'Escape') { stopRecording(); return; }
    let combo;
    if (e.key === 'Backspace' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      if (owner !== 'utilr') { noteKey(owner, id, 'needs a key'); stopRecording(); return; }
      combo = '';
    } else {
      combo = Keys.normalize(Keys.fromEvent(e));
      if (!combo) { noteKey(owner, id, 'add ctrl, alt or win'); render(); return; }
    }
    recording = null;
    api.recordKeys(false);
    const r = await api.setKey(owner, id, combo);
    if (!r || !r.ok) noteKey(owner, id, (r && r.error) || 'could not set it');
    render();
  }

  function cyclePlace() {
    const i = PLACE_ORDER.indexOf(S.settings.quickAt);
    api.setSettings({ quickAt: PLACE_ORDER[(i + 1) % PLACE_ORDER.length] });
  }

  // one click handler for every page
  view.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || el.disabled) return;
    const { act, id } = el.dataset;
    switch (act) {
      case 'open': api.open(id); break;
      case 'install': install(id); break;
      case 'more': e.stopPropagation(); expanded = expanded === id ? null : id; render(); break;
      case 'action': api.action(id, el.dataset.action); break;
      case 'remove': askRemove(id); break;
      case 'pin': api.pin(id, true); break;
      case 'unpin': api.pin(id, false); break;
      case 'up': api.movePin(id, -1); break;
      case 'down': api.movePin(id, 1); break;
      case 'key':
        if (recording && recording.owner === el.dataset.owner && recording.id === id) stopRecording();
        else startRecording(el.dataset.owner, id);
        break;
      case 'place': cyclePlace(); break;
      case 'try': api.previewQuick(); break;
      case 'startup': api.setSettings({ startup: !S.settings.startup }); break;
      case 'data': api.openData(); break;
      case 'quit': confirm('quit utilr? every tool closes with it', () => api.quit()); break;
      default:
    }
  });

  for (const b of document.querySelectorAll('.tab')) b.addEventListener('click', () => go(b.dataset.tab));
  $('btn-close').addEventListener('click', () => api.close());
  $('btn-min').addEventListener('click', () => api.minimize());

  // -------------------------------------------------------------------------
  // keyboard: ctrl+tab between pages, ↑ ↓ enter on the tools page, esc closes
  // -------------------------------------------------------------------------

  document.addEventListener('keydown', (e) => {
    if (recording) { e.preventDefault(); e.stopPropagation(); onRecordKey(e); return; }
    if (!$('confirm').hidden) {
      if (e.key === 'y' || e.key === 'Enter') { e.preventDefault(); closeConfirm(true); }
      else if (e.key === 'n' || e.key === 'Escape') { e.preventDefault(); closeConfirm(false); }
      return;
    }
    if (e.ctrlKey && e.key === 'Tab') {
      e.preventDefault();
      go(TABS[(TABS.indexOf(tab) + (e.shiftKey ? -1 : 1) + TABS.length) % TABS.length]);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      if (expanded) { expanded = null; render(); } else api.close();
      return;
    }
    if (tab !== 'tools' || e.ctrlKey || e.altKey || e.metaKey) return;
    const n = S.tools.length;
    const rowTool = () => { const r = view.querySelector(`.tool[data-i="${selected}"]`); return r && tool(r.dataset.id); };
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      selected = selected < 0 ? (e.key === 'ArrowDown' ? 0 : n - 1) : (selected + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
      render();
      const r = view.querySelector('.tool.sel');
      if (r) r.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && selected >= 0) {
      e.preventDefault();
      const t = rowTool();
      if (t) (t.running ? api.open(t.id) : install(t.id));
    } else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && selected >= 0) {
      const t = rowTool();
      if (t && t.running) { e.preventDefault(); expanded = e.key === 'ArrowRight' ? t.id : null; render(); }
    }
  });

  window.addEventListener('blur', () => { if (recording) stopRecording(); });

  // -------------------------------------------------------------------------
  // state
  // -------------------------------------------------------------------------

  api.onState((s) => { S = s; render(); });
  api.onTab((t) => go(t));
  api.state().then((s) => { S = s; render(true); });
})();
