/* ghost — body state classes, same behaviour as Notr src/note.js ("window focus / hover").
   Plain script (no modules) so it runs under a strict CSP: script-src 'self'.

     .ghost      always on: opts the page into the theme
     .hover      pointer inside the window   (mouseenter / mouseleave on <html>)
     .focused    window has focus            (window focus / blur)
     .menu-open  call Ghost.menuOpen(true|false) when you show / hide a menu
*/
(() => {
  'use strict';
  const body = document.body;
  body.classList.add('ghost');

  const root = document.documentElement;
  root.addEventListener('mouseenter', () => body.classList.add('hover'));
  root.addEventListener('mouseleave', () => body.classList.remove('hover'));
  window.addEventListener('focus', () => body.classList.add('focused'));
  window.addEventListener('blur', () => body.classList.remove('focused'));
  if (document.hasFocus()) body.classList.add('focused');

  window.Ghost = {
    menuOpen(open) { body.classList.toggle('menu-open', !!open); },
  };
})();
