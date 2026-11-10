// The fonts you can write with on a snip: notr's font list, in notr's order.
// The first six are bundled (fonts.css, theme/fonts.css); the rest are system fonts.
// Shared by the main process (require) and the windows (<script>).
(function (root) {
  'use strict';
  const FONTS = [
    'JetBrains Mono', 'IBM Plex Mono', 'DM Mono', 'Martian Mono', 'Space Mono', 'VT323',
    'Cascadia Mono', 'Consolas', 'Segoe UI', 'Georgia', 'Arial',
  ];
  const DEFAULT = 'DM Mono';
  const api = { FONTS, DEFAULT };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SniprFonts = api;
})(typeof self !== 'undefined' ? self : this);
