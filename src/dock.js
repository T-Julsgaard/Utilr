// The column of tiles, drawn the same way in the quick view window and in its
// preview on the launcher's "quick view" page.
(function (root) {
  'use strict';

  const PLUS = '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M12 6v12M6 12h12" stroke="currentColor" stroke-width="1.4" fill="none"/></svg>';

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  // the pinned tools, in order, that are actually there
  const items = (st) => st.pinned.map((id) => st.tools.find((t) => t.id === id && t.running)).filter(Boolean);

  // Tool glyphs are the tools' own SVG files, read by utilr from tools/<id>.
  function html(st) {
    const list = items(st);
    const tiles = list.map((t, i) =>
      `<button class="qt" data-i="${i}" style="--i:${i}" role="option" aria-label="${esc(t.name)}" tabindex="-1">` +
      `<span class="n">${i + 1}</span>${t.glyph}</button>`);
    if (list.length < st.maxPinned) {
      tiles.push(`<button class="qt add" data-i="${list.length}" style="--i:${list.length}" role="option" aria-label="pin a tool" tabindex="-1">${PLUS}</button>`);
    }
    return tiles.join('');
  }

  // what the label under the column says for tile i
  function label(st, i) {
    const list = items(st);
    if (list[i]) return list[i].name;
    return st.tools.some((t) => t.installed) ? 'pin a tool' : 'install a tool';
  }

  root.UtilrDock = { items, html, label, esc };
})(typeof self !== 'undefined' ? self : this);
