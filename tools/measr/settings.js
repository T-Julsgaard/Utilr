'use strict';

// The settings window: measr's menu, standing on its own (tray → settings).
(async () => {
  const api = window.measr;
  const Keys = window.MeasrKeys;
  const $ = (id) => document.getElementById(id);
  const menu = window.MeasrMenu.create({ el: $('menu'), api, withKey: true });

  function show(s) {
    menu.set(s);
    $('st-left').textContent = 'measure  ' + Keys.label(s.key);
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
