'use strict';
// Smoke test: drives the real utilr windows and writes screenshots + a log to
// smoke-out/. Run with `npm test` (= electron scripts/smoke.js), which starts
// utilr with a throwaway data folder and hands this file its internals.

const path = require('path');
const fs = require('fs');
const os = require('os');

const root = path.join(__dirname, '..');
const out = path.join(root, 'smoke-out');

const { app, BrowserWindow, screen, clipboard } = require('electron');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const lines = [];
let failed = 0;
const log = (s) => { lines.push(s); console.log(s); };
const check = (ok, what) => { if (!ok) failed++; log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); };

async function shot(win, name) {
  if (!win || win.isDestroyed()) { log(`(no window for ${name})`); return; }
  await wait(120);
  await win.webContents.executeJavaScript('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(out, name + '.png'), img.toPNG());
}

// run a line of script in a window and return its value
const js = (win, code) => win.webContents.executeJavaScript(code);

// paletr's windows: the pick overlays (one per screen), the toast, the palette
const paletrWins = () => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w.getTitle() === 'paletr');
const paletrPage = (page) => paletrWins().find((w) => w.isVisible() && w.webContents.getURL().endsWith(`/${page}.html`));
const overlayOn = (d) => paletrWins().find((w) => w.isVisible() && JSON.stringify(w.getBounds()) === JSON.stringify(d.bounds));
const clipText = async () => String(await clipboard.readText());

// click in a window at (x, y), its own coordinates
async function click(win, x, y, modifiers = []) {
  win.webContents.sendInputEvent({ type: 'mouseMove', x, y, modifiers });
  await wait(60);
  win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1, modifiers });
  await wait(30);
  win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1, modifiers });
}
const key = (win, keyCode, modifiers = []) => win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });

// Pick a color we know off the real screen: a window painted #3c78d8 goes up,
// paletr's overlay freezes the screens, the test clicks in the middle of it.
async function testPaletr(u) {
  let keepClip = null;
  try { keepClip = await clipText(); } catch (_) {}
  try { await pickPaletr(u); } finally {
    if (keepClip) { try { await clipboard.writeText(keepClip); } catch (_) {} }
  }
}
async function pickPaletr(u) {
  const BLUE = '#3c78d8';
  const wa = screen.getPrimaryDisplay().workArea;
  const target = new BrowserWindow({
    x: wa.x + 60, y: wa.y + 60, width: 160, height: 120,
    frame: false, show: false, skipTaskbar: true, focusable: false, alwaysOnTop: true, backgroundColor: BLUE,
  });
  await target.loadURL('data:text/html,' + encodeURIComponent(`<title>target</title><body style="margin:0;background:${BLUE}"></body>`));
  target.showInactive();
  await wait(400);
  const tb = target.getBounds();
  const d = screen.getDisplayMatching(tb);
  const at = { x: tb.x + 80 - d.bounds.x, y: tb.y + 60 - d.bounds.y };

  // open it from the quick view, by its number
  const n = String(u.Store.get().pinned.indexOf('paletr') + 1);
  u.showQuick();
  await wait(400);
  key(u.quickWin(), n);
  await wait(1300);
  let ov = overlayOn(d);
  check(!!ov, `"${n}" in the quick view opens paletr's overlay (${paletrWins().filter((w) => w.isVisible()).length} window(s))`);
  if (!ov) { target.destroy(); return; }
  ov.webContents.sendInputEvent({ type: 'mouseMove', x: at.x, y: at.y });
  await wait(250);
  const shotImg = await ov.webContents.capturePage({ x: Math.max(0, at.x - 160), y: Math.max(0, at.y - 120), width: 360, height: 300 });
  fs.writeFileSync(path.join(out, '30-paletr-loupe.png'), shotImg.toPNG());
  check((await js(ov, `document.getElementById('value').textContent`)) === BLUE, 'the readout under the loupe says ' + BLUE);

  // tab: rgb; shift+click copies and keeps the overlay up
  key(ov, 'Tab');
  await wait(150);
  await click(ov, at.x, at.y, ['shift']);
  await wait(400);
  check((await clipText()) === 'rgb(60, 120, 216)', `shift+click copied ${await clipText()}`);
  check(ov.isVisible(), 'and the overlay stays up');
  key(ov, 'Escape');
  await wait(400);
  check(!paletrWins().some((w) => w.isVisible() && JSON.stringify(w.getBounds()) === JSON.stringify(d.bounds)), 'esc closes the overlay');
  const toastWin = paletrPage('toast');
  check(!!toastWin, 'a toast says what was copied');
  if (toastWin) await shot(toastWin, '31-paletr-toast');

  // again, from paletr's action, back to hex, and a plain click
  u.Host.open('paletr');
  await wait(1300);
  ov = overlayOn(d);
  check(!!ov, 'second pick opens at once (overlays kept warm)');
  if (ov) {
    key(ov, 'Tab'); await wait(60); key(ov, 'Tab'); await wait(60); // rgb → hsl → hex
    await click(ov, at.x, at.y);
    await wait(400);
    check((await clipText()) === BLUE, `click copied ${await clipText()}`);
    check(!ov.isVisible(), 'and the overlay is gone');
  }
  target.destroy();
  const logTxt = fs.readFileSync(path.join(app.getPath('userData'), 'utilr.log'), 'utf8');
  for (const m of logTxt.match(/paletr: pick \(.*$/gm) || []) log('     ' + m);

  // the palette: one swatch (the same color twice is one swatch)
  u.Host.run('paletr', 'palette');
  await wait(800);
  const pw = paletrPage('palette');
  check(!!pw, 'the palette opens');
  if (pw) {
    check((await js(pw, `document.querySelectorAll('.tile').length`)) === 1, 'it holds the picked color, once');
    await js(pw, `document.body.classList.add('hover')`);
    await click(pw, 14 + 17, 30 + 10 + 17);
    await wait(250);
    check((await clipText()) === BLUE, 'clicking a swatch copies it');
    await shot(pw, '32-paletr-palette');
    await js(pw, `document.getElementById('btn-menu').click()`);
    await wait(200);
    await shot(pw, '33-paletr-menu');
    const rows = await js(pw, `[...document.querySelectorAll('.mi')].map((m) => m.textContent.trim().replace(/\\s+/g, ' '))`);
    check(!rows.some((t) => /start with|quit/.test(t)), 'palette menu: no start-at-login / quit rows in utilr');
  }

  // keys: paletr can't take the one snipr holds, takes a free one
  const sniprKey = u.publicState().tools.find((x) => x.id === 'snipr').keys.find((k) => k.ok);
  let r;
  if (sniprKey) {
    r = u.setKey('paletr', 'pick', sniprKey.combo);
    check(!r.ok && /snipr/.test(r.error), `paletr can't take snipr's key (${r.error})`);
  } else {
    log("     (skipped: snipr holds no key here, another program has them)");
  }
  r = u.setKey('paletr', 'pick', 'ctrl+alt+shift+6');
  check(r.ok && u.Shortcuts.ownerOf('Control+Alt+Shift+6') === 'paletr', 'paletr takes a free key: ctrl+alt+shift+6');

  // remove: windows close, key is free, data stays
  u.remove('paletr');
  await wait(300);
  check(!u.Host.isRunning('paletr'), 'paletr removed');
  check(paletrWins().length === 0, "paletr's windows closed");
  check(u.Shortcuts.ownerOf('Control+Alt+Shift+6') === null, "paletr's key is free again");
  check(fs.existsSync(path.join(u.Host.dataDir('paletr'), 'paletr.json')), "paletr's data stays on disk");

  // and back: key and palette remembered
  u.install('paletr');
  await wait(300);
  const t = u.publicState().tools.find((x) => x.id === 'paletr');
  check(t.keys[0].combo === 'ctrl+alt+shift+6', 'reinstalled paletr remembers its key');
  const saved = JSON.parse(fs.readFileSync(path.join(u.Host.dataDir('paletr'), 'paletr.json'), 'utf8'));
  check(saved.colors.join() === BLUE && saved.format === 'hex', 'and its palette');
}
// clipr: install, record, find, pick, private clips, keys, remove, reinstall.
// It uses the real clipboard, so what was on it is put back at the end. Enter
// (paste) is never pressed here: it would paste into whatever you have open.
async function clipr(u) {
  const { clipboard, ClipboardItem } = require('electron');
  let saved = null;
  try { saved = await clipboard.readText(); } catch (_) {}
  const copy = async (text) => { await clipboard.writeText(text); await wait(650); };
  const popup = () => BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'clipr');
  try {
    u.openLauncher('tools');
    await wait(700);
    const L = u.launcherWin();
    await js(L, `document.querySelector('[data-act="install"][data-id="clipr"]').click()`);
    await wait(500);
    check(u.Host.isRunning('clipr'), 'clipr installed from the tools page');
    check(u.Store.get().pinned.includes('clipr'), 'clipr is in the quick view');
    check(u.Shortcuts.ownerOf('Alt+Shift+V') === 'clipr', 'clipr has alt+shift+v');
    check(!popup(), 'no clipr window until you open it');
    await js(L, `document.body.classList.add('hover')`);
    await shot(L, '20-clipr-tools');
    L.webContents.send('utilr:tab', 'keys');
    await wait(300);
    await shot(L, '21-clipr-keys');
    u.closeLauncher();
    await wait(300);
    u.showQuick();
    await wait(450);
    await shot(u.quickWin(), '22-clipr-quick');
    u.hideQuick();
    await wait(200);

    const one = 'clipr smoke one', two = 'clipr smoke two\n  second line\n  third line', three = 'clipr smoke three: https://example.com/a/b';
    await copy(one);
    await copy(two);
    await copy(three);
    const EX = 'electron application/osclipboard;format="ExcludeClipboardContentFromMonitorProcessing"';
    if (process.platform === 'win32') {
      await clipboard.write([new ClipboardItem({ 'text/plain': 'clipr smoke secret', [EX]: new Blob([new Uint8Array(4)]) })]);
      await wait(650);
    }
    await copy(one); // again: back to the top, not twice

    u.Host.open('clipr');
    await wait(700);
    const C = popup();
    check(!!C && C.isVisible(), 'clipr opens');
    const texts = await js(C, `window.clipr.list('').then((r) => r.items.map((i) => i.text))`);
    const mine = texts.filter((t) => t.startsWith('clipr smoke'));
    check(mine.join('|') === [one, three, two].join('|'), 'newest first, a copy made again moves to the top');
    if (process.platform === 'win32') check(!texts.includes('clipr smoke secret'), 'a clip a password manager marks private is left out');
    await shot(C, '23-clipr');
    await js(C, `document.body.classList.add('hover')`);
    await shot(C, '24-clipr-hover');

    C.webContents.insertText('example');
    await wait(300);
    const rows = await js(C, `document.querySelectorAll('.clip').length`);
    check(rows === 1, `find "example": ${rows} clip`);
    await shot(C, '25-clipr-find');
    key(C, 'Escape');
    await wait(250);
    check((await js(C, `document.getElementById('find').value`)) === '' && (await js(C, `document.querySelectorAll('.clip').length`)) >= 3, 'esc clears the find');
    await js(C, `document.getElementById('btn-menu').click()`);
    await wait(250);
    await shot(C, '26-clipr-menu');
    const menu = await js(C, `[...document.querySelectorAll('#menu .mi')].map((m) => m.textContent.trim().replace(/\\s+/g, ' '))`);
    check(!menu.some((t) => /start with|quit/.test(t)), 'clipr menu: no start-at-login / quit rows');
    key(C, 'Escape');
    await wait(150);
    key(C, 'Delete', ['control', 'shift']);
    await wait(200);
    await shot(C, '27-clipr-confirm');
    key(C, 'n');
    await wait(150);
    key(C, 'Escape');
    await wait(300);
    check(!C.isVisible(), 'esc closes it');

    // shift+enter on the second clip: copied (not pasted), on top, popup gone
    u.Host.open('clipr');
    await wait(500);
    key(C, 'Down');
    key(C, 'Return', ['shift']);
    await wait(500);
    const got = await clipboard.readText();
    const which = [one, two, three].indexOf(got);
    check(got === three && !C.isVisible(), `shift+enter copies the clip and closes (got ${which < 0 ? 'something else' : ['one', 'two', 'three'][which]}, popup ${C.isVisible() ? 'still up' : 'gone'})`);
    const top = await js(C, `window.clipr.list('').then((r) => r.items[0].text)`);
    check(top === three, 'and it is on top now');

    // keys: one owner, like every other tool
    let r = u.setKey('clipr', 'key', 'ctrl+n');
    check(!r.ok && /notr/.test(r.error), `clipr can't take notr's key (${r.error})`);
    r = u.setKey('clipr', 'key', 'ctrl+alt+shift+7');
    check(r.ok && u.Shortcuts.ownerOf('Control+Alt+Shift+7') === 'clipr', 'clipr takes a free key');

    // remove: window closed, key free, settings stay; the history (memory only) goes
    u.remove('clipr');
    await wait(300);
    check(!u.Host.isRunning('clipr'), 'clipr removed');
    check(C.isDestroyed(), "clipr's window closed");
    check(u.Shortcuts.ownerOf('Control+Alt+Shift+7') === null, "clipr's key is free again");
    check(fs.existsSync(path.join(u.Host.dataDir('clipr'), 'clipr-settings.json')), "clipr's settings stay on disk");
    u.install('clipr');
    await wait(400);
    check(u.publicState().tools.find((t) => t.id === 'clipr').keys[0].combo === 'ctrl+alt+shift+7', 'reinstalled clipr remembers its key');
    u.Host.open('clipr');
    await wait(700);
    const after = await js(popup(), `window.clipr.list('').then((r) => r.items.map((i) => i.text))`);
    check(after.length === 1 && after[0] === got, `a fresh history: only what is on the clipboard now (${after.length} clip${after.length === 1 ? '' : 's'})`);
    await js(popup(), `window.clipr.hide()`);
    u.setKey('clipr', 'key', 'alt+shift+v');
    await wait(300);
  } finally {
    if (saved) { try { await clipboard.writeText(saved); } catch (_) {} }
  }
}

module.exports = async (u) => {
  try {
    await wait(400);
    const st0 = u.publicState();
    check(st0.tools.length >= 2, `catalog has ${st0.tools.map((t) => t.id).join(', ')}`);
    check(st0.tools.every((t) => !t.installed), 'fresh start: nothing installed');

    u.openLauncher('tools');
    await wait(700);
    const L = u.launcherWin();
    await shot(L, '01-tools-empty');

    // install both, from the page itself
    await js(L, `document.querySelector('[data-act="install"][data-id="notr"]').click()`);
    await wait(500);
    await js(L, `document.querySelector('[data-act="install"][data-id="snipr"]').click()`);
    await wait(500);
    await js(L, `document.querySelector('[data-act="install"][data-id="paletr"]').click()`);
    await wait(700);
    check(u.Host.isRunning('notr') && u.Host.isRunning('snipr'), 'notr and snipr installed and running');
    check(u.Host.isRunning('paletr'), 'paletr installed and running');
    check(u.Store.get().pinned.join() === 'notr,snipr,paletr', 'all three pinned, in install order');
    const pk = u.publicState().tools.find((t) => t.id === 'paletr').keys[0];
    check(pk && pk.combo === 'alt+shift+p' && pk.ok, `paletr holds its pick key (${pk && pk.combo})`);
    check(paletrWins().length === 0, 'paletr starts with no windows');
    await js(L, `document.body.classList.add('hover')`);
    await shot(L, '02-tools');

    await js(L, `document.querySelector('[data-act="more"][data-id="snipr"]').click()`);
    await wait(250);
    await shot(L, '03-tools-actions');

    for (const [i, tab] of [['04', 'quick'], ['05', 'keys'], ['06', 'settings']]) {
      L.webContents.send('utilr:tab', tab);
      await wait(300);
      await shot(L, `${i}-${tab}`);
    }

    // keys: one owner per key, across utilr and every tool
    const free = 'ctrl+alt+shift+9';
    let r = u.setKey('snipr', 'textKey', 'alt+shift+u');
    check(!r.ok && /utilr/.test(r.error), `snipr can't take utilr's key (${r.error})`);
    r = u.setKey('snipr', 'key', free);
    check(r.ok, `snipr takes a free key: ${free}`);
    check(u.Shortcuts.ownerOf('Control+Alt+Shift+9') === 'snipr', 'the registry says snipr has it');
    r = u.setKey('utilr', 'quick', free);
    check(!r.ok && /snipr/.test(r.error), `utilr can't take snipr's key (${r.error})`);
    r = u.setKey('notr', 'open', 'ctrl+s');
    check(!r.ok && /add note/.test(r.error), `notr keeps its own rules (${r.error})`);
    r = u.setKey('utilr', 'launcher', '');
    check(r.ok && u.Store.get().keys.launcher === '', 'utilr keys can be cleared');
    r = u.setKey('utilr', 'launcher', 'alt+shift+u');
    check(r.ok, 'and set again');
    for (const t of u.publicState().tools) for (const k of t.keys) log(`     ${t.id}.${k.id} = ${k.combo} ${k.ok ? '' : '(taken: another program has it)'}`);

    // the quick view
    u.closeLauncher();
    await wait(300);
    u.showQuick();
    await wait(450);
    const Q = u.quickWin();
    check(Q.isVisible(), 'quick view shows');
    const b = Q.getBounds();
    log(`     quick view ${b.width} × ${b.height} at ${b.x},${b.y}`);
    await shot(Q, '07-quick');
    Q.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Down' });
    await wait(200);
    check((await js(Q, `document.getElementById('label').textContent`)) === 'snipr', 'arrow down selects snipr');
    await shot(Q, '08-quick-down');
    Q.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    await wait(300);
    check(!Q.isVisible(), 'esc hides it');

    // open notr through the quick view: 1
    u.showQuick();
    await wait(400);
    Q.webContents.sendInputEvent({ type: 'keyDown', keyCode: '1' });
    await wait(900);
    const notes = BrowserWindow.getAllWindows().filter((w) => w.getTitle() === 'notr' && w.isVisible());
    check(notes.length >= 1, `"1" opened notr (${notes.length} note${notes.length === 1 ? '' : 's'})`);
    if (notes[0]) await shot(notes[0], '09-notr-note');

    // snipr's settings window, through its action
    u.Host.run('snipr', 'settings');
    await wait(800);
    const sw = BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'snipr' && w.isVisible() && w.getBounds().width === 320);
    check(!!sw, 'snipr settings opens');
    if (sw) {
      const rows = await js(sw, `[...document.querySelectorAll('.mi')].map((m) => m.textContent.trim().replace(/\\s+/g, ' '))`);
      check(!rows.some((t) => /start with|quit snipr/.test(t)), 'snipr settings: no start-at-login / quit rows in utilr');
      await shot(sw, '10-snipr-settings');
    }

    // memory, with both tools installed and windows open
    const mem = app.getAppMetrics().reduce((s, m) => s + m.memory.workingSetSize, 0);
    log(`     memory: ${(mem / 1024).toFixed(0)} MB in ${app.getAppMetrics().length} processes (notes + snipr settings open)`);

    // remove snipr: its windows go, its keys are free again
    const before = BrowserWindow.getAllWindows().length;
    u.remove('snipr');
    await wait(300);
    check(!u.Host.isRunning('snipr'), 'snipr removed');
    check(u.Shortcuts.ownerOf('Control+Alt+Shift+9') === null, "snipr's key is free again");
    check(BrowserWindow.getAllWindows().length < before, `snipr's windows closed (${before} → ${BrowserWindow.getAllWindows().length})`);
    check(fs.existsSync(path.join(u.Host.dataDir('snipr'), 'snipr-settings.json')), "snipr's settings stay on disk");
    check(!u.Store.get().pinned.includes('snipr'), 'and it left the quick view');

    // and back: settings remembered
    u.install('snipr');
    await wait(300);
    check(u.publicState().tools.find((t) => t.id === 'snipr').keys[0].combo === free, 'reinstalled snipr remembers its key');

    await measr(u);

    // paletr, end to end
    await testPaletr(u);

    await clipr(u);

    // idle footprint: no tool windows open
    u.Host.run('notr', 'close');
    await wait(600);
    const idle = app.getAppMetrics();
    for (const m of idle) log(`       ${m.type.padEnd(8)} ${(m.memory.workingSetSize / 1024).toFixed(0).padStart(4)} MB  private ${((m.memory.privateBytes || 0) / 1024).toFixed(0)} MB  ${m.name || ''}`);
    log(`     idle memory: ${(idle.reduce((s, m) => s + m.memory.workingSetSize, 0) / 1024).toFixed(0)} MB in ${idle.length} processes`);
  } catch (err) {
    failed++;
    log('FAIL ' + (err && err.stack || err));
  }
  log(failed ? `${failed} failed` : 'all good');
  fs.writeFileSync(path.join(out, 'smoke.log'), lines.join('\n') + '\n');
  app.exit(failed ? 1 : 0);
};

// ---- measr: install, its key, a real open, then a made-up screen with known
// shapes on it, measured through the real overlay (mouse, keys, clipboard).
async function measr(u) {
  const keepClip = await clipboard.readText().catch(() => '');
  const wins = () => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w.getTitle() === 'measr');
  const shown = () => wins().filter((w) => w.isVisible());

  u.install('measr');
  await wait(1200); // the overlays warm up
  check(u.Host.isRunning('measr'), 'measr installed and running');
  check(u.Shortcuts.ownerOf('Alt+Shift+M') === 'measr', 'measr holds alt+shift+m');
  const t = u.publicState().tools.find((x) => x.id === 'measr');
  check(t.keys.length === 1 && t.keys[0].ok, 'measr key is on the keys page, registered');
  check(t.actions.map((a) => a.id).join() === 'measure,delay,settings', `measr actions: ${t.actions.map((a) => a.label).join(', ')}`);
  check(u.Store.get().pinned.includes('measr'), 'measr is on the quick view');
  check(wins().length >= screen.getAllDisplays().length && !shown().length, `one overlay per display, warm and hidden (${wins().length})`);

  // the real screen
  let t0 = Date.now();
  u.Host.open('measr');
  while (!shown().length && Date.now() - t0 < 3000) await wait(20);
  await wait(300);
  const cur = screen.getCursorScreenPoint();
  const ov = shown().find((w) => { const b = w.getBounds(); return cur.x >= b.x && cur.x < b.x + b.width && cur.y >= b.y && cur.y < b.y + b.height; }) || shown()[0];
  check(!!ov, `measr opens over the screen (${Date.now() - t0} ms)`);
  if (!ov) return;
  await shot(ov, '41-measr-real');

  // a screen we know: two light boxes 16 px apart, a dark block inside the first
  const b = ov.getBounds();
  const d = screen.getDisplayMatching(b);
  const W = Math.round(d.size.width * d.scaleFactor), H = Math.round(d.size.height * d.scaleFactor);
  const bmp = Buffer.alloc(W * H * 4);
  const fill = (x, y, w, h, v) => { for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) { const i = (yy * W + xx) * 4; bmp[i] = bmp[i + 1] = bmp[i + 2] = v; bmp[i + 3] = 255; } };
  fill(0, 0, W, H, 0x11);
  fill(100, 100, 240, 48, 0xd6); // A
  fill(356, 100, 120, 48, 0xd6); // B, 16 px right of A
  fill(116, 112, 60, 24, 0x33);  // inside A: 12 down, 16 in
  const settings = { key: 'alt+shift+m', keyOk: true, units: 'screen', format: 'plain', edges: 'soft', loupe: 'off', hints: false, platform: process.platform, version: 'test', hosted: true };
  ov.webContents.send('overlay:open', { sid: 999, width: W, height: H, bitmap: bmp, scale: d.scaleFactor, active: true, cursor: { x: 5, y: 5 }, settings, keyLabel: '' });
  await wait(500);
  const k = W / b.width;
  const at = (x, y) => ({ x: Math.round((x + 0.5) / k), y: Math.round((y + 0.5) / k) });
  const send = (e) => ov.webContents.sendInputEvent(e);
  const move = async (x, y) => { send({ type: 'mouseMove', ...at(x, y) }); await wait(40); };
  const key = async (keyCode, modifiers = []) => { send({ type: 'keyDown', keyCode, modifiers }); send({ type: 'char', keyCode, modifiers }); send({ type: 'keyUp', keyCode, modifiers }); await wait(150); };
  const dragFrom = async (x1, y1, x2, y2) => {
    await move(x1, y1);
    send({ type: 'mouseDown', ...at(x1, y1), button: 'left', clickCount: 1 });
    for (let i = 1; i <= 6; i++) await move(x1 + ((x2 - x1) * i) / 6, y1 + ((y2 - y1) * i) / 6);
    send({ type: 'mouseUp', ...at(x2, y2), button: 'left', clickCount: 1 });
    await wait(250);
  };
  const clip = () => clipboard.readText();
  const ctrlC = () => key('C', ['control']);

  await move(348, 124);
  await ctrlC();
  check((await clip()) === `16 × ${H}`, `the space between two boxes: ${await clip()}`);
  await move(200, 104);
  await key('C');
  check((await clip()) === '#d6d6d6', `c copies the colour: ${await clip()}`);
  await dragFrom(80, 80, 344, 170);
  await ctrlC();
  check((await clip()) === '240 × 48', `a loose box snaps to what's in it: ${await clip()}`);
  await dragFrom(350, 86, 492, 166);
  await ctrlC();
  check((await clip()) === '120 × 48', `and a second one: ${await clip()}`);
  await key('A');
  check(/gap {2}16/.test(await clip()), `two boxes: the gap between them (${(await clip()).replace(/\n/g, ' / ')})`);
  await move(130, 120);
  send({ type: 'mouseDown', ...at(130, 120), button: 'left', clickCount: 1 });
  send({ type: 'mouseUp', ...at(130, 120), button: 'left', clickCount: 1 });
  send({ type: 'mouseDown', ...at(130, 120), button: 'left', clickCount: 2 });
  send({ type: 'mouseUp', ...at(130, 120), button: 'left', clickCount: 2 });
  await wait(300);
  await ctrlC();
  check((await clip()) === '60 × 24', `dbl-click boxes the element: ${await clip()}`);
  await key('A');
  check(/padding {2}12 164 12 16/.test(await clip()), 'a box inside a box: its padding');
  await shot(ov, '42-measr-measures');
  ov.webContents.send('settings:changed', { ...settings, loupe: 'always' });
  await move(420, 200);
  await move(348, 124);
  await shot(ov, '43-measr-live');
  send({ type: 'mouseDown', ...at(600, 400), button: 'right', clickCount: 1 });
  send({ type: 'mouseUp', ...at(600, 400), button: 'right', clickCount: 1 });
  await wait(300);
  check(await js(ov, `!document.getElementById('menu').hidden`), 'right click opens the menu');
  await shot(ov, '44-measr-menu');
  await key('Escape');
  await key('?');
  check(await js(ov, `!document.getElementById('keys').hidden`), '? shows the keys');
  await shot(ov, '45-measr-keys');
  await key('Escape');
  // enter: copy and close, with a notice in the corner
  await move(348, 124);
  await key('Return');
  await wait(400);
  check(!shown().some((w) => w.getBounds().width === b.width), 'enter copies and closes');
  const toastWin = shown().find((w) => w.getBounds().width === 300);
  check(!!toastWin, 'and says so in the corner');
  if (toastWin) await shot(toastWin, '46-measr-toast');

  // the key again closes it
  u.Host.open('measr');
  t0 = Date.now();
  while (!shown().some((w) => w.getBounds().width !== 300) && Date.now() - t0 < 3000) await wait(20);
  await wait(300);
  const o2 = shown().find((w) => w.getBounds().width !== 300);
  if (o2) o2.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  await wait(300);
  check(!shown().some((w) => w.getBounds().width !== 300), 'esc closes it');

  // settings window
  u.Host.run('measr', 'settings');
  await wait(800);
  const sw = shown().find((w) => w.getBounds().width === 320);
  check(!!sw, 'measr settings opens');
  if (sw) {
    const rows = await js(sw, `[...document.querySelectorAll('.mi')].map((m) => m.textContent.trim().replace(/\\s+/g, ' '))`);
    log(`     ${rows.join(' | ')}`);
    check(!rows.some((r) => /start with|quit/.test(r)), 'measr settings: no start-at-login / quit rows in utilr');
    const fits = await js(sw, `document.querySelector('.content').scrollHeight <= document.querySelector('.content').clientHeight`);
    check(fits, 'measr settings fit their window');
    await shot(sw, '47-measr-settings');
  }

  // keys, remove, reinstall
  const sniprKey = u.publicState().tools.find((x) => x.id === 'snipr').keys[0].combo;
  let r = u.setKey('measr', 'key', sniprKey);
  check(!r.ok && /snipr/.test(r.error), `measr can't take snipr's key, ${sniprKey} (${r.error})`);
  r = u.setKey('measr', 'key', 'ctrl+alt+shift+m');
  check(r.ok && u.Shortcuts.ownerOf('Control+Alt+Shift+M') === 'measr', 'measr takes a free key');
  await wait(400);
  u.remove('measr');
  await wait(300);
  check(!u.Host.isRunning('measr'), 'measr removed');
  check(u.Shortcuts.ownerOf('Control+Alt+Shift+M') === null, "measr's key is free again");
  check(wins().length === 0, "measr's windows are all gone");
  check(fs.existsSync(path.join(u.Host.dataDir('measr'), 'measr-settings.json')), "measr's settings stay on disk");
  u.install('measr');
  await wait(300);
  check(u.publicState().tools.find((x) => x.id === 'measr').keys[0].combo === 'ctrl+alt+shift+m', 'reinstalled measr remembers its key');
  await clipboard.writeText(keepClip).catch(() => {});
}

// ---- launched as `electron scripts/smoke.js`: start utilr in test mode. main.js
// then requires this file again (from the cache) and calls the export above.
if (!process.env.UTILR_SMOKE) {
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  // Earlier runs' data folders hold copies of your notr / snipr data (the import).
  // Chromium keeps a run's folder locked until it exits, so each run clears the last.
  for (const d of fs.readdirSync(os.tmpdir())) {
    if (d.startsWith('utilr-smoke-')) { try { fs.rmSync(path.join(os.tmpdir(), d), { recursive: true, force: true }); } catch (_) {} }
  }
  process.env.UTILR_SMOKE = __filename;
  process.env.UTILR_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'utilr-smoke-'));
  require(path.join(root, 'src', 'main.js'));
}
