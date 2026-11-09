'use strict';
// Builds the app's icons from the logo kit in assets/logo (the source of truth).
//   npm run icons        (= electron scripts/icons.js)
//
//   src/assets/snipr.ico           the kit's .ico (window, taskbar, exe, tray, installer)
//   src/assets/snipr-256.png       the kit's 256 px app icon (Linux window icon)
//   build/icon.png                 1024 px, the app icon on the macOS icon grid
//   src/assets/trayTemplate(@2x)   the small black mark for the macOS menu bar

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

const root = path.join(__dirname, '..');
const logo = path.join(root, 'assets', 'logo');

const svg = (name) => 'data:image/svg+xml;base64,' + fs.readFileSync(path.join(logo, 'svg', name)).toString('base64');

async function render(win, src, opts) {
  return win.webContents.executeJavaScript(`(async () => {
    const o = ${JSON.stringify(opts)};
    const img = new Image();
    img.src = ${JSON.stringify(src)};
    await img.decode();
    const c = document.createElement('canvas'); c.width = c.height = o.size;
    const x = c.getContext('2d');
    const off = (o.size - o.draw) / 2;
    if (o.shadow) { x.shadowColor = 'rgba(0,0,0,.35)'; x.shadowBlur = o.size * .02; x.shadowOffsetY = o.size * .01; }
    x.drawImage(img, off, off, o.draw, o.draw);
    return c.toDataURL('image/png');
  })()`);
}

const save = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); };
const png = (dataUrl) => Buffer.from(dataUrl.split(',')[1], 'base64');

app.whenReady().then(async () => {
  try {
    fs.copyFileSync(path.join(logo, 'snipr.ico'), path.join(root, 'src', 'assets', 'snipr.ico'));
    fs.copyFileSync(path.join(logo, 'png', 'snipr-app-icon-256.png'), path.join(root, 'src', 'assets', 'snipr-256.png'));

    const win = new BrowserWindow({ show: false });
    await win.loadURL('data:text/html,<body></body>');
    save(path.join(root, 'build', 'icon.png'), png(await render(win, svg('snipr-app-icon.svg'), { size: 1024, draw: 824, shadow: true })));
    save(path.join(root, 'src', 'assets', 'trayTemplate.png'), png(await render(win, svg('snipr-mark-small-black.svg'), { size: 16, draw: 16 })));
    save(path.join(root, 'src', 'assets', 'trayTemplate@2x.png'), png(await render(win, svg('snipr-mark-small-black.svg'), { size: 32, draw: 32 })));
    console.log('icons written');
    app.exit(0);
  } catch (err) {
    console.error(err);
    app.exit(1);
  }
});
