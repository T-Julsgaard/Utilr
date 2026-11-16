// A small animated GIF encoder for screen recordings. No dependencies; the
// same file runs in the gif worker (importScripts), in a page (<script>, as a
// fallback when there's no worker) and in node (require, for tests).
//
//   const enc = new SniprGif.Encoder(width, height);
//   enc.addFrame(rgba, ms);   // rgba: Uint8ClampedArray / Uint8Array, width*height*4; ms: when it was taken
//   const bytes = enc.finish(ms);  // ms: when the recording stopped -> Uint8Array (the .gif)
//
// Made for screens, where most of a frame is the same as the one before:
//   - a frame that didn't change isn't written; the one before it just stays longer
//   - a frame that did is cropped to the box round what changed, and inside that
//     box the pixels that didn't change are transparent (the old ones show
//     through), which compresses to almost nothing
//   - every frame gets its own 255 colours: exact when the changed pixels have
//     that few (most of a UI), else a median cut of their colours. No dithering:
//     text and flat UI stay crisp, and dither noise would defeat the above
//   - frames are timed from when they were taken, so a dropped or merged frame
//     never makes the gif run fast
(function (root) {
  'use strict';

  // --- growable byte buffer -------------------------------------------------

  class Bytes {
    constructor(cap = 1 << 16) { this.buf = new Uint8Array(cap); this.n = 0; }
    room(k) {
      if (this.n + k <= this.buf.length) return;
      let c = this.buf.length * 2;
      while (c < this.n + k) c *= 2;
      const b = new Uint8Array(c);
      b.set(this.buf.subarray(0, this.n));
      this.buf = b;
    }
    byte(v) { this.room(1); this.buf[this.n++] = v; }
    u16(v) { this.room(2); this.buf[this.n++] = v & 255; this.buf[this.n++] = (v >> 8) & 255; }
    bytes(a) { this.room(a.length); this.buf.set(a, this.n); this.n += a.length; }
    str(s) { for (let i = 0; i < s.length; i++) this.byte(s.charCodeAt(i)); }
    result() { return this.buf.slice(0, this.n); }
  }

  // --- LZW (the GIF flavour: variable code size up to 12 bits, sub-blocks) ---

  // The dictionary is a flat table indexed by prefix * 256 + next index, with a
  // generation stamp per slot, so resetting it is one increment instead of a fill.
  const TABLE = 4096 * 256;
  class Lzw {
    constructor() { this.code = new Uint16Array(TABLE); this.gen = new Uint32Array(TABLE); this.g = 0; }

    encode(px, len, minCodeSize, out) {
      out.byte(minCodeSize);
      const clear = 1 << minCodeSize, eoi = clear + 1;
      const code = this.code, gen = this.gen;
      let g = ++this.g;
      let size = minCodeSize + 1, next = eoi + 1;
      let acc = 0, bits = 0;
      const block = new Uint8Array(255);
      let bl = 0;

      const put = (c) => {
        acc |= c << bits;
        bits += size;
        while (bits >= 8) {
          block[bl++] = acc & 255;
          acc >>>= 8;
          bits -= 8;
          if (bl === 255) { out.byte(255); out.bytes(block); bl = 0; }
        }
      };
      // after writing a code, the size grows once the next free code no longer
      // fits; the decoder, one entry behind, grows at the same point
      const emit = (c) => {
        put(c);
        if (c === clear) { size = minCodeSize + 1; return; }
        if (next >= (1 << size) && size < 12) size++;
      };

      emit(clear);
      let prefix = px[0];
      for (let i = 1; i < len; i++) {
        const c = px[i];
        const k = (prefix << 8) | c;
        if (gen[k] === g) { prefix = code[k]; continue; }
        emit(prefix);
        if (next < 4096) {
          code[k] = next++;
          gen[k] = g;
        } else {
          emit(clear);
          g = ++this.g;
          next = eoi + 1;
        }
        prefix = c;
      }
      emit(prefix);
      emit(eoi);
      if (bits > 0) { block[bl++] = acc & 255; if (bl === 255) { out.byte(255); out.bytes(block); bl = 0; } }
      if (bl) { out.byte(bl); out.bytes(block.subarray(0, bl)); }
      out.byte(0);
      if (this.g > 0xfffffff0) { this.gen.fill(0); this.g = 0; }
    }
  }

  // --- colours ------------------------------------------------------------

  // pixels are read as little-endian uint32: 0xAABBGGRR
  const R = (p) => p & 255, G = (p) => (p >>> 8) & 255, B = (p) => (p >>> 16) & 255;
  const bin = (p) => ((p >>> 3) & 31) | (((p >>> 11) & 31) << 5) | (((p >>> 19) & 31) << 10); // 5 bits a channel

  const MAX = 255; // colours per frame; index 255 is kept for "unchanged" (transparent)
  const TRANSPARENT = 255;

  class Palette {
    constructor() {
      this.count = new Uint32Array(32768);
      this.rs = new Float64Array(32768);
      this.gs = new Float64Array(32768);
      this.bs = new Float64Array(32768);
      this.lut = new Uint8Array(32768); // 5-bit bin -> palette index (median cut)
      this.used = new Int32Array(32768);
    }

    // The colours of the pixels where take[i] (or all, when take is null).
    // -> { colors: [0xBBGGRR...], index(p) }
    build(px, idx, n) {
      // exact: every colour gets its own entry when there are few enough
      const exact = new Map();
      let last = -1, ok = true;
      for (let j = 0; j < n; j++) {
        const p = px[idx[j]] & 0xffffff;
        if (p === last) continue;
        last = p;
        if (!exact.has(p)) {
          if (exact.size === MAX) { ok = false; break; }
          exact.set(p, exact.size);
        }
      }
      if (ok) {
        const colors = [...exact.keys()];
        let lp = -1, li = 0;
        return {
          colors,
          index: (p) => { p &= 0xffffff; if (p !== lp) { lp = p; li = exact.get(p); } return li; },
        };
      }
      return this.medianCut(px, idx, n);
    }

    medianCut(px, idx, n) {
      const { count, rs, gs, bs, lut, used } = this;
      let nu = 0;
      for (let j = 0; j < n; j++) {
        const p = px[idx[j]];
        const b = bin(p);
        if (count[b]++ === 0) used[nu++] = b;
        rs[b] += R(p); gs[b] += G(p); bs[b] += B(p);
      }
      // boxes of bins; split the one with the widest channel x most pixels at its median
      const boxes = [this.box(used.slice(0, nu))];
      while (boxes.length < MAX) {
        let best = -1, score = 0;
        for (let i = 0; i < boxes.length; i++) {
          const bx = boxes[i];
          if (bx.bins.length < 2) continue;
          const s = bx.range * Math.sqrt(bx.n);
          if (s > score) { score = s; best = i; }
        }
        if (best < 0) break;
        const bx = boxes[best];
        const sh = bx.axis * 5;
        bx.bins.sort((a, b) => ((a >> sh) & 31) - ((b >> sh) & 31));
        let half = bx.n / 2, acc = 0, cut = 1;
        for (let i = 0; i < bx.bins.length - 1; i++) {
          acc += count[bx.bins[i]];
          if (acc >= half) { cut = i + 1; break; }
        }
        // never split between two bins with the same value on the axis
        while (cut < bx.bins.length && ((bx.bins[cut] >> sh) & 31) === ((bx.bins[cut - 1] >> sh) & 31)) cut++;
        if (cut >= bx.bins.length) {
          cut = bx.bins.length - 1;
          while (cut > 0 && ((bx.bins[cut] >> sh) & 31) === ((bx.bins[cut - 1] >> sh) & 31)) cut--;
          if (cut === 0) { bx.range = 0; continue; }
        }
        boxes.splice(best, 1, this.box(bx.bins.slice(0, cut)), this.box(bx.bins.slice(cut)));
      }
      const colors = boxes.map((bx, i) => {
        let r = 0, g = 0, b = 0;
        for (const k of bx.bins) { r += rs[k]; g += gs[k]; b += bs[k]; lut[k] = i; }
        return Math.round(r / bx.n) | (Math.round(g / bx.n) << 8) | (Math.round(b / bx.n) << 16);
      });
      for (let i = 0; i < nu; i++) { const k = used[i]; count[k] = 0; rs[k] = gs[k] = bs[k] = 0; }
      return { colors, index: (p) => lut[bin(p)] };
    }

    box(bins) {
      const { count } = this;
      let n = 0;
      const lo = [31, 31, 31], hi = [0, 0, 0];
      for (const k of bins) {
        n += count[k];
        for (let a = 0; a < 3; a++) {
          const v = (k >> (a * 5)) & 31;
          if (v < lo[a]) lo[a] = v;
          if (v > hi[a]) hi[a] = v;
        }
      }
      let axis = 0;
      for (let a = 1; a < 3; a++) if (hi[a] - lo[a] > hi[axis] - lo[axis]) axis = a;
      // green counts a bit more, red a little, blue least (how eyes weigh them)
      const w = [1.0, 1.2, 0.8][axis];
      return { bins, n, axis, range: (hi[axis] - lo[axis]) * w };
    }
  }

  // --- the encoder -----------------------------------------------------------

  class Encoder {
    constructor(width, height, { loop = true } = {}) {
      this.w = width | 0;
      this.h = height | 0;
      if (this.w < 1 || this.h < 1 || this.w > 65535 || this.h > 65535) throw new Error('bad gif size');
      this.out = new Bytes(1 << 20);
      this.lzw = new Lzw();
      this.pal = new Palette();
      this.prev = null;      // the last frame's pixels, as taken (not as quantised)
      this.pending = null;   // the last changed frame: written once its length is known
      this.t0 = null;
      this.cs = 0;           // centiseconds written so far
      this.frames = 0;       // frames written
      this.taken = 0;        // frames given
      const o = this.out;
      o.str('GIF89a');
      o.u16(this.w); o.u16(this.h);
      o.byte(0x70);          // no global colour table, 8 bits of colour resolution
      o.byte(0); o.byte(0);
      if (loop) { o.byte(0x21); o.byte(0xff); o.byte(11); o.str('NETSCAPE2.0'); o.byte(3); o.byte(1); o.u16(0); o.byte(0); }
      this.idx = new Int32Array(this.w * this.h); // positions of the changed pixels
      this.ind = new Uint8Array(this.w * this.h); // palette indices of a frame's box
    }

    addFrame(rgba, ms) {
      const { w, h } = this;
      if (!rgba || rgba.length < w * h * 4) throw new Error('frame too small');
      const cur = new Uint32Array(rgba.buffer, rgba.byteOffset, w * h);
      this.taken++;
      if (this.t0 === null) this.t0 = ms;

      const prev = this.prev;
      let x0 = 0, y0 = 0, x1 = w - 1, y1 = h - 1;
      if (prev) {
        // the box round what changed
        x0 = w; y0 = h; x1 = -1; y1 = -1;
        for (let y = 0; y < h; y++) {
          const row = y * w;
          let first = -1, lastX = -1;
          for (let x = 0; x < w; x++) if (cur[row + x] !== prev[row + x]) { first = x; break; }
          if (first < 0) continue;
          for (let x = w - 1; x >= first; x--) if (cur[row + x] !== prev[row + x]) { lastX = x; break; }
          if (y < y0) y0 = y;
          y1 = y;
          if (first < x0) x0 = first;
          if (lastX > x1) x1 = lastX;
        }
        if (x1 < 0) return false; // nothing changed: the frame before just lasts longer
      }

      const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
      const idx = this.idx;
      let n = 0;
      for (let y = y0; y <= y1; y++) {
        const row = y * w;
        for (let x = x0; x <= x1; x++) {
          const i = row + x;
          if (!prev || cur[i] !== prev[i]) idx[n++] = i;
        }
      }
      const pal = this.pal.build(cur, idx, n);
      const ind = this.ind;
      let k = 0;
      for (let y = y0; y <= y1; y++) {
        const row = y * w;
        for (let x = x0; x <= x1; x++) {
          const i = row + x;
          ind[k++] = !prev || cur[i] !== prev[i] ? pal.index(cur[i]) : TRANSPARENT;
        }
      }

      // the colour table is a power of two, at least 2; with transparency it
      // must reach index 255, so it is 256
      const transparent = !!prev && n < bw * bh;
      let bitsNeeded = 1;
      const top = transparent ? 256 : pal.colors.length;
      while ((1 << bitsNeeded) < top) bitsNeeded++;
      const tableSize = 1 << bitsNeeded;
      const table = new Uint8Array(tableSize * 3);
      pal.colors.forEach((c, i) => { table[i * 3] = c & 255; table[i * 3 + 1] = (c >>> 8) & 255; table[i * 3 + 2] = (c >>> 16) & 255; });

      const data = new Bytes(Math.max(1024, (bw * bh) >> 1));
      this.lzw.encode(ind, bw * bh, Math.max(2, bitsNeeded), data);

      this.flush(ms);
      this.pending = { x: x0, y: y0, w: bw, h: bh, bits: bitsNeeded, table, transparent, data: data.result(), t: ms };

      if (!this.prev) this.prev = new Uint32Array(w * h);
      this.prev.set(cur);
      return true;
    }

    // write the pending frame, now that the next change (or the end) says how long it lasts
    flush(ms) {
      const f = this.pending;
      if (!f) return;
      this.pending = null;
      let cs = Math.round((ms - this.t0) / 10) - this.cs;
      if (cs < 2) cs = 2; // 0 and 1 play as 10 in most viewers; the next frame makes up the difference
      if (cs > 65535) cs = 65535;
      this.cs += cs;
      const o = this.out;
      o.byte(0x21); o.byte(0xf9); o.byte(4);
      o.byte((1 << 2) | (f.transparent ? 1 : 0)); // disposal 1: leave it; the next frame draws over it
      o.u16(cs);
      o.byte(f.transparent ? TRANSPARENT : 0);
      o.byte(0);
      o.byte(0x2c);
      o.u16(f.x); o.u16(f.y); o.u16(f.w); o.u16(f.h);
      o.byte(0x80 | (f.bits - 1)); // local colour table
      o.bytes(f.table);
      o.bytes(f.data);
      this.frames++;
    }

    finish(ms) {
      if (this.pending) this.flush(Math.max(ms, this.pending.t + 20));
      this.out.byte(0x3b);
      const bytes = this.out.result();
      this.out = null;
      this.prev = null;
      return bytes;
    }

    get size() { return this.out ? this.out.n : 0; }
  }

  const api = { Encoder };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SniprGif = api;
})(typeof self !== 'undefined' ? self : this);
