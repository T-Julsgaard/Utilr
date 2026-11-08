'use strict';
// Focused test for "the view follows the caret". Run:
//   npx electron scripts/scroll-test.js <outDir>
// Builds long notes in different shapes, then presses keys the way a person
// would and checks the caret stays in view without the view jumping.

const path = require('path');
const fs = require('fs');
const out = path.resolve(process.argv[2] || 'scroll-out');
fs.mkdirSync(out, { recursive: true });
process.env.NOTR_USER_DATA = path.join(out, 'data');
fs.rmSync(process.env.NOTR_USER_DATA, { recursive: true, force: true });

const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration();
require('../src/main.js');

let failures = 0;
const L = (...a) => console.log(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
const check = (name, ok, detail) => { if (!ok) failures++; L(ok ? 'PASS' : 'FAIL', name, detail === undefined ? '' : detail); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const js = (w, code) => w.webContents.executeJavaScript(code, true);
const key = async (w, keyCode, modifiers = [], times = 1) => {
  for (let i = 0; i < times; i++) {
    w.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    if (keyCode.length === 1) w.webContents.sendInputEvent({ type: 'char', keyCode, modifiers });
    w.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await wait(25);
  }
  await wait(120);
};

// helpers that run inside the note
const HELPERS = `
window.__ed = document.getElementById('editor');
window.__sc = document.getElementById('body');
window.__setHTML = (h) => { __ed.innerHTML = h; __ed.dispatchEvent(new Event('input')); };
// put the caret on line n (1-based), at column c (or end of line)
window.__caretAt = (n, c) => {
  const w = document.createTreeWalker(__ed, NodeFilter.SHOW_ALL);
  let line = 1, node, target = null;
  const nodes = [];
  while ((node = w.nextNode())) nodes.push(node);
  for (const nd of nodes) {
    if (nd.nodeName === 'BR' || nd.nodeName === 'HR') { line++; continue; }
    if (nd.nodeType === 3 && line === n && nd.data.length) { target = nd; break; }
  }
  const s = getSelection(), r = document.createRange();
  if (target) { r.setStart(target, c == null ? target.data.length : Math.min(c, target.data.length)); }
  else { // empty line: just before the n-th br
    let seen = 1; for (const nd of nodes) { if (nd.nodeName === 'BR') { if (seen === n) { r.setStartBefore(nd); break; } seen++; } }
  }
  r.collapse(true); s.removeAllRanges(); s.addRange(r); __ed.focus();
};
// Exact caret position: drop a temporary marker at the caret, measure, remove it.
window.__caretVisible = () => {
  const s = getSelection(); const n = s.focusNode, o = s.focusOffset;
  const r = document.createRange(); r.setStart(n, o); r.collapse(true);
  const m = document.createElement('span'); m.textContent = '\\u200B';
  r.insertNode(m);
  const rc = m.getBoundingClientRect();
  const parent = m.parentNode; m.remove(); parent.normalize();
  const b = __sc.getBoundingClientRect();
  return rc.height > 0 && rc.top >= b.top - 2 && rc.bottom <= b.bottom + 2;
};
0`;

const lines = (n, word = 'line') => Array.from({ length: n }, (_, i) => `${word} ${i + 1}`);

async function scenario(w, name, html, setup, keys, expect) {
  await js(w, `__setHTML(${JSON.stringify(html)}); __sc.scrollTop = 0; 0`);
  await wait(100);
  await js(w, setup);
  await wait(150);
  const before = await js(w, `__sc.scrollTop`);
  for (const k of keys) await key(w, ...k);
  await wait(200);
  const after = await js(w, `__sc.scrollTop`);
  const vis = await js(w, `__caretVisible()`);
  const ok = vis && expect(before, after);
  check(name, ok, `scrollTop ${before} -> ${after}, caret visible=${vis}`);
  if (!ok) L('   caret at:', await js(w, `(() => { const s = getSelection(); const n = s.focusNode; const o = s.focusOffset;
    const r = document.createRange(); r.setStart(n, o); r.collapse(true); const rc = r.getClientRects()[0];
    const kid = n.childNodes ? [n.childNodes[o-1], n.childNodes[o]].map(k => k ? k.nodeName + (k.getBoundingClientRect ? ':' + Math.round(k.getBoundingClientRect().top) + '/' + Math.round(k.getBoundingClientRect().height) : '') : '-') : [];
    return { node: n.nodeName, o, rect: rc ? [Math.round(rc.top), Math.round(rc.height)] : null, around: kid, html: __ed.innerHTML.slice(0, 80), box: Math.round(__sc.getBoundingClientRect().top) + '/' + Math.round(__sc.getBoundingClientRect().bottom) };
  })()`));
  if (!ok) fs.writeFileSync(path.join(out, name.replace(/\W+/g, '_') + '.png'), (await w.webContents.capturePage()).toPNG());
}

app.whenReady().then(async () => {
  await wait(1500);
  const [w] = BrowserWindow.getAllWindows();
  w.focus();
  await js(w, HELPERS);
  const flat = lines(40).join('<br>');
  const lh = await js(w, `parseFloat(getComputedStyle(__ed).lineHeight)`);
  const small = (b, a) => Math.abs(a - b) <= lh * 1.5;

  try {
    for (const theme of ['ghost', 'green', 'amber']) {
      await js(w, `window.notr.setSettings({ theme: '${theme}' })`);
      await wait(300);
      L(`-- theme ${theme}`);
      await scenario(w, `${theme}: enter at end of line 3 stays at top`, flat, `__caretAt(3)`, [['Return', [], 3]], (b, a) => a === 0);
      await scenario(w, `${theme}: enter mid-line 5 stays at top`, flat, `__caretAt(5, 3)`, [['Return']], (b, a) => a === 0);
      await scenario(w, `${theme}: enter on empty line 4 stays at top`, lines(3).join('<br>') + '<br><br>' + lines(36, 'more').join('<br>'), `__caretAt(4)`, [['Return', [], 2]], (b, a) => a === 0);
      await scenario(w, `${theme}: enter inside bold text stays at top`, '<b>' + flat + '</b>', `__caretAt(3)`, [['Return', [], 2]], (b, a) => a === 0);
      await scenario(w, `${theme}: enter inside one big span stays at top`, '<span style="font-size: 14px;">' + flat + '</span>', `__caretAt(2)`, [['Return', [], 2]], (b, a) => a === 0);
      await scenario(w, `${theme}: enter at start of line 1 stays at top`, flat, `__caretAt(1, 0)`, [['Return']], (b, a) => a === 0);
      await scenario(w, `${theme}: enter in the middle only moves a little`, flat, `__caretAt(20); __sc.scrollTop = __ed.scrollHeight / 2 - __sc.clientHeight / 2; 0`, [['Return']], small);
      await scenario(w, `${theme}: typing at the bottom follows`, flat, `__caretAt(40)`, [['Return', [], 6], ['X']], (b, a) => a > b);
      await scenario(w, `${theme}: arrow up from bottom returns to top`, flat, `__caretAt(40); __sc.scrollTop = __sc.scrollHeight; 0`, [['Up', [], 45]], (b, a) => a === 0);
      await scenario(w, `${theme}: ctrl+end then ctrl+home`, flat, `__caretAt(1)`, [['End', ['control']], ['Home', ['control']]], (b, a) => a === 0);
      await scenario(w, `${theme}: page down shows caret`, flat, `__caretAt(1)`, [['PageDown']], (b, a) => a > 0);
      await scenario(w, `${theme}: backspace near top stays at top`, flat, `__caretAt(4)`, [['Backspace', [], 3]], (b, a) => a === 0);
      const withHr = lines(2).join('<br>') + '<hr>' + lines(38, 'after').join('<br>');
      await scenario(w, `${theme}: enter just after a separator stays at top`, withHr, `(() => { const hr = __ed.querySelector('hr'); const r = document.createRange(); r.setStartAfter(hr); r.collapse(true); const s = getSelection(); s.removeAllRanges(); s.addRange(r); __ed.focus(); })()`, [['Return', [], 2]], (b, a) => a === 0);
      await scenario(w, `${theme}: enter at end of line above a separator stays at top`, withHr, `__caretAt(2)`, [['Return', [], 2]], (b, a) => a === 0);
    }
  } catch (err) {
    failures++;
    L('ERROR', err.stack || String(err));
  }
  L(failures ? `${failures} FAILED` : 'ALL PASSED');
  app.exit(failures ? 1 : 0);
});
