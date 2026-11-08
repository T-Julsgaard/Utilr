'use strict';
// Download links: point at the files of the latest GitHub release, and make
// the big button in the hero download the right one for this computer.
(() => {
  const ua = navigator.userAgent;
  const platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
  const os = /win/i.test(platform) || /Windows/.test(ua) ? 'windows'
    : /mac/i.test(platform) || /Mac OS X/.test(ua) ? 'mac'
    : /linux|x11/i.test(platform + ua) && !/Android/.test(ua) ? 'linux'
    : null;
  const NAMES = { windows: 'windows', mac: 'macos', linux: 'linux' };

  const hero = document.getElementById('hero-dl');
  const card = os && document.querySelector(`.platform[data-os="${os}"]`);
  if (card) {
    card.classList.add('mine');
    hero.querySelector('span').textContent = 'download for ' + NAMES[os];
    hero.href = card.querySelector('a[data-asset]').href;
  }

  // newest release's real file names (falls back to the links in the page)
  fetch('https://api.github.com/repos/T-Julsgaard/Notr/releases/latest', { headers: { Accept: 'application/vnd.github+json' } })
    .then((r) => (r.ok ? r.json() : null))
    .then((rel) => {
      if (!rel || !Array.isArray(rel.assets)) return;
      document.querySelectorAll('a[data-asset]').forEach((a) => {
        const ext = '.' + a.dataset.asset;
        const asset = rel.assets.find((x) => x.name.endsWith(ext));
        if (asset) a.href = asset.browser_download_url;
        else if (a.classList.contains('button')) a.href = rel.html_url; // not built for this release
      });
      if (card) hero.href = card.querySelector('a[data-asset]').href;
    })
    .catch(() => {});
})();
