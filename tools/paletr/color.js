// A color as text, in the three ways paletr copies it. Shared by the main
// process (require) and the windows (<script>), so what you see is what's copied.
//   hex  #1e90ff        rgb  rgb(30, 144, 255)        hsl  hsl(210, 100%, 56%)
(function (root) {
  'use strict';

  const FORMATS = ['hex', 'rgb', 'hsl'];

  const h2 = (n) => n.toString(16).padStart(2, '0');
  const hex = ({ r, g, b }) => '#' + h2(r) + h2(g) + h2(b);

  // "#1e90ff" -> { r, g, b }, or null
  function parse(s) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(s || '').trim());
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  function hsl({ r, g, b }) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    let h = 0, s = 0;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
    }
    return { h: Math.round(h) % 360, s: Math.round(s * 100), l: Math.round(l * 100) };
  }

  // the text that goes on the clipboard
  function format(c, fmt) {
    if (typeof c === 'string') c = parse(c);
    if (!c) return '';
    if (fmt === 'rgb') return `rgb(${c.r}, ${c.g}, ${c.b})`;
    if (fmt === 'hsl') { const x = hsl(c); return `hsl(${x.h}, ${x.s}%, ${x.l}%)`; }
    return hex(c);
  }

  // perceived lightness 0..1, to keep marks readable on any color
  const light = ({ r, g, b }) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

  const api = { FORMATS, hex, parse, hsl, format, light };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PaletrColor = api;
})(typeof self !== 'undefined' ? self : this);
