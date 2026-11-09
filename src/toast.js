'use strict';

// The corner notice: "copied  1280 × 720". Rises 6px in, like notr's confirm strip.
(() => {
  const api = window.snipr;
  const el = document.getElementById('toast');
  api.onToast(({ text, detail }) => {
    document.getElementById('text').textContent = text;
    document.getElementById('detail').textContent = detail || '';
    el.classList.remove('on');
    void el.offsetWidth;
    el.classList.add('on');
  });
  api.onToastHide(() => el.classList.remove('on'));
})();
