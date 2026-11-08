'use strict';
// Renders the theme pictures used by the README and the website.
//   npx electron scripts/screenshots.js
// Writes docs/assets/themes/<theme>.png (one note per theme, 2x) and
// docs/assets/hero.png (several notes side by side). Nothing is shown on
// screen: the windows render offscreen.

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {}); // keep going between pictures

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'docs', 'assets');
const themeDir = path.join(outDir, 'themes');
fs.mkdirSync(themeDir, { recursive: true });

const THEMES = ['ghost', 'mono', 'paper', 'dots', 'gutter', 'green', 'amber'];
const SCALE = 2;
const NOTE = 300;

const CONTENT = [
  '<b>today</b><hr>',
  'call the dentist<br>',
  'reply to emails<br>',
  'oat milk, coffee, lemons<br>',
  '<br>',
  'ideas<br>',
  '- a note that stays on top<br>',
  '- ctrl+s for another one',
].join('');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function offscreen(width, height) {
  return new BrowserWindow({
    width: width * SCALE, height: height * SCALE, show: false, frame: false,
    useContentSize: true, enableLargerThanScreen: true,
    webPreferences: { offscreen: true, zoomFactor: SCALE, sandbox: true },
  });
}

async function load(win, file, opts) {
  for (let i = 0; ; i++) {
    try { await win.loadFile(file, opts); return; } catch (err) { if (i >= 3) throw err; await wait(300); }
  }
}

async function shoot(theme) {
  const win = offscreen(NOTE, NOTE);
  await wait(100);
  await load(win, path.join(root, 'src', 'note.html'), { query: { theme } });
  win.webContents.setZoomFactor(SCALE);
  await win.webContents.executeJavaScript(`(async () => {
    await document.fonts.ready;
    const ed = document.getElementById('editor');
    ed.innerHTML = ${JSON.stringify(CONTENT)};
    ed.dispatchEvent(new Event('input'));
    document.body.classList.add('hover', 'focused');
    document.body.dataset.dot = 'green';
  })()`);
  await wait(500);
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(themeDir, theme + '.png'), img.toPNG());
  win.destroy();
}

async function hero() {
  // offscreen windows can't be bigger than the screen, so keep it under ~1900px at 2x
  const order = ['ghost', 'paper', 'amber'];
  const offsets = [56, 16, 72];
  const size = 260, gap = 28, margin = 56;
  const width = order.length * size + (order.length - 1) * gap + margin * 2;
  const height = size + 72 + 56 + 16;
  const notes = order.map((t, i) => {
    const src = 'file:///' + path.join(themeDir, t + '.png').replace(/\\/g, '/');
    return `<img src="${src}" style="left:${margin + i * (size + gap)}px; top:${offsets[i] + 20}px">`;
  }).join('');
  const html = `<!doctype html><html><head><style>
    html, body { margin: 0; width: ${width}px; height: ${height}px; overflow: hidden; }
    body {
      background:
        radial-gradient(ellipse at 50% 0%, rgba(255,255,255,.05), transparent 60%),
        radial-gradient(circle, #232323 1px, transparent 1.2px) 0 0 / 22px 22px,
        #0b0b0b;
    }
    img { position: absolute; width: ${size}px; height: ${size}px;
      box-shadow: 0 24px 60px rgba(0,0,0,.6), 0 2px 8px rgba(0,0,0,.4); }
  </style></head><body>${notes}</body></html>`;
  const file = path.join(root, 'shots-out', 'hero.html');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, html);
  const win = offscreen(width, height);
  await wait(100);
  await load(win, file);
  win.webContents.setZoomFactor(SCALE);
  await wait(600);
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(outDir, 'hero.png'), img.toPNG());
  win.destroy();
}

app.whenReady().then(async () => {
  try {
    for (const t of THEMES) await shoot(t);
    await hero();
    console.log('screenshots written to docs/assets');
    app.exit(0);
  } catch (err) {
    console.error(err);
    app.exit(1);
  }
});
