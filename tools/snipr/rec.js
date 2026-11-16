'use strict';

// The recording bar, which is also the recorder. It sits beside the area and
// never takes the focus (the app being recorded keeps it).
//
//   ready   the area is set:   rec · in 3 · ×        (gif shortcut = rec)
//   count   3, 2, 1:           ×                     (gif shortcut = cancel)
//   rec     ● 0:04             stop                  (gif shortcut = stop)
//   saving  the encoder finishes; main saves the gif and closes this window
//
// The screen is streamed from the moment the bar opens, so rec starts at once.
// Each frame is cropped to the area (and scaled down past GIF.maxSide) on a
// canvas and handed to gif-worker.js; when the worker is behind, a frame is
// skipped and the one before simply lasts longer (frames carry their time).
(async () => {
  const api = window.snipr;
  const body = document.body;
  const $ = (id) => document.getElementById(id);
  const text = $('text');

  const init = await api.recInit();
  if (!init) return;

  const INTERVAL = 1000 / init.fps;
  const BEHIND = 6; // frames waiting in the encoder before new ones are skipped

  let state = 'ready';
  let stream = null, video = null, streamReady = null;
  let worker = null, workerReady = null, local = null, inflight = 0;
  let geo = null, canvas = null, cx = null;
  let t0 = 0, next = 0, timer = null, clock = null, countTimer = null, left = 3;
  let finished = null; // resolves with the worker's { bytes, frames }

  const pad = (n) => String(n).padStart(2, '0');
  const elapsed = (ms) => `${Math.floor(ms / 60000)}:${pad(Math.floor(ms / 1000) % 60)}`;

  function render() {
    body.dataset.state = state;
    for (const b of document.querySelectorAll('[data-in]')) b.hidden = !b.dataset.in.split(' ').includes(state);
    if (state === 'ready') {
      const k = init.scale;
      text.innerHTML = `${Math.round(init.crop.width * k)} <span class="d">×</span> ${Math.round(init.crop.height * k)}`;
    } else if (state === 'count') text.textContent = String(left);
    else if (state === 'rec') text.textContent = elapsed(performance.now() - t0);
    else if (state === 'saving') text.textContent = 'saving…';
  }

  function setState(s) {
    state = s;
    render();
    api.recState(s);
  }

  // --- the screen stream ----------------------------------------------------

  function openStream() {
    if (streamReady) return streamReady;
    const pw = Math.round(init.display.width * init.scale), ph = Math.round(init.display.height * init.scale);
    const base = { chromeMediaSource: 'desktop', chromeMediaSourceId: init.sourceId, maxFrameRate: Math.max(30, init.fps) };
    const get = (extra) => navigator.mediaDevices.getUserMedia({ audio: false, video: { mandatory: { ...base, ...extra } } });
    streamReady = (async () => {
      // the display's own resolution; some systems only take a maximum
      try { stream = await get({ minWidth: pw, maxWidth: pw, minHeight: ph, maxHeight: ph }); } catch (_) { stream = await get({ maxWidth: pw, maxHeight: ph }); }
      for (const t of stream.getVideoTracks()) t.addEventListener('ended', () => { if (state === 'rec') stop(); });
      video = document.createElement('video');
      video.className = 'rec-video';
      video.muted = true;
      video.srcObject = stream;
      document.body.appendChild(video);
      await video.play();
      if (!video.videoWidth) await new Promise((res) => video.addEventListener('loadedmetadata', res, { once: true }));
    })();
    return streamReady;
  }

  function closeStream() {
    if (stream) for (const t of stream.getTracks()) t.stop();
    stream = null;
    if (video) { video.srcObject = null; video.remove(); video = null; }
  }

  // the area in stream pixels, and the gif's size
  function geometry() {
    const kx = video.videoWidth / init.display.width, ky = video.videoHeight / init.display.height;
    const sx = Math.max(0, Math.round(init.crop.x * kx)), sy = Math.max(0, Math.round(init.crop.y * ky));
    const sw = Math.max(1, Math.min(video.videoWidth - sx, Math.round(init.crop.width * kx)));
    const sh = Math.max(1, Math.min(video.videoHeight - sy, Math.round(init.crop.height * ky)));
    const f = Math.min(1, init.maxSide / Math.max(sw, sh));
    return { sx, sy, sw, sh, ow: Math.max(1, Math.round(sw * f)), oh: Math.max(1, Math.round(sh * f)) };
  }

  // --- the encoder: the worker, or right here when there's no worker ------------

  function openWorker() {
    if (workerReady) return workerReady;
    workerReady = new Promise((res) => {
      let w;
      try { w = new Worker('gif-worker.js'); } catch (_) { res(null); return; }
      const give = (ok) => { if (!ok) { try { w.terminate(); } catch (_) {} } res(ok ? w : null); };
      const t = setTimeout(() => give(false), 2500);
      w.onerror = () => { clearTimeout(t); give(false); };
      w.onmessage = (e) => { if (e.data && e.data.type === 'pong') { clearTimeout(t); give(true); } };
      w.postMessage({ type: 'ping' });
    });
    return workerReady;
  }

  function onWorker(m) {
    if (m.type === 'ack') inflight = Math.max(0, inflight - 1);
    else if (m.type === 'done' && finished) finished.resolve({ bytes: new Uint8Array(m.bytes), frames: m.frames });
    else if (m.type === 'error') {
      if (finished) finished.reject(new Error(m.message));
      else fail(new Error(m.message));
    }
  }

  // --- recording ------------------------------------------------------------

  function grab() {
    const t = performance.now() - t0;
    cx.drawImage(video, geo.sx, geo.sy, geo.sw, geo.sh, 0, 0, geo.ow, geo.oh);
    const data = cx.getImageData(0, 0, geo.ow, geo.oh).data;
    if (worker) {
      inflight++;
      worker.postMessage({ type: 'frame', data: data.buffer, t }, [data.buffer]);
    } else {
      local.addFrame(data, t);
    }
  }

  function loop() {
    if (state !== 'rec') return;
    const now = performance.now();
    if (now - t0 >= init.maxMs) { stop(); return; }
    if (inflight < BEHIND) {
      try { grab(); } catch (err) { fail(err); return; }
    }
    next += INTERVAL;
    const wait = next - performance.now();
    if (wait < 0) next = performance.now(); // fell behind: carry on from now, no burst
    timer = setTimeout(loop, Math.max(0, wait));
  }

  let starting = false;
  async function record() {
    if ((state !== 'ready' && state !== 'count') || starting) return;
    starting = true;
    clearInterval(countTimer);
    try {
      await openStream();
      geo = geometry();
      canvas = document.createElement('canvas');
      canvas.width = geo.ow;
      canvas.height = geo.oh;
      cx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
      cx.imageSmoothingQuality = 'high';
      worker = await openWorker();
      if (worker) {
        worker.onmessage = (e) => onWorker(e.data);
        worker.onerror = (e) => fail(new Error('encoder: ' + (e.message || 'stopped')));
        worker.postMessage({ type: 'start', width: geo.ow, height: geo.oh });
      } else {
        local = new window.SniprGif.Encoder(geo.ow, geo.oh);
      }
    } catch (err) { fail(err); return; }
    if (state !== 'ready' && state !== 'count') return; // cancelled meanwhile
    t0 = performance.now();
    next = t0;
    setState('rec');
    clock = setInterval(render, 250);
    loop();
  }

  function delay() {
    if (state !== 'ready') return;
    left = 3;
    setState('count');
    countTimer = setInterval(() => {
      left -= 1;
      if (left <= 0) record();
      else render();
    }, 1000);
  }

  async function stop() {
    if (state !== 'rec') return;
    clearTimeout(timer);
    clearInterval(clock);
    const ms = performance.now() - t0;
    setState('saving');
    closeStream();
    let out;
    try {
      if (worker) {
        out = await new Promise((resolve, reject) => {
          finished = { resolve, reject };
          worker.postMessage({ type: 'finish', t: ms });
        });
        worker.terminate();
        worker = null;
      } else {
        const frames = local.taken;
        out = { bytes: local.finish(ms), frames };
        local = null;
      }
    } catch (err) { fail(err); return; }
    await api.recDone(out.bytes, { width: geo.ow, height: geo.oh, ms, frames: out.frames }); // main closes this window
  }

  function cancel() {
    if (state !== 'ready' && state !== 'count') return;
    clearInterval(countTimer);
    state = 'gone';
    closeStream();
    if (worker) worker.terminate();
    api.recCancel();
  }

  function fail(err) {
    if (state === 'gone') return;
    state = 'gone';
    clearTimeout(timer);
    clearInterval(clock);
    clearInterval(countTimer);
    closeStream();
    if (worker) { try { worker.terminate(); } catch (_) {} }
    api.recFail(err && err.message || String(err));
  }

  // --- input ------------------------------------------------------------------

  const ACTS = { rec: record, delay, stop, cancel };
  $('bar').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (b && !b.hidden && ACTS[b.dataset.act]) ACTS[b.dataset.act]();
  });

  // the gif shortcut, pressed again
  api.onRecKey(() => {
    if (state === 'ready') record();
    else if (state === 'count') cancel();
    else if (state === 'rec') stop();
  });

  $('btn-rec').title = `Record now (${init.key})`;
  $('btn-stop').title = `Stop (${init.key})`;
  render();

  // warm up while you choose: rec then starts at once
  openWorker();
  openStream().catch(fail);
})();
