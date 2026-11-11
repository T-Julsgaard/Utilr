'use strict';
// Browser stand-in for Electron's preload.js, used by the GitHub Pages demo.
// Each note runs in an <iframe>; every call goes to the desk on the parent
// page (docs/notr/desk.js), which plays the part of notr's main process.
(() => {
  let frame = null, desk = null;
  try {
    frame = window.frameElement;
    desk = frame && window.parent.notrDesk;
  } catch (_) { /* not inside the demo page */ }
  if (!desk) return; // opened on its own: note.js falls back to its preview stub

  const id = frame.dataset.id;

  window.notr = {
    init: () => Promise.resolve(desk.init(id)),
    update: (patch) => desk.update(id, patch),
    newNote: () => desk.newNote(id),
    closeNote: () => desk.closeNote(id),
    save: () => desk.saveNote(id),
    openSaved: (other) => desk.openSaved(other, id),
    cycle: () => {},
    setSettings: (patch) => desk.setSettings(patch),
    edit: (cmd) => desk.edit(window, cmd),
    kbdStart: (mode, dir) => desk.kbdStart(id, mode, dir),
    kbdStop: (dir) => desk.kbdStop(id, dir),
    quit: () => {},
    onSettings: (cb) => desk.onSettings(id, cb),
    onFocusEditor: (cb) => desk.onFocusEditor(id, cb),
    onTabs: (cb) => desk.onTabs(id, cb),
  };

  // No keyboard shortcuts in the demo: they'd fight the browser's own keys
  // (ctrl+arrows jump words, ctrl+s saves the page...). The keys simply do
  // what they normally do on a web page.
  window.addEventListener('keydown', (e) => {
    const Keys = window.NotrKeys;
    const combo = Keys && Keys.fromEvent(e);
    const sc = desk.shortcuts();
    const arrowMove = /^Arrow/.test(e.key) && (e.ctrlKey || e.altKey);
    if (e.key === 'Tab' || arrowMove || (combo && (combo === sc.add || combo === sc.del))) {
      e.stopImmediatePropagation(); // note.js never sees it
    }
  }, true);

  // the note you click comes to the front, like windows do
  window.addEventListener('focus', () => desk.raise(id));
  document.addEventListener('pointerdown', () => desk.raise(id), true);

  // drag the title bar to move the note (Electron does this natively)
  document.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !(e.target instanceof Element)) return;
    if (!e.target.closest('.bar') || e.target.closest('button')) return;
    e.preventDefault();
    desk.dragStart(id, 'move', e.screenX, e.screenY);
  });
  // while dragging, the pointer may stay over this frame: pass moves on
  document.addEventListener('pointermove', (e) => desk.dragMove(e.screenX, e.screenY));
  document.addEventListener('pointerup', () => desk.dragEnd());
  document.addEventListener('pointercancel', () => desk.dragEnd());
})();
