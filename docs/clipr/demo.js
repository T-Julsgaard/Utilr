'use strict';
// clipr in the browser: the popup over a pretend editor. Type to find, enter
// pastes into the editor (the app pastes into the window you were in),
// shift+enter really copies. Anything you copy on this page joins the list.
(() => {
  const $ = (id) => document.getElementById(id);
  const desk = $('desk'), pop = $('pop'), q = $('q'), list = $('list'), count = $('count');
  const ed = $('ed'), reopen = $('reopen'), confirmEl = $('confirm'), toastEl = $('toast');

  const ago = (min) => { const d = new Date(Date.now() - min * 60000); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
  let clips = [
    ['git commit -m "one repo for every tool"', 4],
    ['https://github.com/T-Julsgaard/Utilr', 9],
    ['Thanks! I\'ll send it over tomorrow morning.', 17],
    ['#3c78d8', 26],
    ['SELECT name, count(*) FROM tools GROUP BY name;', 48],
    ['padding: 12px 16px;', 63],
    ['48,210', 95],
    ['C:\\Users\\you\\Pictures\\snipr', 121],
    ['meet: thursday 10:15, room 4b', 186],
    ['npm run dist:win', 240],
    ['the app should feel like a thought, not a program.', 311],
    ['alt+shift+v', 380],
    ['oat milk, coffee, lemons', 455],
  ].map(([text, min]) => ({ text, time: ago(min) }));

  let shown = [];
  let sel = 0;
  let open = true;

  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const words = () => q.value.toLowerCase().split(/\s+/).filter(Boolean);

  // every word marked where it appears
  function marked(text, ws) {
    const one = text.replace(/\s+/g, ' ');
    if (!ws.length) return esc(one);
    const lower = one.toLowerCase();
    const hit = new Array(one.length).fill(false);
    for (const w of ws) { let i = -1; while ((i = lower.indexOf(w, i + 1)) >= 0) for (let j = i; j < i + w.length; j++) hit[j] = true; }
    let out = '', on = false;
    for (let i = 0; i < one.length; i++) {
      if (hit[i] !== on) { out += hit[i] ? '<mark>' : '</mark>'; on = hit[i]; }
      out += esc(one[i]);
    }
    return out + (on ? '</mark>' : '');
  }

  function render(fresh) {
    const ws = words();
    shown = clips.filter((c) => ws.every((w) => c.text.toLowerCase().includes(w)));
    sel = Math.max(0, Math.min(sel, shown.length - 1));
    list.innerHTML = shown.length
      ? shown.map((c, i) => `<div class="clip${i === sel ? ' sel' : ''}${fresh && c === clips[0] ? ' fresh' : ''}" role="option" aria-selected="${i === sel}" data-i="${i}"><span class="t">${marked(c.text, ws)}</span><span class="tm">${c.time}</span></div>`).join('')
      : `<div class="none">${clips.length ? 'nothing with that' : 'nothing copied yet'}</div>`;
    count.textContent = shown.length ? `${sel + 1} of ${shown.length}` : `0 of ${clips.length}`;
    const s = list.querySelector('.sel');
    if (s) s.scrollIntoView({ block: 'nearest' });
  }

  let toastTimer = null;
  function toast(text, dim) {
    toastEl.innerHTML = `${text}${dim ? `<span class="dim">${esc(dim)}</span>` : ''}`;
    toastEl.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('on'), 1800);
  }

  function show() {
    open = true;
    pop.classList.remove('gone');
    reopen.hidden = true;
    q.value = '';
    sel = 0;
    render();
    q.focus({ preventScroll: true });
  }
  function hide() {
    open = false;
    pop.classList.add('gone');
    hideConfirm();
    setTimeout(() => { if (!open) reopen.hidden = false; }, 180);
  }

  // what the app does on enter: back to the window you were in, then ctrl+v
  function paste(c) {
    hide();
    const span = document.createElement('span');
    span.className = 'pasted';
    span.textContent = c.text;
    ed.appendChild(span);
    ed.appendChild(document.createTextNode('\n- next: '));
    setTimeout(() => span.classList.add('done'), 60);
    toast('pasted', c.text.length > 32 ? c.text.slice(0, 32) + '…' : c.text);
    bump(c);
  }
  async function copy(c) {
    try { await navigator.clipboard.writeText(c.text); toast('copied', 'paste it anywhere'); }
    catch (_) { toast('could not copy', 'your browser said no'); }
    bump(c);
  }
  // a clip you use moves back to the top
  function bump(c) { clips = [c, ...clips.filter((x) => x !== c)]; }

  function hideConfirm() { confirmEl.hidden = true; confirmEl.innerHTML = ''; }
  function askClear() {
    if (!clips.length) return;
    confirmEl.innerHTML = `<span>clear all ${clips.length}?</span><button class="danger" data-a="y">[y]es</button><button data-a="n">[n]o</button>`;
    confirmEl.hidden = false;
  }
  confirmEl.addEventListener('click', (e) => {
    const a = e.target.closest('button');
    if (!a) return;
    if (a.dataset.a === 'y') { clips = []; render(); }
    hideConfirm();
    q.focus();
  });

  q.addEventListener('input', () => { sel = 0; render(); });
  q.addEventListener('keydown', (e) => {
    if (!confirmEl.hidden) {
      if (e.key === 'y' || e.key === 'Enter') { clips = []; render(); hideConfirm(); }
      else if (e.key === 'n' || e.key === 'Escape') hideConfirm();
      e.preventDefault();
      return;
    }
    const page = 6;
    const move = { ArrowDown: 1, ArrowUp: -1, PageDown: page, PageUp: -page, Tab: e.shiftKey ? -1 : 1 }[e.key];
    if (move !== undefined && shown.length) { sel = Math.max(0, Math.min(shown.length - 1, sel + move)); render(); e.preventDefault(); return; }
    if (e.key === 'Enter' && shown[sel]) { e.preventDefault(); if (e.shiftKey) copy(shown[sel]); else paste(shown[sel]); return; }
    if (e.key === 'Delete' && e.shiftKey && e.ctrlKey) { askClear(); e.preventDefault(); return; }
    if (e.key === 'Delete' && e.shiftKey && shown[sel]) { const c = shown[sel]; clips = clips.filter((x) => x !== c); render(); e.preventDefault(); return; }
    if (e.key === 'Escape') { e.preventDefault(); if (q.value) { q.value = ''; sel = 0; render(); } else hide(); }
  });

  list.addEventListener('mousemove', (e) => {
    const row = e.target.closest('.clip');
    if (!row || Number(row.dataset.i) === sel) return;
    sel = Number(row.dataset.i);
    list.querySelectorAll('.clip').forEach((r) => { r.classList.toggle('sel', r === row); });
    count.textContent = `${sel + 1} of ${shown.length}`;
  });
  list.addEventListener('click', (e) => {
    const row = e.target.closest('.clip');
    if (!row) return;
    const c = shown[Number(row.dataset.i)];
    if (e.shiftKey) copy(c); else paste(c);
  });
  $('close').addEventListener('click', hide);
  reopen.addEventListener('click', show);

  // alt+shift+v opens it again, from anywhere on the page
  document.addEventListener('keydown', (e) => {
    if (e.altKey && e.shiftKey && !e.ctrlKey && e.key.toLowerCase() === 'v') { e.preventDefault(); if (open) hide(); else show(); }
  });

  // copy anything on this page: clipr keeps it, like the app does for the whole computer
  document.addEventListener('copy', () => {
    const text = String(document.getSelection() || '').trim();
    if (!text || text.length > 4000) return;
    clips = [{ text, time: ago(0) }, ...clips.filter((c) => c.text !== text)].slice(0, 200);
    sel = 0;
    render(true);
    toast('kept', text.length > 32 ? text.slice(0, 32) + '…' : text);
  });

  // a click on the popup puts you in the find line (the page keeps its own
  // keys until then, so arrows and space still scroll)
  pop.addEventListener('pointerdown', (e) => {
    if (e.target === q || e.target.closest('button')) return;
    e.preventDefault();
    q.focus({ preventScroll: true });
  });
  q.placeholder = 'click, then type';
  q.addEventListener('focus', () => { q.placeholder = ''; });
  q.addEventListener('blur', () => { if (!q.value) q.placeholder = 'click, then type'; });

  render();
})();
