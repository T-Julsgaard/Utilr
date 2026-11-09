'use strict';
// Runs inside snipr (see scripts/smoke.js). Drives the real overlay and snip
// windows with synthetic input and checks clipboard, files and window state.

const path = require('path');
const fs = require('fs');
const { app, clipboard, screen, nativeImage } = require('electron');

// size of the image on the clipboard, or null
async function clipSize() {
  try {
    const items = await clipboard.read();
    const item = items.find((i) => i.types.includes('image/png'));
    if (!item) return null;
    const blob = await item.getType('image/png');
    return nativeImage.createFromBuffer(Buffer.from(await blob.arrayBuffer())).getSize();
  } catch (_) { return null; }
}

module.exports = async (h) => {
  const out = process.env.SNIPR_SMOKE_OUT;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const fails = [];
  const check = (cond, msg) => { console.log((cond ? 'ok    ' : 'FAIL  ') + msg); if (!cond) fails.push(msg); };
  const until = async (fn, ms = 6000, what = 'condition') => {
    const t = Date.now();
    while (Date.now() - t < ms) { if (await fn()) return true; await wait(25); }
    throw new Error('timed out waiting for ' + what);
  };
  const shot = async (win, name) => {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(out, name + '.png'), img.toPNG());
  };
  const js = (win, code) => win.webContents.executeJavaScript(code);
  const mouse = (win, type, x, y, button = 'left') => win.webContents.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button, clickCount: 1 });
  const key = (win, keyCode, modifiers = []) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  };
  async function drag(win, from, to, steps = 8) {
    mouse(win, 'mouseMove', from.x, from.y);
    mouse(win, 'mouseDown', from.x, from.y);
    for (let i = 1; i <= steps; i++) {
      mouse(win, 'mouseMove', from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
      await wait(16);
    }
    mouse(win, 'mouseUp', to.x, to.y);
    await wait(60);
  }

  try {
    const shotsDir = path.join(path.dirname(out), 'smoke-out', 'saved');
    fs.rmSync(shotsDir, { recursive: true, force: true });
    check(h.settings().onTop === false, 'snips are not on top by default');
    check(h.settings().closeAfterCopy === false, '"close after copy" is off by default');
    check(fs.existsSync(path.join(app.getPath('pictures'), 'snipr')), 'the snipr folder exists from the start');
    h.settings().folder = shotsDir;
    await wait(900);

    // --- 1. capture: overlay comes up over the screen ----------------------
    const primary = screen.getPrimaryDisplay();
    let t0 = Date.now();
    h.startCapture('key');
    const ov = await (async () => {
      await until(() => [...h.overlays.values()].some((w) => !w.isDestroyed() && w.isVisible() && w.getOpacity() > 0.99), 6000, 'overlay');
      return h.overlays.get(primary.id);
    })();
    check(true, `overlay visible after ${Date.now() - t0} ms`);
    check(ov && ov.isVisible(), 'primary display has an overlay');
    const ob = ov.getBounds();
    check(ob.width === primary.bounds.width && ob.height === primary.bounds.height, `overlay covers the display (${ob.width}×${ob.height})`);
    mouse(ov, 'mouseMove', 640, 360);
    await wait(250);
    await shot(ov, '1-overlay');

    // --- 2. drag a selection -------------------------------------------------
    const A = { x: 360, y: 220 }, B = { x: 860, y: 520 };
    mouse(ov, 'mouseMove', A.x, A.y);
    mouse(ov, 'mouseDown', A.x, A.y);
    for (let i = 1; i <= 10; i++) { mouse(ov, 'mouseMove', A.x + (B.x - A.x) * i / 10, A.y + (B.y - A.y) * i / 10); await wait(16); }
    await wait(150);
    await shot(ov, '2-drag');
    const readout = await js(ov, "document.getElementById('readout').textContent");
    const sc = primary.scaleFactor;
    check(readout.replace(/\s/g, '') === `${Math.round(500 * sc)}×${Math.round(300 * sc)}`, `size readout says "${readout}"`);
    t0 = Date.now();
    mouse(ov, 'mouseUp', B.x, B.y);

    // --- 3. the snip window -------------------------------------------------
    await until(() => h.snips.size === 1, 6000, 'snip window');
    const snip = [...h.snips.values()][0];
    await until(() => snip.win.isVisible() && snip.win.getOpacity() > 0.99, 6000, 'snip fade-in');
    check(true, `snip window shown ${Date.now() - t0} ms after release`);
    check(!ov.isVisible(), 'overlay hidden after the snip');
    const clip = (await clipSize()) || {};
    check(clip.width === Math.round(500 * sc) && clip.height === Math.round(300 * sc), `clipboard holds ${clip.width}×${clip.height}`);
    const sb = snip.win.getBounds();
    check(sb.x === primary.bounds.x + A.x && sb.y === primary.bounds.y + A.y - 30, `snip sits where it was taken (${sb.x},${sb.y})`);
    await wait(300);
    await shot(snip.win, '3-snip-rest');
    await js(snip.win, "document.body.classList.add('hover')");
    await wait(320);
    await shot(snip.win, '4-snip-hover');

    // --- 4. marks -----------------------------------------------------------
    const r = await js(snip.win, "(() => { const r = document.getElementById('canvas').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()");
    const at = (fx, fy) => ({ x: r.x + r.w * fx, y: r.y + r.h * fy });
    const tool = (t) => js(snip.win, `document.querySelector('button[data-tool="${t}"]').click()`);
    await tool('box'); await drag(snip.win, at(0.08, 0.15), at(0.45, 0.6));
    await tool('arrow'); await drag(snip.win, at(0.85, 0.85), at(0.5, 0.45));
    await tool('blur'); await drag(snip.win, at(0.55, 0.08), at(0.92, 0.3));
    await tool('pen'); await drag(snip.win, at(0.1, 0.8), at(0.35, 0.9), 12);
    await tool('circle'); await drag(snip.win, at(0.62, 0.55), at(0.8, 0.8));
    await js(snip.win, "window.snipr.setSettings({ font: 'Space Mono' })");
    await wait(150);
    await tool('text');
    await drag(snip.win, at(0.08, 0.62), at(0.4, 0.78)); // a box: the letters follow its height
    await wait(80);
    const ed = await js(snip.win, "(() => { const e = document.querySelector('.text-input'); return e && { size: parseFloat(e.style.fontSize), font: e.style.fontFamily }; })()");
    const boxH = r.h * 0.16;
    check(ed && Math.abs(ed.size - boxH / 1.25) < 1.5, 'text size follows the box (' + (ed && ed.size.toFixed(1)) + ' px for a ' + boxH.toFixed(0) + ' px box)');
    check(ed && /Space Mono/.test(ed.font), 'text uses the chosen font');
    await snip.win.webContents.insertText('look here');
    key(snip.win, 'Enter');
    await wait(120);
    const n = await js(snip.win, "document.querySelectorAll('.text-input').length");
    check(n === 0, 'text committed');
    await tool('text'); // back to the hand
    await wait(350);
    await shot(snip.win, '5-marks');

    // --- 5. copy + save -----------------------------------------------------
    await clipboard.clear();
    await js(snip.win, "document.getElementById('btn-copy').click()");
    await until(async () => !!(await clipSize()), 3000, 'clipboard');
    const c2 = await clipSize();
    check(c2.width === clip.width && c2.height === clip.height, 'marked snip copied at full size');
    await js(snip.win, "document.getElementById('btn-save').click()");
    await until(() => fs.existsSync(shotsDir) && fs.readdirSync(shotsDir).length === 1, 3000, 'saved file');
    const saved = fs.readdirSync(shotsDir)[0];
    check(/^snip-\d{4}-\d\d-\d\d-\d{6}\.png$/.test(saved), `saved as ${saved}`);
    await js(snip.win, "document.getElementById('btn-save').click()");
    await wait(300);
    check(fs.readdirSync(shotsDir).length === 1, 'saving again updates the same file');
    await shot(snip.win, '6-saved');

    // --- 6. menus -----------------------------------------------------------
    await js(snip.win, "document.getElementById('btn-settings').click()");
    await wait(200);
    await shot(snip.win, '7-gear-menu');
    const sb0 = snip.win.getBounds();
    snip.win.setBounds({ ...sb0, width: sb0.width + 120 });
    await wait(250);
    const edge = await js(snip.win, "(() => { const r = document.getElementById('menu').getBoundingClientRect(); return [r.right, innerWidth]; })()");
    check(Math.abs(edge[1] - 6 - edge[0]) < 2, 'settings menu follows a resize (right edge ' + Math.round(edge[0]) + ' / ' + edge[1] + ')');
    await shot(snip.win, '7b-gear-menu-resized');
    snip.win.setBounds(sb0);
    await wait(150);
    key(snip.win, 'Escape');
    await wait(100);
    check(await js(snip.win, "document.getElementById('menu').hidden"), 'esc closes the menu');
    await js(snip.win, `document.getElementById('canvas').dispatchEvent(new MouseEvent('contextmenu', { clientX: ${Math.round(r.x + 40)}, clientY: ${Math.round(r.y + 30)}, bubbles: true }))`);
    await wait(200);
    await shot(snip.win, '8-context-menu');
    key(snip.win, 'Escape');
    await wait(80);

    // --- 7. discard with unsaved marks asks first --------------------------
    await tool('box'); await drag(snip.win, at(0.6, 0.6), at(0.7, 0.75));
    key(snip.win, 'Escape'); // drop the tool
    key(snip.win, 'Escape'); // close → asks
    await wait(200);
    check(!(await js(snip.win, "document.getElementById('confirm').hidden")), 'closing with new marks asks first');
    await shot(snip.win, '9-confirm');
    key(snip.win, 'Y');
    await until(() => h.snips.size === 0, 3000, 'snip closed');
    check(true, 'snip closed after [y]es');

    // --- 8. cancel a capture with esc ---------------------------------------
    h.startCapture('key');
    await until(() => h.overlays.get(primary.id).isVisible() && h.overlays.get(primary.id).getOpacity() > 0.99, 6000, 'second overlay');
    key(h.overlays.get(primary.id), 'Escape');
    await until(() => ![...h.overlays.values()].some((w) => w.isVisible()), 3000, 'overlay gone');
    check(h.session() === null, 'esc cancels the capture');

    // --- 9. click = whole screen ------------------------------------------
    h.settings().open = false;
    h.startCapture('key');
    await until(() => h.overlays.get(primary.id).isVisible() && h.overlays.get(primary.id).getOpacity() > 0.99, 6000, 'third overlay');
    const o3 = h.overlays.get(primary.id);
    mouse(o3, 'mouseMove', 500, 500); mouse(o3, 'mouseDown', 500, 500); mouse(o3, 'mouseUp', 500, 500);
    await until(() => !o3.isVisible(), 3000, 'overlay gone');
    await wait(150);
    const full = (await clipSize()) || {};
    check(full.width === Math.round(primary.bounds.width * sc) && full.height === Math.round(primary.bounds.height * sc), `click took the whole screen (${full.width}×${full.height})`);
    check(h.snips.size === 0, '"open the snip" off: no window, just the toast');
    await wait(200);
    if (h.toastWin()) await shot(h.toastWin(), '10-toast');
    h.settings().open = true;

    // --- 9b. close after copy ----------------------------------------------
    h.settings().open = true;
    h.settings().closeAfterCopy = true;
    h.startCapture('key');
    const o4 = h.overlays.get(primary.id);
    await until(() => o4.isVisible() && o4.getOpacity() > 0.99, 6000, 'fourth overlay');
    await drag(o4, { x: 300, y: 300 }, { x: 600, y: 500 });
    await until(() => h.snips.size === 1, 6000, 'snip window');
    const s4 = [...h.snips.values()][0];
    await until(() => s4.win.isVisible() && s4.win.getOpacity() > 0.99, 6000, 'snip fade-in');
    await js(s4.win, "document.getElementById('btn-copy').click()");
    await until(() => h.snips.size === 0, 3000, 'close after copy');
    check(true, '"close after copy" closes the snip');
    h.settings().closeAfterCopy = false;

    // --- 10. settings window -----------------------------------------------
    h.openSettings();
    await until(() => h.settingsWin() && h.settingsWin().isVisible() && h.settingsWin().getOpacity() > 0.99, 4000, 'settings');
    await wait(250);
    await js(h.settingsWin(), "document.body.classList.add('hover')");
    await wait(300);
    await shot(h.settingsWin(), '11-settings');
    const sh = await js(h.settingsWin(), "(() => { const c = document.querySelector('.content'); return [c.scrollHeight, c.clientHeight]; })()");
    check(sh[0] <= sh[1], `settings fit without scrolling (${sh[0]} / ${sh[1]})`);
  } catch (err) {
    fails.push(String(err && err.stack || err));
    console.log('FAIL  ' + (err && err.stack || err));
  }
  console.log(fails.length ? `\n${fails.length} failed` : '\nall good');
  app.exit(fails.length ? 1 : 0);
};
