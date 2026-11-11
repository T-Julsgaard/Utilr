'use strict';
// The home page: the quick view demo (a tile per tool, each opening a small
// scene of what it does), the launcher replica, the tool grid and the keys.
(() => {
  const { TOOLS, svg, keyHtml } = window.Utilr;
  const $ = (id) => document.getElementById(id);
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // a longer line per tool, for the grid
  const LONG = {
    notr: 'Notes that float above every window and save every keystroke. Seven themes, all keyboard.',
    snipr: 'Drag over anything and it lifts off the screen. Mark it up, blur it for good, copy its text.',
    clipr: 'Everything you copied today, newest first. Type a few letters, enter, and it\'s pasted.',
    measr: 'A pixel ruler that finds the edges itself. Sizes, gaps and padding, copied as css or tailwind.',
    paletr: 'A loupe over the frozen screen. Click a pixel: hex, rgb or hsl, on your clipboard.',
    findr: 'Every file on every drive, found as you type. Its own index, kept up to date as files change.',
  };
  const KEYLABEL = {
    notr: 'open notes', snipr: 'snip', clipr: 'clipboard history', measr: 'measure', paletr: 'pick a color', findr: 'find files',
  };
  const VERSIONS = { notr: '1.1.1', snipr: '1.2.2', clipr: '1.0.0', measr: '1.0.0', paletr: '1.0.0', findr: '1.1.0' };

  const ICON = {
    plus: '<svg width="12" height="12" viewBox="0 0 14 14" aria-hidden="true"><path d="M7 1v12M1 7h12" stroke="currentColor" stroke-width="1.4" fill="none"/></svg>',
    gear: '<svg width="12" height="12" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="1.7" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="7" cy="7" r="4.1" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M7 .9v2M7 11.1v2M.9 7h2M11.1 7h2M2.7 2.7l1.4 1.4M9.9 9.9l1.4 1.4M2.7 11.3l1.4-1.4M9.9 4.1l1.4-1.4" stroke="currentColor" stroke-width="1.3" fill="none"/></svg>',
    close: '<svg width="10" height="10" viewBox="0 0 12 12" aria-hidden="true"><path d="M1 1l10 10M11 1L1 11" stroke="currentColor" stroke-width="1.4" fill="none"/></svg>',
    find: '<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3h12v12H3zM5 5v8h8V5zM14 16l2-2 6 6-2 2z" fill="currentColor" fill-rule="evenodd"/></svg>',
  };

  // ---------------------------------------------------------------------------
  // scenes: what each tool looks like when it's open
  // ---------------------------------------------------------------------------
  const noteBar = (tabs) => `<div class="gw-bar chrome"><span class="ico"><span>${ICON.plus}</span>${tabs}</span><span class="ico"><span>${ICON.gear}</span><span>${ICON.close}</span></span></div>`;

  const loupeCells = () => {
    let h = '';
    for (let r = 0; r < 11; r++) {
      for (let c = 0; c < 11; c++) {
        const col = c >= 7 ? '#2bb3a3' : r >= 8 ? '#f2b53c' : '#3c78d8';
        h += `<i${r === 5 && c === 5 ? ' class="mid"' : ''} style="background:${col}"></i>`;
      }
    }
    return h;
  };
  const BLOCKS = ['#3c78d8', '#3c78d8', '#2bb3a3', '#2bb3a3', '#e8e3d9', '#1e1e1e',
    '#3c78d8', '#3c78d8', '#2bb3a3', '#ff7a6b', '#e8e3d9', '#1e1e1e',
    '#f2b53c', '#f2b53c', '#8a6cf0', '#ff7a6b', '#2c2c2c', '#d6d6d6',
    '#f2b53c', '#f2b53c', '#8a6cf0', '#8a6cf0', '#2c2c2c', '#d6d6d6'];

  const SCENES = {
    notr: `
      <div class="gw s-note pin" style="left:8%;top:14%">
        ${noteBar('<span style="font-size:10px">1</span><span style="font-size:10px;color:var(--strong)">2</span>')}
        <div class="body"><b>tuesday</b><hr>call the bank before 4
standup: move to 10:15
<span class="type" data-type="oat milk, coffee, lemons"></span></div>
      </div>
      <div class="gw s-note" style="left:33%;top:36%;width:224px;height:176px">
        ${noteBar('')}
        <div class="body">ideas<hr>quick view on the left edge?
measr → copy as tailwind</div>
      </div>`,
    snipr: `
      <div class="s-sel" style="left:11%;top:22%;width:36%;height:40%"><i class="corner tl"></i><i class="corner br"></i></div>
      <div class="readout panel" style="left:11%;top:calc(62% + 10px)">384 × 216</div>`,
    clipr: `
      <div class="gw popup pin" style="left:9%;top:12%;height:320px">
        <div class="find"><span class="lbl">find</span><span>git<span class="cur"></span></span><span class="chrome" style="margin-left:auto;display:flex;gap:10px;color:var(--dim)">${ICON.gear}${ICON.close}</span></div>
        <div class="rows">
          <div class="row sel"><span class="t"><mark>git</mark> commit -m "one repo for every tool"</span><span class="r">17:42</span></div>
          <div class="row"><span class="t">https://<mark>git</mark>hub.com/T-Julsgaard/Utilr</span><span class="r">17:38</span></div>
          <div class="row"><span class="t"><mark>git</mark> log --oneline --graph</span><span class="r">16:05</span></div>
          <div class="row"><span class="t">.<mark>git</mark>ignore: smoke-out/</span><span class="r">11:20</span></div>
        </div>
        <div class="gw-status" style="position:absolute;left:0;right:0;bottom:0"><span>1 of 4</span><span>enter paste · shift+enter copy</span></div>
      </div>`,
    measr: `
      <div style="position:absolute;left:9%;top:16%;width:340px;height:230px">
        <div class="ui-card" style="left:0;top:0;width:340px;height:230px;background:#1a1a1a"></div>
        <div class="ui-card" style="left:24px;top:26px;width:150px;height:9px;background:#3a3a3a"></div>
        <div class="ui-card" style="left:24px;top:50px;width:250px;height:7px;background:#2a2a2a"></div>
        <div class="ui-card" style="left:24px;top:68px;width:210px;height:7px;background:#2a2a2a"></div>
        <div class="ui-btn" style="left:24px;top:170px;width:120px;height:36px;background:#e6e6e6"></div>
        <div class="ui-btn" style="left:160px;top:170px;width:96px;height:36px;background:#2a2a2a"></div>
        <div class="mbox" style="left:23px;top:169px;width:122px;height:38px"></div>
        <div class="mnum" style="left:38px;top:213px">120 × 36</div>
        <div class="mline" style="left:145px;top:188px;width:15px;height:1px"></div>
        <div class="mnum dim" style="left:140px;top:150px">16</div>
        <div class="mline" style="left:84px;top:207px;width:1px;height:23px"></div>
        <div class="mline" style="left:0;top:188px;width:23px;height:1px"></div>
        <div class="mnum dim" style="left:-6px;top:150px">24</div>
      </div>
      <div class="toast panel on" style="left:40%;top:6%">copied <span class="dim">120 × 36</span></div>`,
    paletr: `
      <div class="colors" style="left:8%;top:16%;width:330px;height:220px">${BLOCKS.map((c) => `<i style="background:${c}"></i>`).join('')}</div>
      <div class="loupe" style="left:calc(8% + 64px);top:calc(16% + 30px)">${loupeCells()}</div>
      <div class="chip panel" style="left:calc(8% + 64px);top:calc(16% + 172px)"><i style="background:#3c78d8"></i>#3c78d8</div>
      <div class="palette panel" style="left:calc(8% + 360px);top:calc(16% + 160px)">${['#3c78d8', '#2bb3a3', '#f2b53c', '#ff7a6b', '#8a6cf0', '#e8e3d9'].map((c) => `<i style="background:${c}"></i>`).join('')}</div>`,
    findr: `
      <div class="gw popup pin" style="left:6%;top:11%;width:470px">
        <div class="find" style="height:48px;gap:12px"><span style="color:var(--dim)">${ICON.find}</span><span>invoice<span class="cur"></span></span><span class="lbl" style="margin-left:auto">3</span></div>
        <div class="rows" style="border-top:1px solid var(--divider);padding-top:6px">
          <div class="row sel"><span class="t"><mark>Invoice</mark>-2026-03.pdf <span class="dim" style="margin-left:8px">C:\\Users\\you\\Documents\\bills</span></span><span class="r">84 kb · 14 mar</span></div>
          <div class="row"><span class="t">new-<mark>invoice</mark>.md <span class="dim" style="margin-left:8px">D:\\work\\notes</span></span><span class="r"></span></div>
          <div class="row"><span class="t"><mark>invoice</mark>s <span class="dim" style="margin-left:8px">C:\\Users\\you\\Documents</span></span><span class="r"></span></div>
        </div>
      </div>
      <div class="toast panel on" style="left:6%;top:calc(11% + 182px);font-size:11px">find in <b>918,402</b> files <span class="dim">· 6 ms</span></div>`,
  };

  // ---------------------------------------------------------------------------
  // the quick view demo
  // ---------------------------------------------------------------------------
  const desk = $('qdesk');
  const stage = $('stage');
  const dock = $('dock');
  const qlabel = $('qlabel');
  const caption = $('caption');
  let sel = 0;
  let typing = null;

  for (const t of TOOLS) {
    const s = document.createElement('div');
    s.className = 'scene';
    s.dataset.id = t.id;
    s.innerHTML = SCENES[t.id];
    stage.appendChild(s);
  }

  TOOLS.forEach((t, i) => {
    const b = document.createElement('button');
    b.className = 'qt';
    b.style.setProperty('--i', i);
    b.setAttribute('role', 'option');
    b.setAttribute('aria-label', t.id);
    b.innerHTML = `<span class="n">${i + 1}</span>${svg(t)}`;
    b.addEventListener('click', () => {
      stopAuto();
      if (sel === i) location.href = `${t.id}/`;
      else select(i);
    });
    b.addEventListener('mouseenter', () => { qlabel.textContent = t.id; });
    b.addEventListener('mouseleave', () => { qlabel.textContent = TOOLS[sel].id; });
    dock.appendChild(b);
  });

  function typeInto(el) {
    clearInterval(typing);
    const text = el.dataset.type;
    el.textContent = '';
    if (reduceMotion) { el.textContent = text; return; }
    let i = 0;
    setTimeout(() => {
      typing = setInterval(() => {
        el.textContent = text.slice(0, ++i);
        if (i >= text.length) clearInterval(typing);
      }, 55);
    }, 380);
  }

  function select(i) {
    sel = (i + TOOLS.length) % TOOLS.length;
    const t = TOOLS[sel];
    [...dock.querySelectorAll('.qt:not(.add)')].forEach((b, j) => {
      b.classList.toggle('sel', j === sel);
      b.setAttribute('aria-selected', String(j === sel));
    });
    qlabel.textContent = t.id;
    stage.querySelectorAll('.scene').forEach((s) => {
      const on = s.dataset.id === t.id;
      if (on && !s.classList.contains('on')) {
        // restart the scene's little animations
        s.querySelectorAll('.s-sel, .readout, .loupe, .chip, .toast').forEach((el) => {
          el.style.animation = 'none';
          void el.offsetWidth;
          el.style.animation = '';
        });
        const ty = s.querySelector('.type');
        if (ty) typeInto(ty);
      }
      s.classList.toggle('on', on);
    });
    caption.innerHTML = `<span class="what"><b>${t.id}</b><span class="dim hide-s">${t.desc}</span>${keyHtml(t.key)}</span><a href="${t.id}/">${t.id} →</a>`;
  }

  // it plays by itself until you touch it
  let auto = null;
  const startAuto = () => {
    if (reduceMotion || auto) return;
    auto = setInterval(() => select(sel + 1), 3800);
  };
  const stopAuto = () => { clearInterval(auto); auto = null; };
  desk.addEventListener('pointerdown', stopAuto);
  dock.addEventListener('mouseenter', stopAuto);

  // only play while it's on screen
  if ('IntersectionObserver' in window) {
    let touched = false;
    desk.addEventListener('pointerdown', () => { touched = true; });
    desk.addEventListener('keydown', () => { touched = true; });
    new IntersectionObserver(([e]) => {
      if (e.isIntersecting && !touched) startAuto(); else stopAuto();
    }).observe(desk);
  }

  // keys, while the pointer is on the desk or it has focus
  let over = false;
  desk.addEventListener('mouseenter', () => { over = true; });
  desk.addEventListener('mouseleave', () => { over = false; });
  document.addEventListener('keydown', (e) => {
    if (!over && document.activeElement !== desk && !desk.contains(document.activeElement)) return;
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (/^[1-6]$/.test(e.key)) { stopAuto(); select(Number(e.key) - 1); e.preventDefault(); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { stopAuto(); select(sel + (e.key === 'ArrowDown' ? 1 : -1)); e.preventDefault(); }
    else if (e.key === 'Enter' && document.activeElement === desk) location.href = `${TOOLS[sel].id}/`;
  });

  select(0);

  // ---------------------------------------------------------------------------
  // the tool grid
  // ---------------------------------------------------------------------------
  $('tool-grid').innerHTML = TOOLS.map((t, i) => `
    <a class="tcard" href="${t.id}/">
      <span class="n">0${i + 1}</span>
      <span class="tile">${svg(t)}</span>
      <h3>${t.id}</h3>
      <p>${LONG[t.id]}</p>
      <span class="tfoot"><span>${t.key}${t.win ? ' <span class="os">· windows</span>' : ''}</span><span class="go">→</span></span>
    </a>`).join('');

  $('included').innerHTML = '<span>inside:</span>' + TOOLS.map((t) => `<span>${svg(t, 12)}${t.id}</span>`).join('');

  // ---------------------------------------------------------------------------
  // keys
  // ---------------------------------------------------------------------------
  const KEYS = [
    ['utilr', 'the quick view', 'alt+shift+space'],
    ['utilr', 'open utilr', 'alt+shift+u'],
    ['notr', 'bring your notes to the front', 'ctrl+n'],
    ['snipr', 'snip an area of the screen', 'alt+shift+s'],
    ['snipr', 'snip text: drag, and the text is copied', 'alt+shift+t', 'windows'],
    ['clipr', 'clipboard history', 'alt+shift+v'],
    ['measr', 'measure what\'s on screen', 'alt+shift+m'],
    ['paletr', 'pick a color', 'alt+shift+p'],
    ['findr', 'find files', 'alt+shift+d', 'windows'],
  ];
  $('keylist').innerHTML = KEYS.map(([who, what, combo, os]) => `
    <div><dt>${keyHtml(combo)}</dt><dd><span class="who">${who}</span>${what}${os ? ` <span class="dim">(${os})</span>` : ''}</dd></div>`).join('');

  // ---------------------------------------------------------------------------
  // the launcher replica
  // ---------------------------------------------------------------------------
  const view = $('lview');
  const status = $('lstatus');
  const tabs = [...document.querySelectorAll('#launcherwin .tab')];
  const points = [...document.querySelectorAll('#points li')];
  const keyState = { quick: 'alt+shift+space', launcher: 'alt+shift+u' };
  TOOLS.forEach((t) => { keyState[t.id] = t.key; });
  keyState.sniprText = 'alt+shift+t';
  const KEYROWS = [
    ['utilr', [['quick', 'quick view'], ['launcher', 'open utilr']]],
    ...TOOLS.map((t) => [t.id, t.id === 'snipr' ? [['snipr', 'snip'], ['sniprText', 'snip text']] : [[t.id, KEYLABEL[t.id]]]]),
  ];
  const ownerOf = (combo, except) => {
    for (const [group, rows] of KEYROWS) for (const [id] of rows) if (id !== except && keyState[id] === combo) return group;
    return null;
  };
  let recording = null;
  let clash = null;

  const PAGES = {
    quick: () => `<div class="qpage"><div class="quick"><div class="dock">${TOOLS.map((t, i) => `<span class="qt${i === 0 ? ' sel' : ''}"><span class="n">${i + 1}</span>${svg(t)}</span>`).join('')}</div><div class="qlabel">notr</div></div>
      <div><div class="sect"><span>pinned</span><span>${TOOLS.length} / 8</span></div>
      ${TOOLS.map((t, i) => `<div class="pinrow"><span class="num">${i + 1}</span><span class="mini">${svg(t)}</span><span>${t.id}</span><span class="ctl">↑↓×</span></div>`).join('')}
      <div class="sep"></div>
      <div class="mi"><span>key</span><span class="r">${keyState.quick}</span></div>
      <div class="mi"><span>appears</span><span class="r">center ›</span></div>
      <div class="mi"><span>try it</span><span class="r">›</span></div></div></div>`,
    keys: () => KEYROWS.map(([group, rows]) => `<div class="sect"><span>${group}</span></div>` + rows.map(([id, label]) => {
      const rec = recording === id;
      const bad = clash && clash.id === id;
      const r = rec ? '<span class="r" style="color:var(--strong)">press keys…</span>'
        : bad ? `<span class="r" style="color:var(--danger)">${clash.combo} (${clash.owner} has it)</span>`
        : `<span class="r">${keyState[id]}</span>`;
      return `<div class="mi" data-key="${id}" style="cursor:pointer"><span>${label}</span>${r}</div>`;
    }).join('')).join('') + '<p class="dim" style="font-size:10px;line-height:1.7;margin-top:10px">click a key, then press the new one. esc cancels. try one another tool has.</p>',
    settings: () => `<div class="sect"><span>utilr</span></div>
      <div class="mi"><span>&gt; start with windows</span><span class="r on">on</span></div>
      <div class="mi"><span>&nbsp; quick view appears</span><span class="r">center ›</span></div>
      <div class="mi"><span>&nbsp; data folder</span><span class="r">open ›</span></div>
      <div class="sect"><span>versions</span></div>
      <div class="mi"><span>&nbsp; utilr</span><span class="r" data-version>0.1.0</span></div>
      ${TOOLS.map((t) => `<div class="mi"><span>&nbsp; ${t.id}</span><span class="r">${VERSIONS[t.id]}</span></div>`).join('')}`,
  };

  let tab = 'quick';
  function show(name) {
    tab = name;
    if (name !== 'keys') { recording = null; clash = null; }
    tabs.forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
    points.forEach((li) => li.classList.toggle('on', li.dataset.tab === name));
    view.innerHTML = `<div class="page">${PAGES[name]()}</div>`;
    status.textContent = name === 'keys' ? 'one owner per key' : `${TOOLS.length} tools`;
  }
  const rerender = () => { view.innerHTML = `<div class="page" style="animation:none">${PAGES[tab]()}</div>`; };
  tabs.forEach((b) => b.addEventListener('click', () => show(b.dataset.tab)));
  points.forEach((li) => li.querySelector('button').addEventListener('click', () => show(li.dataset.tab)));
  $('launcherwin').addEventListener('keydown', (e) => {
    if (!e.ctrlKey || e.key !== 'Tab') return;
    e.preventDefault();
    const names = Object.keys(PAGES);
    show(names[(names.indexOf(tab) + (e.shiftKey ? -1 : 1) + names.length) % names.length]);
  });

  // the keys page: click a key, press a combo; a combo another tool has is refused
  view.addEventListener('click', (e) => {
    const row = e.target.closest('[data-key]');
    if (!row) return;
    recording = recording === row.dataset.key ? null : row.dataset.key;
    clash = null;
    rerender();
  });
  const MOD = ['Control', 'Alt', 'Shift', 'Meta'];
  document.addEventListener('keydown', (e) => {
    if (!recording) return;
    if (e.key === 'Escape') { recording = null; rerender(); return; }
    if (MOD.includes(e.key)) return;
    e.preventDefault();
    const k = e.key === ' ' ? 'space' : e.key.length === 1 ? e.key.toLowerCase() : e.key.replace(/^Arrow/, '').toLowerCase();
    const mods = [e.ctrlKey && 'ctrl', e.altKey && 'alt', e.shiftKey && 'shift', e.metaKey && 'win'].filter(Boolean);
    if (!mods.some((m) => m !== 'shift')) return; // needs ctrl, alt or win
    const combo = [...mods, k].join('+');
    const owner = ownerOf(combo, recording);
    if (owner) clash = { id: recording, combo, owner };
    else { keyState[recording] = combo; clash = null; }
    recording = null;
    rerender();
  });

  show('quick');
})();
