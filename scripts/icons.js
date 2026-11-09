'use strict';
// Draws every snipr icon from one piece of geometry.
//   npm run icons        (= electron scripts/icons.js)
// The mark sits in notr's family: a black rounded tile with a light, blocky
// mark. notr has an underscore and a block caret; snipr has two crop corners
// around a block caret, i.e. a selection being made.
//
// Writes src/assets/snipr-256.png, src/assets/snipr.ico (16–256 px),
// build/icon.png (1024 px, macOS icon grid) and src/assets/trayTemplate(@2x).png.

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

const root = path.join(__dirname, '..');
const TILE = '#000000';
const MARK = '#f0f0f0';

// geometry on a 256 grid
const G = {
  radius: 56,
  t: 16,                          // stroke thickness of the corners
  tl: { x: 52, y: 56, arm: 70 },  // top-left corner (outer corner point)
  br: { x: 204, y: 200, arm: 70 },// bottom-right corner (outer corner point)
  caret: { x: 116, y: 96, w: 24, h: 64 }, // notr's block caret, in the middle of the selection
};

async function draw(win, opts) {
  return win.webContents.executeJavaScript(`(() => {
    const G = ${JSON.stringify(G)}, o = ${JSON.stringify(opts)};
    const c = document.createElement('canvas'); c.width = c.height = o.size;
    const x = c.getContext('2d');
    const off = (o.size - o.tile) / 2, s = o.tile / 256;
    const P = (v) => Math.round(off + v * s);
    // thin strokes snap to whole pixels and never go below 2px at small sizes
    const T = Math.max(o.size <= 48 ? 2 : 1, Math.round(G.t * s));
    if (o.tileColor) {
      if (o.shadow) { x.shadowColor = 'rgba(0,0,0,.35)'; x.shadowBlur = o.size * .02; x.shadowOffsetY = o.size * .01; }
      x.fillStyle = o.tileColor;
      x.beginPath(); x.roundRect(off, off, o.tile, o.tile, G.radius * s); x.fill();
      x.shadowColor = 'transparent';
    }
    x.fillStyle = o.markColor;
    const rect = (x1, y1, x2, y2) => x.fillRect(x1, y1, x2 - x1, y2 - y1);
    // top-left corner: ┌
    const a = { x: P(G.tl.x), y: P(G.tl.y) }, la = Math.round(G.tl.arm * s);
    rect(a.x, a.y, a.x + la, a.y + T);
    rect(a.x, a.y, a.x + T, a.y + la);
    // bottom-right corner: ┘
    const b = { x: P(G.br.x), y: P(G.br.y) }, lb = Math.round(G.br.arm * s);
    rect(b.x - lb, b.y - T, b.x, b.y);
    rect(b.x - T, b.y - lb, b.x, b.y);
    // caret
    if (!o.noCaret) {
      const cx = P(G.caret.x), cy = P(G.caret.y);
      rect(cx, cy, cx + Math.max(T, Math.round(G.caret.w * s)), cy + Math.round(G.caret.h * s));
    }
    return c.toDataURL('image/png');
  })()`);
}

const buf = (dataUrl) => Buffer.from(dataUrl.split(',')[1], 'base64');
const save = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); };

// .ico with PNG frames (Windows Vista and later read these directly)
function ico(frames) {
  const head = Buffer.alloc(6 + 16 * frames.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(frames.length, 4);
  let offset = head.length;
  frames.forEach(({ size, png }, i) => {
    const e = 6 + i * 16;
    head.writeUInt8(size >= 256 ? 0 : size, e);
    head.writeUInt8(size >= 256 ? 0 : size, e + 1);
    head.writeUInt8(0, e + 2);
    head.writeUInt8(0, e + 3);
    head.writeUInt16LE(1, e + 4);
    head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(png.length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  return Buffer.concat([head, ...frames.map((f) => f.png)]);
}

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({ show: false });
    await win.loadURL('data:text/html,<body></body>');
    const tile = (size) => draw(win, { size, tile: size, tileColor: TILE, markColor: MARK });

    save(path.join(root, 'src', 'assets', 'snipr-256.png'), buf(await tile(256)));
    const frames = [];
    for (const size of [16, 20, 24, 32, 40, 48, 64, 128, 256]) frames.push({ size, png: buf(await tile(size)) });
    save(path.join(root, 'src', 'assets', 'snipr.ico'), ico(frames));
    save(path.join(root, 'build', 'icon.png'),
      buf(await draw(win, { size: 1024, tile: 824, tileColor: TILE, markColor: MARK, shadow: true })));
    // macOS menu bar: just the mark, black on transparent
    save(path.join(root, 'src', 'assets', 'trayTemplate.png'), buf(await draw(win, { size: 16, tile: 20, markColor: '#000' })));
    save(path.join(root, 'src', 'assets', 'trayTemplate@2x.png'), buf(await draw(win, { size: 32, tile: 40, markColor: '#000' })));
    console.log('icons written');
    app.exit(0);
  } catch (err) {
    console.error(err);
    app.exit(1);
  }
});
