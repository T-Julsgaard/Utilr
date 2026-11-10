'use strict';
// Builds utilr's icons from the logo kit in assets/logo (the source of truth).
// Same pipeline as snipr's scripts/icons.js.
//   npm run icons        (= electron scripts/icons.js)
//
//   src/assets/utilr.ico           window, taskbar, exe, tray, installer: drawn from the kit's
//                                  SVGs (the chunky "-small" mark below 32 px, as the kit says),
//                                  16–48 px as plain bitmaps and 256 px as PNG. The kit's own
//                                  .ico stores every size as PNG, which GDI can't read at small
//                                  sizes (tray, start menu lists), so Windows kept old icons.
//   src/assets/utilr-256.png       256 px app icon (Linux window icon)
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

// raw RGBA pixels of an SVG drawn at size x size
async function pixels(win, src, size) {
  return win.webContents.executeJavaScript(`(async () => {
    const img = new Image();
    img.src = ${JSON.stringify(src)};
    await img.decode();
    const c = document.createElement('canvas'); c.width = c.height = ${size};
    const x = c.getContext('2d');
    x.drawImage(img, 0, 0, ${size}, ${size});
    return Array.from(x.getImageData(0, 0, ${size}, ${size}).data);
  })()`);
}

// one .ico frame as a classic 32-bit DIB: BITMAPINFOHEADER, BGRA rows bottom-up, empty AND mask
function dib(rgba, size) {
  const maskRow = Math.ceil(size / 32) * 4;
  const head = Buffer.alloc(40);
  head.writeUInt32LE(40, 0);
  head.writeInt32LE(size, 4);
  head.writeInt32LE(size * 2, 8); // xor + and masks
  head.writeUInt16LE(1, 12);
  head.writeUInt16LE(32, 14);
  head.writeUInt32LE(0, 16);
  head.writeUInt32LE(size * size * 4 + maskRow * size, 20);
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const s = (y * size + x) * 4, d = ((size - 1 - y) * size + x) * 4;
      px[d] = rgba[s + 2]; px[d + 1] = rgba[s + 1]; px[d + 2] = rgba[s]; px[d + 3] = rgba[s + 3];
    }
  }
  return Buffer.concat([head, px, Buffer.alloc(maskRow * size)]);
}

function ico(frames) {
  const head = Buffer.alloc(6 + 16 * frames.length);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(frames.length, 4);
  let offset = head.length;
  frames.forEach(({ size, data }, i) => {
    const e = 6 + i * 16;
    head.writeUInt8(size >= 256 ? 0 : size, e);
    head.writeUInt8(size >= 256 ? 0 : size, e + 1);
    head.writeUInt16LE(1, e + 4);
    head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(data.length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...frames.map((f) => f.data)]);
}

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
    const win = new BrowserWindow({ show: false });
    await win.loadURL('data:text/html,<body></body>');

    const frames = [];
    for (const size of [16, 20, 24, 32, 40, 48, 64, 128]) {
      const src = svg(size < 32 ? 'utilr-app-icon-small.svg' : 'utilr-app-icon.svg');
      frames.push({ size, data: dib(await pixels(win, src, size), size) });
    }
    const big = png(await render(win, svg('utilr-app-icon.svg'), { size: 256, draw: 256 }));
    save(path.join(root, 'src', 'assets', 'utilr-256.png'), big);
    frames.push({ size: 256, data: big });
    save(path.join(root, 'src', 'assets', 'utilr.ico'), ico(frames));
    save(path.join(root, 'build', 'icon.png'), png(await render(win, svg('utilr-app-icon.svg'), { size: 1024, draw: 824, shadow: true })));
    save(path.join(root, 'src', 'assets', 'trayTemplate.png'), png(await render(win, svg('utilr-mark-small-black.svg'), { size: 16, draw: 16 })));
    save(path.join(root, 'src', 'assets', 'trayTemplate@2x.png'), png(await render(win, svg('utilr-mark-small-black.svg'), { size: 32, draw: 32 })));
    console.log('icons written');
    app.exit(0);
  } catch (err) {
    console.error(err);
    app.exit(1);
  }
});
