'use strict';
// Shared by every page: the tool list, download links that point at the
// latest GitHub release, and the quiet fade-up as sections scroll in.
(() => {
  document.documentElement.classList.add('js');

  const REPO = 'T-Julsgaard/Utilr';
  const RELEASES = `https://github.com/${REPO}/releases/latest`;

  // The tools, in the order utilr lists them (tool.json "order", then name).
  // Glyphs are each tool's glyph.svg (24×24, currentColor).
  const TOOLS = [
    { id: 'notr', desc: 'tiny notes that stay on top', key: 'ctrl+n',
      glyph: '<path d="M3 15.5h10.5v2H3zM15.5 7.5h4v10h-4z" fill="currentColor"/>' },
    { id: 'snipr', desc: "press, drag, it's on your clipboard", key: 'alt+shift+s',
      glyph: '<path d="M3.5 4.5h8v2h-6v6h-2zM20.5 19.5h-8v-2h6v-6h2z" fill="currentColor"/>' },
    { id: 'clipr', desc: 'everything you copied today', key: 'alt+shift+v',
      glyph: '<path d="M4 5h3v2H6v12h12V7h-1V5h3v16H4zM8 3h8v5H8zM9 12h6v2H9z" fill="currentColor"/>' },
    { id: 'measr', desc: 'point at it, know its size in px', key: 'alt+shift+m',
      glyph: '<path d="M3 6.5h2v11H3zM19 6.5h2v11h-2zM5 11h14v2H5z" fill="currentColor"/>' },
    { id: 'paletr', desc: 'click any pixel, copy its color', key: 'alt+shift+p',
      glyph: '<path fill-rule="evenodd" d="M3.5 3.5h17v17h-17zM5.5 5.5v13h13v-13zM9.5 9.5h5v5h-5z" fill="currentColor"/>' },
    { id: 'findr', desc: 'every file on every drive, at once', key: 'alt+shift+d', win: true,
      glyph: '<path d="M3 3h12v12H3zM5 5v8h8V5zM14 16l2-2 6 6-2 2z" fill="currentColor" fill-rule="evenodd"/>' },
  ];
  const svg = (t, size = 24) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true">${t.glyph}</svg>`;
  const keyHtml = (combo) => combo.split('+').map((k) => `<kbd>${k}</kbd>`).join('<span class="plus">+</span>');
  window.Utilr = { TOOLS, svg, keyHtml, find: (id) => TOOLS.find((t) => t.id === id) };

  // [data-glyph="snipr"] → that tool's mark
  document.querySelectorAll('[data-glyph]').forEach((el) => {
    const t = TOOLS.find((x) => x.id === el.dataset.glyph);
    if (t) el.innerHTML = svg(t, Number(el.dataset.size) || 24);
  });
  // [data-keys="alt+shift+s"] → <kbd>alt</kbd>+<kbd>shift</kbd>+<kbd>s</kbd>
  document.querySelectorAll('[data-keys]').forEach((el) => { el.innerHTML = keyHtml(el.dataset.keys); });

  // ---------------------------------------------------------------------------
  // downloads: the right file for this computer, from the latest release
  // ---------------------------------------------------------------------------
  const ua = navigator.userAgent;
  const platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
  const os = /win/i.test(platform) || /Windows/.test(ua) ? 'windows'
    : /mac/i.test(platform) || /Mac OS X/.test(ua) ? 'mac'
    : /linux|x11/i.test(platform + ua) && !/Android/.test(ua) ? 'linux'
    : null;
  const NAMES = { windows: 'windows', mac: 'macos', linux: 'linux' };
  const EXT = { windows: 'exe', mac: 'dmg', linux: 'AppImage' };

  const card = os && document.querySelector(`.platform[data-os="${os}"]`);
  if (card) card.classList.add('mine');
  document.querySelectorAll('[data-dl-main]').forEach((a) => {
    if (os && os !== 'windows') {
      const label = a.querySelector('.os');
      if (label) label.textContent = 'for ' + NAMES[os];
    }
  });

  // every download link falls back to the release page until we know the files
  document.querySelectorAll('a[data-asset], [data-dl-main]').forEach((a) => { a.href = RELEASES; });

  fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } })
    .then((r) => (r.ok ? r.json() : null))
    .then((rel) => {
      if (!rel || !Array.isArray(rel.assets)) return;
      const url = (ext) => {
        const a = rel.assets.find((x) => x.name.endsWith('.' + ext));
        return a ? a.browser_download_url : rel.html_url;
      };
      document.querySelectorAll('a[data-asset]').forEach((a) => { a.href = url(a.dataset.asset); });
      document.querySelectorAll('[data-dl-main]').forEach((a) => { a.href = url(EXT[os] || 'exe'); });
      const v = String(rel.tag_name || '').replace(/^v/, '');
      if (v) document.querySelectorAll('[data-version]').forEach((el) => { el.textContent = 'v' + v; });
    })
    .catch(() => {});

  // ---------------------------------------------------------------------------
  // sections fade up once as they come into view
  // ---------------------------------------------------------------------------
  const rise = document.querySelectorAll('.rise');
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add('in');
        io.unobserve(e.target);
      }
    }, { rootMargin: '0px 0px -8% 0px' });
    rise.forEach((el) => io.observe(el));
  } else {
    rise.forEach((el) => el.classList.add('in'));
  }
})();
