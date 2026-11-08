'use strict';
// Draws the macOS / Linux icons from the logo in src/assets/notr-256.png.
//   npx electron scripts/icons.js
// Writes build/icon.png (1024px, macOS icon grid: 824px tile with margin)
// and src/assets/trayTemplate.png + @2x (black mark for the macOS menu bar).
// The logo is plain geometry (rounded tile, underscore, block caret), so it is
// measured from the 256px PNG and redrawn crisply at any size.

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, nativeImage } = require('electron');

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

const root = path.join(__dirname, '..');

function measure() {
  const img = nativeImage.createFromPath(path.join(root, 'src', 'assets', 'notr-256.png'));
  const { width: W, height: H } = img.getSize();
  const px = img.toBitmap(); // BGRA
  const at = (x, y) => { const i = (y * W + x) * 4; return { b: px[i], g: px[i + 1], r: px[i + 2], a: px[i + 3] }; };
  // bright pixels = the mark; split into the underscore (left) and the caret (right)
  const marks = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = at(x, y);
      if (p.a > 200 && p.r > 128) marks.push([x, y]);
    }
  }
  const xs = [...new Set(marks.map((m) => m[0]))].sort((a, b) => a - b);
  let split = xs[0];
  for (let i = 1; i < xs.length; i++) if (xs[i] - xs[i - 1] > 1) { split = xs[i]; break; }
  const box = (pts) => ({
    x: Math.min(...pts.map((p) => p[0])), y: Math.min(...pts.map((p) => p[1])),
    r: Math.max(...pts.map((p) => p[0])) + 1, b: Math.max(...pts.map((p) => p[1])) + 1,
  });
  const under = box(marks.filter((m) => m[0] < split));
  const caret = box(marks.filter((m) => m[0] >= split));
  let radius = 0;
  while (radius < W / 2 && at(radius, 0).a < 128) radius++;
  const bg = at(W / 2, 20), fg = at(Math.round((caret.x + caret.r) / 2), Math.round((caret.y + caret.b) / 2));
  return { W, under, caret, radius, bg: `rgb(${bg.r},${bg.g},${bg.b})`, fg: `rgb(${fg.r},${fg.g},${fg.b})` };
}

async function draw(win, geo, opts) {
  return win.webContents.executeJavaScript(`(() => {
    const g = ${JSON.stringify(geo)}, o = ${JSON.stringify(opts)};
    const c = document.createElement('canvas'); c.width = c.height = o.size;
    const x = c.getContext('2d');
    const s = o.tile / g.W, off = (o.size - o.tile) / 2;
    const R = (b) => [off + b.x * s, off + b.y * s, (b.r - b.x) * s, (b.b - b.y) * s];
    if (o.tileColor) {
      if (o.shadow) { x.shadowColor = 'rgba(0,0,0,.35)'; x.shadowBlur = o.size * .02; x.shadowOffsetY = o.size * .01; }
      x.fillStyle = o.tileColor;
      x.beginPath(); x.roundRect(off, off, o.tile, o.tile, g.radius * s); x.fill();
      x.shadowColor = 'transparent';
    }
    x.fillStyle = o.markColor;
    x.fillRect(...R(g.under)); x.fillRect(...R(g.caret));
    return c.toDataURL('image/png');
  })()`);
}

const save = (file, dataUrl) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
};

app.whenReady().then(async () => {
  try {
    const geo = measure();
    console.log('logo:', JSON.stringify(geo));
    const win = new BrowserWindow({ show: false });
    await win.loadURL('data:text/html,<body></body>');
    save(path.join(root, 'build', 'icon.png'),
      await draw(win, geo, { size: 1024, tile: 824, tileColor: geo.bg, markColor: geo.fg, shadow: true }));
    // menu bar: just the mark, black on transparent, a bit larger than the tile would be
    save(path.join(root, 'src', 'assets', 'trayTemplate.png'),
      await draw(win, geo, { size: 16, tile: 22, markColor: '#000' }));
    save(path.join(root, 'src', 'assets', 'trayTemplate@2x.png'),
      await draw(win, geo, { size: 32, tile: 44, markColor: '#000' }));
    console.log('icons written');
    app.exit(0);
  } catch (err) {
    console.error(err);
    app.exit(1);
  }
});
