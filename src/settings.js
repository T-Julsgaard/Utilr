'use strict';

// The settings window: snipr's menu, standing on its own (tray → settings).
(async () => {
  const api = window.snipr;
  const Keys = window.SniprKeys;
  const $ = (id) => document.getElementById(id);
  const menu = window.SniprMenu.create({ el: $('menu'), api, inline: true, onClose: () => api.closeWindow() });

  function show(s) {
    menu.set(s);
    $('st-left').textContent = 'snip  ' + Keys.label(s.key);
    $('st-right').textContent = 'v' + s.version;
  }

  show(await api.settings());
  api.onSettings(show);

  $('btn-close').addEventListener('click', () => api.closeWindow());
  document.addEventListener('keydown', (e) => {
    if (menu.handleKey(e)) return;
    if (e.key === 'Escape' || ((e.ctrlKey || e.metaKey) && e.code === 'KeyW')) { e.preventDefault(); api.closeWindow(); }
  });
})();
