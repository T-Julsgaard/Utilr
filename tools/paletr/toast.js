'use strict';

// The corner notice: "■ #1e90ff   copied". Rises 6px in, like snipr's.
(() => {
  const api = window.paletr;
  const $ = (id) => document.getElementById(id);
  const el = $('toast');
  api.onToast(({ text, detail, swatch }) => {
    $('text').textContent = text;
    $('detail').textContent = detail || '';
    $('chip').hidden = !swatch;
    if (swatch) $('chip').style.background = swatch;
    el.classList.remove('on');
    void el.offsetWidth;
    el.classList.add('on');
  });
  api.onToastHide(() => el.classList.remove('on'));
})();
