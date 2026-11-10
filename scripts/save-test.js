'use strict';
// Saved notes test. Run with:  npx electron scripts/save-test.js <outDir>
// Phase 1 (default) saves, closes and reopens notes; NOTR_PHASE=2 relaunches
// and checks a closed saved note is still a tab and opens again.

const path = require('path');
const fs = require('fs');
const out = path.resolve(process.argv[2] || 'save-out');
fs.mkdirSync(out, { recursive: true });
process.env.NOTR_USER_DATA = path.join(out, 'data');
const phase = process.env.NOTR_PHASE || '1';
if (phase === '1') fs.rmSync(process.env.NOTR_USER_DATA, { recursive: true, force: true });

const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration();
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
const text = (w) => js(w, `document.getElementById('editor').innerText`);
// the tabs in a note's title bar, e.g. "1* 2 3-" (* = this note, - = closed)
const tabsOf = (w) => js(w, `[...document.querySelectorAll('#tabs .tab')].map(b => b.textContent + (b.classList.contains('current') ? '*' : '') + (b.classList.contains('closed') ? '-' : '')).join(' ')`);
const saveBtn = (w) => js(w, `(() => { const b = document.getElementById('btn-save'); return { title: b.title, saved: b.classList.contains('saved'), disabled: b.getAttribute('aria-disabled') === 'true' }; })()`);
const click = (w, sel) => js(w, `document.querySelector(${JSON.stringify(sel)}).click()`);

const crashes = [];
process.on('uncaughtException', (err) => { crashes.push(err.message); L('CRASH', err.stack || String(err)); });
app.on('browser-window-created', (_e, w) => {
  w.webContents.on('console-message', (e) => L('[renderer]', String(e.message || e)));
});

async function phase1() {
  const [w1] = wins();
  w1.focus();
  await js(w1, `document.getElementById('editor').focus()`);

  // empty note: the save button does nothing
  const b0 = await saveBtn(w1);
  check('save button says "Save"', b0.title === 'Save' && !b0.saved, b0);
  check('save is greyed out on an empty note', b0.disabled, b0);
  await click(w1, '#btn-save');
  await wait(300);
  check('saving an empty note does nothing', (await tabsOf(w1)) === '' && !stateFile().notes.some((n) => n.saved));

  // write something and save -> tab "1"
  w1.webContents.insertText('groceries');
  await js(w1, `document.execCommand('insertLineBreak')`);
  w1.webContents.insertText('milk');
  await wait(300);
  check('save is clickable once there is text', !(await saveBtn(w1)).disabled);
  await click(w1, '#btn-save');
  await wait(400);
  check('saved note gets tab 1 (current)', (await tabsOf(w1)) === '1*', await tabsOf(w1));
  const b1 = await saveBtn(w1);
  check('save button shows saved', b1.saved && b1.title === 'Saved', b1);
  const s1 = stateFile().notes.find((n) => n.saved);
  check('saved in the state file', !!s1 && s1.slot === 1 && s1.preview === 'groceries', s1);
  check('tab hover text is the first line', (await js(w1, `document.querySelector('#tabs .tab').title`)) === '1 · groceries');
  await shot(w1, 'save-01-saved');

  // a new note sees the tab too
  key(w1, 'S', ['control']);
  await wait(900);
  const w2 = wins().find((w) => w !== w1);
  check('new note shows tab 1', (await tabsOf(w2)) === '1', await tabsOf(w2));
  w2.webContents.insertText('todo');
  await wait(200);
  await click(w2, '#btn-save');
  await wait(400);
  check('second saved note is tab 2', (await tabsOf(w2)) === '1 2*' && (await tabsOf(w1)) === '1* 2', [await tabsOf(w1), await tabsOf(w2)]);
  await shot(w2, 'save-02-two-tabs');

  // ctrl+d on a saved note: closes it, no "delete note?", tab stays
  const id1 = s1.id;
  w1.focus();
  await js(w1, `document.getElementById('editor').focus()`);
  key(w1, 'D', ['control']);
  await wait(800);
  check('ctrl+d closes the saved note without asking', wins().length === 1);
  const after = stateFile().notes.find((n) => n.id === id1);
  check('closed saved note is kept', !!after && after.saved && after.closed && after.html.includes('groceries'), after);
  check('its tab stays, shown as closed', (await tabsOf(w2)) === '1- 2*', await tabsOf(w2));
  await shot(w2, 'save-03-closed-tab');

  // click tab 1 -> it opens again with its text
  await click(w2, '#tabs .tab');
  await wait(900);
  check('clicking the tab opens the note again', wins().length === 2);
  const w1b = wins().find((w) => w !== w2);
  check('reopened note has its text', (await text(w1b)).startsWith('groceries\nmilk'), await text(w1b));
  check('tabs after reopening', (await tabsOf(w1b)) === '1* 2' && (await tabsOf(w2)) === '1 2*', [await tabsOf(w1b), await tabsOf(w2)]);
  check('reopened note does not cover the other', (() => { const a = w1b.getBounds(), b = w2.getBounds(); return a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y; })(), [w1b.getBounds(), w2.getBounds()]);

  // clicking the tab of a note that is open just brings it forward
  await click(w2, '#tabs .tab');
  await wait(400);
  check('tab of an open note focuses it', BrowserWindow.getFocusedWindow() === w1b && wins().length === 2);

  // the X on a saved note closes it too, no question
  await click(w1b, '#btn-close');
  await wait(700);
  check('× closes the saved note without asking', wins().length === 1 && (await tabsOf(w2)) === '1- 2*');
  await click(w2, '#tabs .tab');
  await wait(900);
  const w1c = wins().find((w) => w !== w2);

  // delete all the text -> no longer saved, tab goes from every note
  await js(w1c, `(() => { const e = document.getElementById('editor'); e.focus(); const r = document.createRange(); r.selectNodeContents(e); const s = getSelection(); s.removeAllRanges(); s.addRange(r); document.execCommand('delete'); })()`);
  await wait(400);
  check('emptied note loses its tab', (await tabsOf(w1c)) === '2' && (await tabsOf(w2)) === '2*', [await tabsOf(w1c), await tabsOf(w2)]);
  check('emptied note is unsaved in the state file', !stateFile().notes.find((n) => n.id === id1).saved);
  check('save button back to "Save"', (await saveBtn(w1c)).title === 'Save');
  key(w1c, 'D', ['control']);
  await wait(700);
  check('now ctrl+d deletes it for good', wins().length === 1 && !stateFile().notes.some((n) => n.id === id1));

  // the free number is used again
  key(w2, 'S', ['control']);
  await wait(900);
  const w3 = wins().find((w) => w !== w2);
  w3.webContents.insertText('third');
  await wait(200);
  await click(w3, '#btn-save');
  await wait(400);
  check('next saved note takes the free number 1', (await tabsOf(w3)) === '1* 2', await tabsOf(w3));
  key(w3, 'D', ['control']);
  await wait(700);

  // close the last open note: notr sits in the tray; opening it again gives
  // a fresh note with the saved ones as tabs
  await click(w2, '#btn-close');
  await wait(700);
  check('all notes closed', wins().length === 0);
  app.emit('second-instance');
  await wait(1500);
  check('open notr: one fresh note', wins().length === 1 && (await text(wins()[0])).trim() === '');
  check('fresh note shows both saved tabs as closed', (await tabsOf(wins()[0])) === '1- 2-', await tabsOf(wins()[0]));
  await shot(wins()[0], 'save-04-fresh-with-tabs');

  fs.writeFileSync(path.join(out, 'log1.txt'), log.join('\n'));
  await js(wins()[0], `window.notr.quit()`);
}

async function phase2() {
  const ws = wins();
  check('relaunch: only the open note comes back', ws.length === 1, ws.length);
  const w = ws[0];
  check('saved tabs survive a restart', (await tabsOf(w)) === '1- 2-', await tabsOf(w));
  await click(w, '#tabs .tab:nth-child(2)');
  await wait(900);
  const w2 = wins().find((x) => x !== w);
  check('tab 2 opens "todo"', !!w2 && (await text(w2)).trim() === 'todo', w2 && (await text(w2)));
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
  if (crashes.length) { failures++; L('FAIL main process crashed', crashes); }
  L(failures ? `${failures} FAILED` : 'ALL PASSED');
  if (failures) { fs.writeFileSync(path.join(out, 'log' + phase + '.txt'), log.join('\n')); app.exit(1); }
});
