'use strict';
// Smoke test: drives the real utilr windows and writes screenshots + a log to
// smoke-out/. Run with `npm test` (= electron scripts/smoke.js), which starts
// utilr with a throwaway data folder and hands this file its internals.

const path = require('path');
const fs = require('fs');
const os = require('os');

const root = path.join(__dirname, '..');
const out = path.join(root, 'smoke-out');

const { app, BrowserWindow } = require('electron');
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
    await wait(700);
    check(u.Host.isRunning('notr') && u.Host.isRunning('snipr'), 'notr and snipr installed and running');
    check(u.Store.get().pinned.join() === 'notr,snipr', 'both pinned, in install order');
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
