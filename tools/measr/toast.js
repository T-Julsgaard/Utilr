'use strict';

// The corner notice: "copied  240 × 48". Rises 6px in, like notr's confirm strip.
(() => {
  const api = window.measr;
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
