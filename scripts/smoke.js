'use strict';
// Dev smoke test. Run with:  npx electron scripts/smoke.js <outDir>
// Phase 1 (default) drives the real app with a throwaway data folder;
// NOTR_PHASE=2 relaunches it and checks everything came back.

const path = require('path');
const fs = require('fs');
const out = path.resolve(process.argv[2] || 'smoke-out');
fs.mkdirSync(out, { recursive: true });
process.env.NOTR_USER_DATA = path.join(out, 'data');
const phase = process.env.NOTR_PHASE || '1';
if (phase === '1') {
  fs.rmSync(process.env.NOTR_USER_DATA, { recursive: true, force: true });
  // start from an older (v3) setup like the user's: add=ctrl+n, open=ctrl+b
  fs.mkdirSync(process.env.NOTR_USER_DATA, { recursive: true });
  fs.writeFileSync(path.join(process.env.NOTR_USER_DATA, 'notr-state.json'), JSON.stringify({
    version: 3,
    settings: { theme: 'ghost', seq: 1, shortcuts: { add: 'ctrl+n', del: 'ctrl+d', open: 'ctrl+b' } },
    notes: [{ id: 'nseed', seq: 1, html: '', bounds: { x: 810, y: 244, width: 300, height: 300 }, dot: 'green' }],
  }));
}

const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration(); // capturePage is more reliable without GPU here
require('../src/main.js');

const log = [];
let failures = 0;
const L = (...a) => { const s = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '); log.push(s); console.log(s); };
const check = (name, ok, detail) => { if (!ok) failures++; L(ok ? 'PASS' : 'FAIL', name, detail === undefined ? '' : detail); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const wins = () => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
const shot = async (win, name) => fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG());
const js = (win, code) => win.webContents.executeJavaScript(code, true);
const stateFile = () => JSON.parse(fs.readFileSync(path.join(process.env.NOTR_USER_DATA, 'notr-state.json'), 'utf8'));
const key = (win, keyCode, modifiers = []) => {
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
};
const status = (w) => js(w, `[...document.querySelectorAll('.status > span')].filter(s=>!s.hidden).map(s=>s.textContent).join(' | ') + (document.body.classList.contains('no-status') ? ' (bar hidden)' : '')`);
const text = (w) => js(w, `document.getElementById('editor').innerText`);

// Ask Windows which of two windows is higher in the z-order ('a' or 'b').
function frontOf(a, b) {
  const h = (w) => w.getNativeWindowHandle().readBigUInt64LE(0).toString();
  const ps = `Add-Type @'
using System; using System.Runtime.InteropServices;
public static class Z { [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint c);
  public static string Front(long a, long b) { IntPtr x = new IntPtr(a); while (x != IntPtr.Zero) { x = GetWindow(x, 3); if (x == new IntPtr(b)) return "b"; } return "a"; } }
'@
[Z]::Front(${h(a)}, ${h(b)})`;
  return require('child_process').execFileSync('powershell', ['-NoProfile', '-Command', ps]).toString().trim();
}

app.on('browser-window-created', (_e, w) => {
  w.webContents.on('console-message', (e) => L('[renderer]', String(e.message || e)));
});

async function phase1() {
  const [w1] = wins();
  w1.focus();
  await js(w1, `document.getElementById('editor').focus()`);

  // upgrade from v3: add note moves to ctrl+s, the other keys are kept
  const migrated = await js(w1, `window.notr.init().then(d => d.settings.shortcuts)`);
  check('old setup migrated: add=ctrl+s, open kept', migrated.add === 'ctrl+s' && migrated.open === 'ctrl+b', migrated);
  await js(w1, `window.notr.setSettings({ shortcut: { action: 'open', combo: 'ctrl+n' } })`);
  await wait(300);
  check('open notr back to ctrl+n', require('electron').globalShortcut.isRegistered('Control+N'));

  // ctrl+s adds a note, ctrl+d removes the empty one again
  key(w1, 'S', ['control']);
  await wait(900);
  check('ctrl+s adds a note', wins().length === 2);
  const wTmp = wins().find((w) => w !== w1);
  await js(wTmp, `document.getElementById('editor').focus()`);
  key(wTmp, 'D', ['control']);
  await wait(700);
  check('ctrl+d removes it', wins().length === 1);
  w1.focus();
  await js(w1, `document.getElementById('editor').focus()`);

  // empty note: nothing written, ghost default, only "0 chars"
  check('default theme is ghost', (await js(w1, `document.body.dataset.theme`)) === 'ghost');
  check('empty note shows no placeholder text', (await js(w1, `document.querySelector('.placeholder') === null && document.querySelector('.body').innerText.trim() === ''`)));
  check('status default = chars only', (await status(w1)) === '0 chars', await status(w1));
  await shot(w1, '01-empty');

  // typing
  w1.webContents.insertText('hello');
  await js(w1, `document.execCommand('insertLineBreak')`);
  w1.webContents.insertText('world');
  await wait(300);
  check('chars count', (await status(w1)) === '11 chars', await status(w1));

  // settings menu contents
  await js(w1, `document.getElementById('btn-settings').click()`);
  await wait(200);
  const items = await js(w1, `[...document.querySelectorAll('#menu .mi, #menu .stepper')].map(b=>b.innerText.replace(/\\s+/g,' ').trim()).join(' | ')`);
  L('settings:', items);
  check('settings has line/col, chars, shortcuts; no new note / quit', /line \/ col off/.test(items) && /chars on/.test(items) && /shortcuts/.test(items) && !/quit|new note/.test(items));
  await shot(w1, '02-settings');

  // toggle line / col -> shows on the left, in every note
  await js(w1, `[...document.querySelectorAll('#menu .mi')].find(b=>b.innerText.startsWith('line')).click()`);
  await wait(200);
  check('line/col on', /^ln 2, col 6 \| 11 chars$/.test(await status(w1)), await status(w1));

  // shortcuts -> written into the note
  await js(w1, `[...document.querySelectorAll('#menu .mi')].find(b=>b.innerText.startsWith('shortcuts')).click()`);
  await wait(300);
  const t1 = await text(w1);
  L('note text:\n' + t1);
  check('shortcut list written', t1.includes('add note [ctrl+s]\ndelete note [ctrl+d]\nopen notr [ctrl+n]\nresize note: ctrl + arrows\nmove note: alt + arrows\nseparator: /line + enter'));
  await shot(w1, '03-shortcuts');

  // editing the brackets changes the shortcut (after typing pauses)
  await js(w1, `(() => {
    const e = document.getElementById('editor');
    const w = document.createTreeWalker(e, NodeFilter.SHOW_TEXT);
    let n; while ((n = w.nextNode())) { const i = n.data.indexOf('[ctrl+s]'); if (i >= 0) {
      const r = document.createRange(); r.setStart(n, i + 1); r.setEnd(n, i + 7);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r); break; } }
  })()`);
  w1.webContents.insertText('ctrl+alt+k');
  await wait(1300);
  check('add note rebound to ctrl+alt+k', stateFile().settings.shortcuts.add === 'ctrl+alt+k', stateFile().settings.shortcuts);

  // ctrl+s no longer adds; ctrl+alt+k does
  key(w1, 'S', ['control']);
  await wait(700);
  check('ctrl+s does nothing now', wins().length === 1);
  key(w1, 'K', ['control', 'alt']);
  await wait(900);
  check('ctrl+alt+k adds a note', wins().length === 2);
  const w2 = wins().find((w) => w !== w1);
  check('new note sits right of the first', w2.getBounds().x === w1.getBounds().x + w1.getBounds().width + 14, w2.getBounds());
  check('new note shows line/col too', /^ln 1, col 1 \| 0 chars$/.test(await status(w2)), await status(w2));

  // ctrl+d deletes (empty note: no question)
  await js(w2, `document.getElementById('editor').focus()`);
  key(w2, 'D', ['control']);
  await wait(700);
  check('ctrl+d deletes empty note', wins().length === 1);

  // per-theme font: 18px in ghost, default in paper, back to 18px in ghost
  await js(w1, `window.notr.setSettings({ font: { theme: 'ghost', value: { size: 18, bold: true } } })`);
  await wait(300);
  const fs1 = await js(w1, `document.getElementById('editor').style.fontSize + ' ' + document.getElementById('editor').style.fontWeight`);
  check('ghost font 18px bold', fs1 === '18px 700', fs1);
  await js(w1, `window.notr.setSettings({ theme: 'paper' })`);
  await wait(300);
  check('paper keeps its own (default) font', (await js(w1, `document.getElementById('editor').style.fontSize`)) === '');
  await shot(w1, '04-paper');
  await js(w1, `window.notr.setSettings({ theme: 'ghost' })`);
  await wait(300);
  check('ghost font remembered', (await js(w1, `document.getElementById('editor').style.fontSize`)) === '18px');

  // caret follows when the text grows past the bottom, and back up
  await js(w1, `(() => { const e=document.getElementById('editor'); const r=document.createRange(); r.selectNodeContents(e); r.collapse(false); const s=getSelection(); s.removeAllRanges(); s.addRange(r); })()`);
  for (let i = 0; i < 30; i++) { key(w1, 'Return'); await wait(15); }
  w1.webContents.insertText('bottom line');
  await wait(400);
  const caretVisible = `(() => { const s=getSelection(); const r=document.createRange(); r.setStart(s.focusNode, s.focusOffset); let rc=r.getClientRects()[0]; if(!rc){ const n=s.focusNode.childNodes ? (s.focusNode.childNodes[s.focusOffset]||s.focusNode.childNodes[s.focusOffset-1]) : null; rc=(n && n.getBoundingClientRect) ? n.getBoundingClientRect() : s.focusNode.parentElement.getBoundingClientRect(); } const b=document.getElementById('body').getBoundingClientRect(); return rc.top >= b.top - 1 && rc.bottom <= b.bottom + 1; })()`;
  const st1 = await js(w1, `document.getElementById('body').scrollTop`);
  check('scrolled down with the caret', st1 > 0 && (await js(w1, caretVisible)), 'scrollTop=' + st1);
  await shot(w1, '05-scrolled-bottom');
  for (let i = 0; i < 50; i++) { key(w1, 'Up'); await wait(15); }
  await wait(300);
  const st2 = await js(w1, `document.getElementById('body').scrollTop`);
  check('scrolled back up with arrow keys', st2 === 0 && (await js(w1, caretVisible)), 'scrollTop=' + st2);

  // /line + enter -> separator
  await js(w1, `(() => { const e=document.getElementById('editor'); const r=document.createRange(); r.selectNodeContents(e); r.collapse(false); const s=getSelection(); s.removeAllRanges(); s.addRange(r); })()`);
  key(w1, 'Return');
  await wait(50);
  w1.webContents.insertText('/line');
  await wait(50);
  key(w1, 'Return');
  await wait(100);
  w1.webContents.insertText('after the line');
  await wait(300);
  const sep = await js(w1, `(() => { const e = document.getElementById('editor'); const hr = e.querySelectorAll('hr'); return { hrs: hr.length, cmdLeft: e.innerText.split('\\n').some(l => l.trim() === '/line'), after: hr.length ? (hr[hr.length-1].nextSibling ? hr[hr.length-1].nextSibling.textContent : '') : '' }; })()`);
  check('/line becomes a separator', sep.hrs === 1 && !sep.cmdLeft && sep.after.startsWith('after the line'), sep);
  await shot(w1, '05b-separator');
  key(w1, 'Return');
  w1.webContents.insertText('not /line here');
  key(w1, 'Return');
  await wait(300);
  check('"/line" inside other text stays text', (await js(w1, `document.getElementById('editor').querySelectorAll('hr').length`)) === 1);

  // ctrl+arrows resize, alt+arrows move (while held)
  const hold = async (keyCode, mods, ms) => {
    w1.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers: mods });
    await wait(ms);
    w1.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers: mods });
    await wait(150);
  };
  const g0 = w1.getBounds();
  await hold('Right', ['control'], 0);
  const g1 = w1.getBounds();
  check('ctrl+right tap nudges a few px wider', g1.width - g0.width >= 1 && g1.width - g0.width <= 20 && g1.x === g0.x, `${g0.width} -> ${g1.width}`);
  await hold('Right', ['control'], 700);
  const g2 = w1.getBounds();
  check('ctrl+right held keeps growing', g2.width - g1.width > 120 && g2.height === g1.height, `${g1.width} -> ${g2.width}`);
  await hold('Down', ['control'], 400);
  const g3 = w1.getBounds();
  check('ctrl+down grows taller', g3.height > g2.height + 40, `${g2.height} -> ${g3.height}`);
  await hold('Left', ['control'], 2000);
  await hold('Up', ['control'], 2000);
  const g4 = w1.getBounds();
  check('ctrl+left/up shrink to the minimum', g4.width === 200 && g4.height === 150, g4);
  check('caret was not moved by ctrl+arrows', (await js(w1, `getSelection().anchorNode !== null`)));
  await hold('Down', ['alt'], 400);
  const g5 = w1.getBounds();
  check('alt+down moves the note down', g5.y > g4.y + 40 && g5.x === g4.x && g5.width === g4.width, `${g4.y} -> ${g5.y}`);
  await hold('Up', ['alt'], 3000);
  const wa = require('electron').screen.getDisplayMatching(w1.getBounds()).workArea;
  check('alt+up stops at the top of the screen', w1.getBounds().y === wa.y, w1.getBounds());
  await wait(500);
  const saved = stateFile().notes.find((n) => n.bounds.width === 200);
  check('keyboard size/position saved', !!saved && saved.bounds.y === wa.y, saved && saved.bounds);
  w1.setBounds({ ...g0 });
  await wait(400);

  // chars off + line/col off -> no status bar at all
  await js(w1, `window.notr.setSettings({ status: { pos: false, chars: false } })`);
  await wait(300);
  check('both off hides status bar', (await status(w1)).includes('(bar hidden)'));
  await js(w1, `window.notr.setSettings({ status: { chars: true } })`);
  await wait(500);

  // z-order between notes
  key(w1, 'K', ['control', 'alt']);
  await wait(900);
  const w3 = wins().find((w) => w !== w1);
  const b1 = w1.getBounds();
  w3.setBounds({ ...w3.getBounds(), x: b1.x + 40, y: b1.y + 40 });
  w3.focus(); await wait(300);
  const z1 = frontOf(w1, w3);
  w1.focus(); await wait(300);
  const z2 = frontOf(w1, w3);
  check('clicked note comes to front', z1 === 'b' && z2 === 'a', z1 + z2);
  w3.setBounds({ ...w3.getBounds(), x: b1.x + b1.width + 14, y: b1.y });
  await wait(600);

  // delete prompt: "delete note?" [y]es [n]o [d]ont show again
  key(w1, 'K', ['control', 'alt']);
  await wait(900);
  const w4 = wins().find((w) => ![w1, w3].includes(w));
  w4.webContents.insertText('some text');
  await wait(200);
  await js(w4, `document.getElementById('btn-close').click()`);
  await wait(250);
  const prompt = await js(w4, `document.getElementById('confirm').hidden ? 'hidden' : document.getElementById('confirm').innerText.replace(/\\s+/g,' ').trim()`);
  check('delete prompt text', prompt === 'delete note? [y]es [n]o [d]ont show again', prompt);
  await shot(w4, '07-delete-prompt');
  key(w4, 'D');
  await wait(700);
  check('[d] deletes the note', wins().length === 2);
  check('[d] turns the question off', stateFile().settings.confirmDelete === false);

  key(w1, 'K', ['control', 'alt']);
  await wait(900);
  const w5 = wins().find((w) => ![w1, w3].includes(w));
  w5.webContents.insertText('more text');
  await wait(200);
  await js(w5, `document.getElementById('btn-close').click()`);
  await wait(700);
  check('no question once turned off', wins().length === 2);

  // settings: ask before delete back on, always on top off
  await js(w1, `document.getElementById('btn-settings').click()`);
  await wait(200);
  await js(w1, `[...document.querySelectorAll('#menu .mi')].find(b=>b.innerText.includes('ask before')).click()`);
  await js(w1, `[...document.querySelectorAll('#menu .mi')].find(b=>b.innerText.includes('always on top')).click()`);
  await wait(400);
  await shot(w1, '08-settings-ontop-off');
  check('always on top off for every note', wins().every((w) => !w.isAlwaysOnTop()));
  check('ask before delete back on', stateFile().settings.confirmDelete === true);
  const order = await js(w1, `[...document.getElementById('menu').children].slice(0, 3).map(e => e.classList.contains('sep') ? '---' : e.innerText.split(/\\s+/)[0]).join(' ')`);
  check('separator between theme and font', order === 'theme --- font', order);
  check('start with windows row', await js(w1, `[...document.querySelectorAll('#menu .mi')].some(b => b.innerText.includes('start with windows'))`));

  // closing notr (Alt+F4 / taskbar) keeps it in the tray; "open notr" brings the notes back
  const before = wins().map((w) => w.getBounds()).sort((a, b) => a.x - b.x);
  w1.close();
  await wait(800);
  check('closing notr closes every note', wins().length === 0);
  check('notr still running and listening for ctrl+n', require('electron').globalShortcut.isRegistered('Control+N'));
  app.emit('second-instance'); // same path as the shortcut / starting notr again
  await wait(1500);
  const after = wins().map((w) => w.getBounds()).sort((a, b) => a.x - b.x);
  check('open notr restores the same notes in place', JSON.stringify(before) === JSON.stringify(after), after);

  fs.writeFileSync(path.join(out, 'log1.txt'), log.join('\n'));
  await js(wins()[0], `window.notr.quit()`);
}

async function phase2() {
  const ws = wins();
  check('restored 2 notes', ws.length === 2, ws.length);
  const s = stateFile().settings;
  check('settings persisted', s.theme === 'ghost' && s.fonts.ghost.size === 18 && s.shortcuts.add === 'ctrl+alt+k' && s.status.chars && !s.status.pos && s.onTop === false, s);
  check('restored notes are not always on top', ws.every((w) => !w.isAlwaysOnTop()));
  for (const w of ws) {
    const fz = await js(w, `document.getElementById('editor').style.fontSize`);
    check('restored note uses ghost font 18px', fz === '18px', fz);
  }
  await shot(ws[0], '06-restored');
  fs.writeFileSync(path.join(out, 'log2.txt'), log.join('\n'));
  app.quit();
}

app.whenReady().then(async () => {
  await wait(1500);
  try {
    if (phase === '1') await phase1(); else await phase2();
  } catch (err) {
    L('ERROR', err.stack || String(err));
    failures++;
  }
  L(failures ? `${failures} FAILED` : 'ALL PASSED');
  if (failures) { fs.writeFileSync(path.join(out, 'log' + phase + '.txt'), log.join('\n')); app.exit(1); }
});
