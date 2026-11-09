/* Demo wiring for preview.html only — not part of the theme. */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const menu = $('menu'), gear = $('btn-settings'), confirm = $('confirm');

  if (new URLSearchParams(location.search).has('pin')) {
    document.body.classList.add('hover');
    document.documentElement.addEventListener('mouseleave', () => document.body.classList.add('hover'));
  }

  function setMenu(open) {
    menu.hidden = !open;
    gear.setAttribute('aria-expanded', String(open));
    Ghost.menuOpen(open);
    if (open) {
      // like Notr: just under the bar, right-aligned with a 6px gap
      const top = document.querySelector('.bar').getBoundingClientRect().bottom + 2;
      menu.style.top = top + 'px';
      menu.style.left = Math.max(6, innerWidth - menu.offsetWidth - 6) + 'px';
      menu.style.maxHeight = Math.max(60, innerHeight - top - 6) + 'px';
    }
  }

  gear.addEventListener('click', () => setMenu(menu.hidden));
  document.addEventListener('mousedown', (e) => {
    if (!menu.hidden && !menu.contains(e.target) && !gear.contains(e.target)) setMenu(false);
  });
  menu.addEventListener('mousedown', (e) => e.preventDefault());
  $('btn-close').addEventListener('click', () => { setMenu(false); confirm.hidden = false; });
  $('yes').addEventListener('click', () => { confirm.hidden = true; });
  $('no').addEventListener('click', () => { confirm.hidden = true; });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { setMenu(false); confirm.hidden = true; }
  });
})();
