'use strict';

// The gif encoder, off the recording bar's thread, so the bar's timer and the
// frame grabbing never wait for it.
//   in:  { type: 'ping' } · { type: 'start', width, height } · { type: 'frame', data: ArrayBuffer, t } · { type: 'finish', t }
//   out: { type: 'pong' } · { type: 'ack', size } after every frame · { type: 'done', bytes, frames } · { type: 'error', message }
importScripts('gifenc.js');

let enc = null;

onmessage = (e) => {
  const m = e.data;
  try {
    if (m.type === 'ping') {
      postMessage({ type: 'pong' });
    } else if (m.type === 'start') {
      enc = new self.SniprGif.Encoder(m.width, m.height);
    } else if (m.type === 'frame' && enc) {
      enc.addFrame(new Uint8Array(m.data), m.t);
      postMessage({ type: 'ack', size: enc.size });
    } else if (m.type === 'finish' && enc) {
      const frames = enc.taken;
      const bytes = enc.finish(m.t);
      enc = null;
      postMessage({ type: 'done', bytes, frames }, [bytes.buffer]);
    }
  } catch (err) {
    enc = null;
    postMessage({ type: 'error', message: String(err && err.message || err) });
  }
};
