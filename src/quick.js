// The quick view: a narrow column of pinned tools.
//   1–8         open that tool
//   ↑ ↓ / tab   move           enter / space   open
//   esc         close          (it also closes when you click elsewhere)
(() => {
  'use strict';

  const api = window.utilr;
  const Dock = window.UtilrDock;
  const dock = document.getElementById('dock');
  const label = document.getElementById('label');

  let st = null;
  let sel = 0;
  let count = 0;   // tiles (just a "pin a tool" one when nothing is pinned)

  function render() {
    if (!st) return;
    dock.innerHTML = Dock.html(st);
    count = dock.children.length;
    select(Math.min(sel, count - 1));
  }

  function select(i) {
    if (!count) return;
    sel = (i + count) % count;
    for (const el of dock.children) el.classList.toggle('sel', +el.dataset.i === sel);
    label.textContent = Dock.label(st, sel);
  }

  function launch(i) {
    const t = Dock.items(st)[i];
    if (t) api.open(t.id);
    else api.openLauncher('quick');
  }

  api.onState((s) => { st = s; render(); });

  // every time it opens: first tile, and the tiles fall in again
  api.onShow(() => {
    sel = 0;
    render();
    dock.classList.remove('in');
    void dock.offsetWidth;
    dock.classList.add('in');
  });

  dock.addEventListener('mousemove', (e) => {
    const t = e.target.closest('.qt');
    if (t && +t.dataset.i !== sel) select(+t.dataset.i);
  });
  dock.addEventListener('click', (e) => {
    const t = e.target.closest('.qt');
    if (t) launch(+t.dataset.i);
  });

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const d = /^Digit([1-9])$/.exec(e.code) || /^Numpad([1-9])$/.exec(e.code);
    if (d) {
      const i = +d[1] - 1;
      if (i < Dock.items(st).length) { e.preventDefault(); select(i); launch(i); }
      return;
    }
    switch (e.key) {
      case 'ArrowDown': case 'ArrowRight': e.preventDefault(); select(sel + 1); break;
      case 'ArrowUp': case 'ArrowLeft': e.preventDefault(); select(sel - 1); break;
      case 'Tab': e.preventDefault(); select(sel + (e.shiftKey ? -1 : 1)); break;
      case 'Home': e.preventDefault(); select(0); break;
      case 'End': e.preventDefault(); select(count - 1); break;
      case 'Enter': case ' ': e.preventDefault(); launch(sel); break;
      case 'Escape': e.preventDefault(); api.hideQuick(); break;
      default:
    }
  });

  api.state().then((s) => { st = s; render(); });
})();
