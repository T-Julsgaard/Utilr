'use strict';
// findr in the browser: a made-up drive of a few thousand names (nothing real
// is read), searched the way the app searches: words in any order, "phrases",
// wildcards for the whole name, a word with \ looks in the path. Then ranked:
// exact names and name starts first, what you opened and your own folder up,
// deep paths a little down, machine folders well down.
(() => {
  const $ = (id) => document.getElementById(id);
  const pop = $('pop'), q = $('q'), res = $('res'), cnt = $('cnt'), stat = $('stat'), toastEl = $('toast');

  // ---------------------------------------------------------------------------
  // the made-up drive (seeded, so it's the same every time)
  // ---------------------------------------------------------------------------
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const pad = (n, w) => String(n).padStart(w, '0');
  const files = [];
  const add = (dir, name, kb) => files.push({ dir, name, size: kb === 0 ? null : Math.round((kb || 4 + rnd() * 900) * 1024), t: Date.UTC(2023, 0, 1) + Math.floor(rnd() * 1000 * 864e5) });
  const U = 'C:\\Users\\you';

  for (let y = 2024; y <= 2026; y++) for (let m = 1; m <= 12; m++) {
    if (y === 2026 && m > 11) break;
    add(`${U}\\Documents\\bills`, `Invoice-${y}-${pad(m, 2)}.pdf`, 60 + rnd() * 90);
    add(`D:\\work\\clients\\${pick(['acme', 'globex', 'initech'])}\\invoices`, `invoice-${y}${pad(m, 2)}-${pad(Math.floor(rnd() * 900 + 100), 3)}.pdf`, 40 + rnd() * 60);
  }
  ['invoices', 'Invoice template.docx', 'new-invoice.md', 'tax return 2025.pdf', 'lease agreement.pdf', 'insurance 2026.pdf', 'payslip-2026-10.pdf', 'budget 2026.xlsx']
    .forEach((n) => add(`${U}\\Documents`, n, n.includes('.') ? undefined : 0));
  ['standup.md', 'todo.md', 'ideas.md', 'meeting notes 2026-11-06.md', 'reading list.md', 'dm mono specimen.pdf']
    .forEach((n) => add(`${U}\\Documents\\notes`, n, 2 + rnd() * 20));
  for (let i = 0; i < 900; i++) add(`D:\\photos\\${2019 + Math.floor(i / 150)}\\${pick(['summer', 'winter', 'iceland', 'lisbon', 'birthday', 'misc'])}`, `IMG_${pad(1000 + i * 7, 4)}.jpg`, 2200 + rnd() * 4000);
  for (let i = 0; i < 160; i++) add(`${U}\\Pictures\\snipr`, `snip-2026-${pad(1 + Math.floor(i / 16), 2)}-${pad(1 + (i % 28), 2)}-${pad(80000 + i * 377, 6)}.png`, 40 + rnd() * 300);
  for (let i = 0; i < 60; i++) add(`${U}\\Pictures\\Screenshots`, `Screenshot ${2025 + (i % 2)}-${pad(1 + (i % 12), 2)}-${pad(1 + (i % 28), 2)} ${pad(100000 + i * 911, 6)}.png`, 200 + rnd() * 900);
  ['DM Mono Light.ttf', 'JetBrains Mono.zip', 'utilr-setup-0.1.0.exe', 'node-v22.11.0-x64.msi', 'GitHubDesktopSetup-x64.exe', 'brand guidelines.pdf', 'wallpaper 5k.png', 'contract signed.pdf']
    .forEach((n) => add(`${U}\\Downloads`, n));
  const tools = ['notr', 'snipr', 'clipr', 'measr', 'paletr', 'findr'];
  for (const t of tools) {
    ['README.md', 'main.js', 'preload.js', 'tool.json', 'glyph.svg', 'keys.js', `${t}.css`].forEach((n) => add(`${U}\\GitHub\\Utilr\\tools\\${t}`, n, 1 + rnd() * 30));
    ['ghost.css', 'ghost.js', 'fonts.css'].forEach((n) => add(`${U}\\GitHub\\Utilr\\tools\\${t}\\theme`, n, 2 + rnd() * 8));
    add(`${U}\\GitHub\\Utilr\\docs\\${t}`, 'index.html', 12);
  }
  ['package.json', 'README.md', 'LICENSE', '.gitignore'].forEach((n) => add(`${U}\\GitHub\\Utilr`, n, 2));
  ['main.js', 'host.js', 'store.js', 'shortcuts.js', 'launcher.html', 'launcher.js', 'quick.js', 'utilr.css'].forEach((n) => add(`${U}\\GitHub\\Utilr\\src`, n, 3 + rnd() * 20));
  const pkgs = ['electron', 'electron-builder', 'lodash', 'debug', 'semver', 'minimatch', 'glob', 'fs-extra', 'yargs', 'chalk', 'js-yaml', 'ms', 'tar', 'archiver'];
  for (const p of pkgs) for (let i = 0; i < 120; i++) add(`${U}\\GitHub\\Utilr\\node_modules\\${p}${i > 40 ? '\\lib' : ''}${i > 80 ? '\\utils' : ''}`, pick(['index.js', 'README.md', 'package.json', 'LICENSE', 'index.d.ts', 'cli.js', 'util.js', 'parse.js', 'notes.js', 'invoice.js', 'todo.js']).replace('.', i % 3 ? `-${i}.` : '.'), 1 + rnd() * 40);
  for (let i = 0; i < 700; i++) add(`${U}\\AppData\\Local\\Temp\\${pick(['chrome', 'npm-cache', 'electron', 'vscode'])}`, `tmp-${(rnd() * 1e9).toString(36).slice(0, 7)}${pick(['.tmp', '.log', '.json', '.dat'])}`, 1 + rnd() * 200);
  for (let i = 0; i < 400; i++) add(`C:\\Windows\\System32${pick(['', '\\drivers', '\\en-US'])}`, `${pick(['ntdll', 'kernel', 'user', 'shell', 'win', 'ms', 'net', 'crypt'])}${pick(['32', 'base', 'core', 'svc', 'api', 'ui'])}${i}.${pick(['dll', 'sys', 'exe', 'mui'])}`, 20 + rnd() * 900);
  for (let i = 0; i < 300; i++) add(`D:\\music\\${pick(['Bonobo', 'Floating Points', 'Jon Hopkins', 'Nils Frahm', 'Tycho', 'Four Tet'])}\\${pick(['Migration', 'Promises', 'Singularity', 'Spaces', 'Dive', 'Sixteen Oceans'])}`, `${pad(1 + (i % 12), 2)} ${pick(['Kerala', 'Opening', 'Emerald Rush', 'Says', 'Awake', 'Teardrop', 'Baby', 'Glue', 'Morning', 'Hours'])}.flac`, 20000 + rnd() * 30000);
  ['minecraft', 'factorio', 'steam'].forEach((g) => { for (let i = 0; i < 80; i++) add(`D:\\games\\${g}\\${pick(['saves', 'mods', 'logs', 'config'])}`, `${g}-${pick(['save', 'mod', 'latest', 'options'])}-${i}.${pick(['dat', 'zip', 'log', 'txt'])}`); });

  const TOTAL = files.length;
  const MACHINE = /\\(AppData|node_modules|\.git|Windows|Program Files)(\\|$)/i;
  let recent = [`${U}\\Documents\\notes\\standup.md`, `${U}\\Documents\\bills\\Invoice-2026-10.pdf`, `${U}\\GitHub\\Utilr\\README.md`, `${U}\\Downloads\\utilr-setup-0.1.0.exe`];
  const full = (f) => `${f.dir}\\${f.name}`;

  // ---------------------------------------------------------------------------
  // searching
  // ---------------------------------------------------------------------------
  function parse(text) {
    const terms = [];
    const re = /"([^"]+)"|(\S+)/g;
    let m;
    while ((m = re.exec(text))) {
      const t = (m[1] || m[2]).toLowerCase();
      if (m[1]) terms.push({ kind: 'name', s: t });
      else if (/[*?]/.test(t)) terms.push({ kind: 'wild', re: new RegExp('^' + t.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i') });
      else if (/[\\/]/.test(t)) terms.push({ kind: 'path', s: t.replace(/\//g, '\\').replace(/\\+$/, '') });
      else terms.push({ kind: 'name', s: t });
    }
    return terms;
  }
  function search(text) {
    const terms = parse(text);
    if (!terms.length) return null;
    const first = terms.find((t) => t.kind === 'name');
    const out = [];
    for (const f of files) {
      const n = f.name.toLowerCase();
      let ok = true;
      for (const t of terms) {
        if (t.kind === 'name' ? !n.includes(t.s) : t.kind === 'wild' ? !t.re.test(f.name) : !full(f).toLowerCase().includes(t.s)) { ok = false; break; }
      }
      if (!ok) continue;
      let score = 0;
      if (first) {
        const base = n.replace(/\.[^.]+$/, '');
        if (n === first.s || base === first.s) score += 100;
        else if (n.startsWith(first.s)) score += 40;
        else if (new RegExp('(^|[^a-z0-9])' + first.s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(n)) score += 15;
      }
      if (recent.includes(full(f))) score += 60;
      if (f.dir.startsWith(U) && !MACHINE.test(f.dir)) score += 12;
      if (MACHINE.test(f.dir)) score -= 50;
      score -= f.dir.split('\\').length * 1.5;
      out.push({ f, score });
    }
    out.sort((a, b) => b.score - a.score || a.f.name.length - b.f.name.length || a.f.name.localeCompare(b.f.name));
    return out;
  }

  // ---------------------------------------------------------------------------
  // drawing the results
  // ---------------------------------------------------------------------------
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function marked(name, terms) {
    const lower = name.toLowerCase();
    const hit = new Array(name.length).fill(false);
    for (const t of terms) {
      if (t.kind !== 'name') continue;
      let i = -1;
      while ((i = lower.indexOf(t.s, i + 1)) >= 0) for (let j = i; j < i + t.s.length; j++) hit[j] = true;
    }
    let out = '', on = false;
    for (let i = 0; i < name.length; i++) {
      if (hit[i] !== on) { out += hit[i] ? '<mark>' : '</mark>'; on = hit[i]; }
      out += esc(name[i]);
    }
    return out + (on ? '</mark>' : '');
  }
  const size = (b) => (b === null ? 'folder' : b < 1024 ? `${b} b` : b < 1048576 ? `${Math.round(b / 1024)} kb` : `${(b / 1048576).toFixed(1)} mb`);
  const date = (t) => new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).toLowerCase();
  const short = (dir) => dir.replace(U, '~');

  let list = [];
  let sel = 0;
  const LIMIT = 60;

  function render() {
    const text = q.value.trim();
    const t0 = performance.now();
    const found = search(text);
    const ms = performance.now() - t0;
    const terms = text ? parse(text) : [];
    list = found ? found.slice(0, LIMIT).map((x) => x.f) : recent.map((p) => files.find((f) => full(f) === p)).filter(Boolean);
    sel = Math.max(0, Math.min(sel, list.length - 1));
    const look = pop.dataset.look;
    res.innerHTML = list.length ? list.map((f, i) => {
      const meta = `${size(f.size)} · ${date(f.t)}`;
      const cls = `fr${i === sel ? ' sel' : ''}`;
      if (look === 'line') return `<div class="${cls}" data-i="${i}" role="option"><span class="nm">${marked(f.name, terms)}</span><span class="dir">${esc(short(f.dir))}</span><span class="meta">${meta}</span></div>`;
      if (look === 'bar') return `<div class="${cls}" data-i="${i}" role="option"><span class="nm">${marked(f.name, terms)}</span><span class="dir">${esc(short(f.dir))}</span>${i === sel ? `<span class="meta">${meta}</span>` : ''}</div>`;
      return `<div class="${cls}" data-i="${i}" role="option"><div class="l1"><span class="nm">${marked(f.name, terms)}</span>${i === sel ? `<span class="meta">${meta}</span>` : ''}</div><div class="dir">${esc(short(f.dir))}</div></div>`;
    }).join('') : `<div class="none">${text ? 'nothing with that name' : ''}</div>`;
    if (!text) res.insertAdjacentHTML('afterbegin', '<div class="head">opened last</div>');
    cnt.textContent = found ? (found.length > LIMIT ? `${LIMIT} of ${found.length.toLocaleString('en')}` : String(found.length)) : '';
    stat.textContent = found ? `${found.length.toLocaleString('en')} found · ${ms < 1 ? '<1' : Math.round(ms)} ms` : `find in ${TOTAL.toLocaleString('en')} files`;
    q.placeholder = look === 'bar' && !text ? `find in ${TOTAL.toLocaleString('en')} files` : '';
    pop.classList.toggle('typed', !!text);
    const s = res.querySelector('.sel');
    if (s) s.scrollIntoView({ block: 'nearest' });
  }

  let toastTimer = null;
  function toast(text, dim) {
    toastEl.innerHTML = `${text}${dim ? `<span class="dim">${esc(dim)}</span>` : ''}`;
    toastEl.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('on'), 1800);
  }
  function open(f, folder) {
    if (!f) return;
    toast(folder ? 'opens its folder' : 'opens', folder ? short(f.dir) : f.name);
    recent = [full(f), ...recent.filter((p) => p !== full(f))].slice(0, 8);
  }

  q.addEventListener('input', () => { sel = 0; render(); });
  q.addEventListener('keydown', (e) => {
    const move = { ArrowDown: 1, ArrowUp: -1, PageDown: 8, PageUp: -8, Tab: e.shiftKey ? -1 : 1 }[e.key];
    if (move !== undefined) { sel = Math.max(0, Math.min(list.length - 1, sel + move)); render(); e.preventDefault(); return; }
    if (e.key === 'Enter') { open(list[sel], e.ctrlKey || e.shiftKey); e.preventDefault(); return; }
    if (e.key === 'Escape') { q.value = ''; sel = 0; render(); e.preventDefault(); return; }
    if ((e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'c') && list[sel]) {
      e.preventDefault();
      navigator.clipboard.writeText(full(list[sel])).then(() => toast('copied', full(list[sel])), () => {});
    }
  });
  res.addEventListener('click', (e) => {
    const row = e.target.closest('.fr');
    if (!row) return;
    sel = Number(row.dataset.i);
    open(list[sel], e.ctrlKey);
    render();
  });
  pop.addEventListener('pointerdown', (e) => {
    if (e.target === q) return;
    e.preventDefault();
    q.focus({ preventScroll: true });
  });
  q.addEventListener('focus', () => pop.classList.add('focus'));
  q.addEventListener('blur', () => pop.classList.remove('focus'));

  document.querySelectorAll('[data-look]').forEach((b) => {
    if (b === pop) return;
    b.addEventListener('click', () => {
      pop.dataset.look = b.dataset.look;
      document.querySelectorAll('button[data-look]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      render();
    });
  });

  // the first time, the drive is "read": a slow sweep along the bottom edge
  pop.classList.add('reading');
  stat.textContent = 'reading the drive…';
  setTimeout(() => { pop.classList.remove('reading'); render(); }, 1300);
  render();
  stat.textContent = 'reading the drive…';
})();
