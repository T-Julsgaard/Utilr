'use strict';

// A gif: the recording in its own ghost window, playing, where it was made.
// It's already saved in the folder. Hover for the chrome.
//
//   drag the gif   into a chat, a folder, a document (the saved file itself)
//   ctrl+s save as…   del delete (to the recycle bin)   ctrl+n new gif   esc / ctrl+w close
(async () => {
  const api = window.snipr;
  const $ = (id) => document.getElementById(id);
  const body = document.body;
  const stage = $('stage'), img = $('gif');
  const stLeft = $('st-left'), stRight = $('st-right');

  const init = await api.gifInit();
  if (!init) return;
  let S = init.settings;
  const lw = init.lw || init.width, lh = init.lh || init.height;

  img.src = URL.createObjectURL(new Blob([init.bytes], { type: 'image/gif' }));
  try { await img.decode(); } catch (_) {}

  // a small png of the gif, for the icon under the pointer while it's dragged out
  let thumb = null;
  try {
    const w = Math.min(96, init.width), h = Math.max(1, Math.round(init.height * w / init.width));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    c.getContext('2d').drawImage(img, 0, 0, w, h);
    const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
    if (blob) thumb = new Uint8Array(await blob.arrayBuffer());
  } catch (_) {}

  // --- layout: like a snip, never bigger than the area was on screen ----------

  let view = 1;
  function layout() {
    const cs = getComputedStyle(stage);
    const aw = stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const ah = stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    view = Math.max(0.01, Math.min(1, aw / lw, ah / lh));
    img.style.width = Math.max(1, Math.round(lw * view)) + 'px';
    img.style.height = Math.max(1, Math.round(lh * view)) + 'px';
    status();
  }
  new ResizeObserver(layout).observe(stage);

  let border = -1;
  function applyBorder() {
    const px = S.border || 0;
    if (px === border) return;
    border = px;
    document.documentElement.style.setProperty('--matte', px + 'px');
    body.classList.toggle('matte', px > 0);
  }
  applyBorder();
  api.onSettings((s) => { S = s; applyBorder(); });

  // --- status line ---------------------------------------------------------------

  const secs = (ms) => (ms / 1000).toFixed(1) + ' s';
  let msg = null, msgTimer = null;
  function status() {
    stLeft.textContent = `${init.width} × ${init.height}  ${secs(init.ms)}`;
    stRight.textContent = msg || init.size;
    stRight.className = 'st-right' + (msg ? ' st-msg' : '');
  }
  function flash(text, ms = 1800) {
    clearTimeout(msgTimer);
    msg = text;
    body.classList.add('flash');
    status();
    msgTimer = setTimeout(() => { msg = null; body.classList.remove('flash'); status(); }, ms);
  }
  if (init.saved) flash('saved  ' + init.saved, 2400);

  // --- actions -------------------------------------------------------------------

  async function saveAs() {
    const r = await api.gifSaveAs();
    if (!r) return;
    if (r.error) flash('could not save');
    else flash('saved  ' + r);
  }
  async function del() {
    if (!(await api.gifDelete())) flash('could not delete');
  }
  const close = () => api.closeWindow();

  $('btn-save').addEventListener('click', saveAs);
  $('btn-folder').addEventListener('click', () => api.gifShow());
  $('btn-delete').addEventListener('click', del);
  $('btn-close').addEventListener('click', close);
  for (const b of document.querySelectorAll('.bar button')) b.addEventListener('mousedown', (e) => e.preventDefault());

  img.addEventListener('dragstart', (e) => {
    e.preventDefault();
    api.gifDrag(thumb);
  });

  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Escape' || (mod && e.code === 'KeyW')) { e.preventDefault(); close(); }
    else if (mod && e.code === 'KeyS') { e.preventDefault(); saveAs(); }
    else if (mod && e.code === 'KeyN') { e.preventDefault(); api.newGif(); }
    else if (!mod && e.key === 'Delete') { e.preventDefault(); del(); }
  });
  window.addEventListener('contextmenu', (e) => e.preventDefault());

  layout();
})();
