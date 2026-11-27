// png-squeeze-01: squeeze 1280x720 RGBA screenshots into the smallest lossless PNG.
//
// Strategy (measured on the practice set; every choice below was picked by size):
//  - colour-type reduction: palette (type 3 + tRNS) when the image holds at most 256
//    colours, grey (0/4) when every pixel is grey, RGB (2) when fully opaque, and a
//    tRNS key when every non-opaque pixel is one fully-transparent value;
//  - per-row filter choice among None/Sub/Up/Avg/Paeth, minimum-sum and
//    fewest-distinct-pairs, screened with zlib level 9;
//  - the winner re-encoded with a custom DEFLATE encoder: lazy matching with long
//    hash chains, cost-aware match acceptance, and per-block dynamic Huffman tables
//    (fixed Huffman when that is smaller). The custom encoder beats zlib level 9 on
//    the practice set and is fully deterministic: no clock, no environment reads, no
//    randomness; the work per image is a fixed function of the image's bytes.
//
// Runtime: node /bot/main.ts, one run over /input/i001..i008, writes
// /output/<id>/image.png. Deterministic: two runs write identical bytes.

import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { constants, deflateSync, inflateSync } from 'node:zlib';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// ---------------------------------------------------------------------------
// PNG: CRC-32, chunk writer, decoder (bit depth 8, non-interlaced, types 0/2/3/4/6)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes, start = 0, end = bytes.length) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

const SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const ascii = (s) => Uint8Array.from(s, (ch) => ch.charCodeAt(0));

function pngOf(chunks) {
  let size = SIGNATURE.length;
  for (const [, data] of chunks) size += 12 + data.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(SIGNATURE, 0);
  let at = SIGNATURE.length;
  for (const [type, data] of chunks) {
    view.setUint32(at, data.length);
    out.set(ascii(type), at + 4);
    out.set(data, at + 8);
    view.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
    at += 12 + data.length;
  }
  return out;
}

function ihdrOf(width, height, colourType) {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  d[8] = 8;
  d[9] = colourType;
  return d;
}

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function unfilterRow(ft, src, prev, bpp, out) {
  const n = src.length;
  if (ft === 0) { out.set(src); return; }
  if (ft === 1) {
    for (let i = 0; i < n; i++) out[i] = src[i] + (i >= bpp ? out[i - bpp] : 0);
  } else if (ft === 2) {
    for (let i = 0; i < n; i++) out[i] = src[i] + (prev === null ? 0 : prev[i]);
  } else if (ft === 3) {
    for (let i = 0; i < n; i++) {
      out[i] = src[i] + (((i >= bpp ? out[i - bpp] : 0) + (prev === null ? 0 : prev[i])) >> 1);
    }
  } else {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? out[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      out[i] = src[i] + paeth(a, b, c);
    }
  }
}

// Decode a PNG to RGBA ({ok, width, height, rgba} or {ok:false}).
function decodePng(bytes) {
  const fail = () => ({ ok: false });
  if (!(bytes instanceof Uint8Array) || bytes.length < 8) return fail();
  for (let i = 0; i < 8; i++) if (bytes[i] !== SIGNATURE[i]) return fail();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let header = null;
  let palette = null;
  let trns = null;
  const idat = [];
  let ended = false;
  while (at < bytes.length) {
    if (ended || at + 12 > bytes.length) return fail();
    const len = view.getUint32(at);
    if (len > 0x7fffffff || at + 12 + len > bytes.length) return fail();
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    if (crc32(bytes, at + 4, at + 8 + len) !== view.getUint32(at + 8 + len)) return fail();
    const data = bytes.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (type === 'IHDR') {
      if (header !== null || len !== 13) return fail();
      const dv = new DataView(data.buffer, data.byteOffset, 13);
      header = { width: dv.getUint32(0), height: dv.getUint32(4), depth: data[8], colourType: data[9], interlace: data[12] };
      if (header.depth !== 8 || !Object.hasOwn(CHANNELS, header.colourType) || header.interlace !== 0) return fail();
    } else if (type === 'PLTE') {
      if (palette !== null || header.colourType !== 3 || len === 0 || len % 3 !== 0 || len > 768) return fail();
      palette = data;
    } else if (type === 'tRNS') {
      if (trns !== null) return fail();
      trns = data;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      ended = true;
    } else return fail();
  }
  if (!ended || !header || idat.length === 0) return fail();
  const { width, height, colourType } = header;
  const bpp = CHANNELS[colourType];
  const stride = width * bpp;
  const expected = height * (stride + 1);
  let raw;
  try {
    raw = inflateSync(idat.length === 1 ? idat[0] : Buffer.concat(idat), { maxOutputLength: expected + 1 });
  } catch {
    return fail();
  }
  if (raw.length !== expected) return fail();
  const samples = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    if (ft > 4) return fail();
    unfilterRow(ft, raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), y === 0 ? null : samples.subarray((y - 1) * stride, y * stride), bpp, samples.subarray(y * stride, (y + 1) * stride));
  }
  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  if (colourType === 6) rgba.set(samples);
  else if (colourType === 2) {
    const key = trns === null ? -1 : (trns[1] << 16) | (trns[3] << 8) | trns[5];
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = samples[s]; rgba[d + 1] = samples[s + 1]; rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = ((samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2]) === key ? 0 : 255;
    }
  } else if (colourType === 0) {
    const key = trns === null ? -1 : trns[1];
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const g = samples[i];
      rgba[d] = rgba[d + 1] = rgba[d + 2] = g;
      rgba[d + 3] = g === key ? 0 : 255;
    }
  } else if (colourType === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = samples[s];
      rgba[d + 3] = samples[s + 1];
    }
  } else {
    const entries = palette.length / 3;
    const lut = new Uint8Array(entries * 4);
    for (let e = 0; e < entries; e++) {
      lut[e * 4] = palette[e * 3];
      lut[e * 4 + 1] = palette[e * 3 + 1];
      lut[e * 4 + 2] = palette[e * 3 + 2];
      lut[e * 4 + 3] = trns !== null && e < trns.length ? trns[e] : 255;
    }
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const e = samples[i];
      if (e >= entries) return fail();
      rgba[d] = lut[e * 4]; rgba[d + 1] = lut[e * 4 + 1]; rgba[d + 2] = lut[e * 4 + 2]; rgba[d + 3] = lut[e * 4 + 3];
    }
  }
  return { ok: true, width, height, rgba };
}

// ---------------------------------------------------------------------------
// Image analysis: opacity, greyness, colours, transparent key, palette forms
// ---------------------------------------------------------------------------

function wordsOf(rgba) {
  const at = rgba.byteOffset % 4 === 0 ? rgba : rgba.slice();
  return new Uint32Array(at.buffer, at.byteOffset, at.length >>> 2);
}

function analyse(rgba) {
  const n = rgba.length >>> 2;
  const u32 = wordsOf(rgba);
  let opaque = true;
  let grey = true;
  const counts = new Map();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const c = u32[i];
      const k = counts.get(c);
      if (k === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(c, 1);
      } else counts.set(c, k + 1);
    }
  }
  const colours = many ? null : [...counts.keys()].map((c) => {
    const b = new Uint8Array(Uint32Array.of(c).buffer);
    return { rgba: [b[0], b[1], b[2], b[3]], word: c, count: counts.get(c) };
  });
  return { opaque, grey, colours };
}

function transparentKey(rgba, grey) {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}

function samplesOf(rgba, ct) {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 3];
    } else {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 1];
      out[s + 2] = rgba[d + 2];
    }
  }
  return out;
}

function paletteOrder(colours, order) {
  const lum = (c) => 299 * c.rgba[0] + 587 * c.rgba[1] + 114 * c.rgba[2];
  return [...colours].sort((x, y) => {
    const ta = x.rgba[3] === 255 ? 1 : 0;
    const tb = y.rgba[3] === 255 ? 1 : 0;
    if (ta !== tb) return ta - tb;
    if (ta === 0 && x.rgba[3] !== y.rgba[3]) return x.rgba[3] - y.rgba[3];
    if (order === 'luminance') return lum(x) - lum(y) || x.word - y.word;
    return y.count - x.count || x.word - y.word;
  });
}

function paletteForm(rgba, colours, order) {
  const entries = paletteOrder(colours, order);
  const index = new Map(entries.map((c, i) => [c.word, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.rgba[0];
    plte[i * 3 + 1] = c.rgba[1];
    plte[i * 3 + 2] = c.rgba[2];
    if (c.rgba[3] !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.rgba[3]);
  const n = rgba.length >>> 2;
  const u32 = wordsOf(rgba);
  const indices = new Uint8Array(n);
  for (let i = 0; i < n; i++) indices[i] = index.get(u32[i]);
  return { plte, trns, indices };
}

function formsOf(rgba) {
  const { opaque, grey, colours } = analyse(rgba);
  const forms = [];
  if (colours !== null) {
    for (const order of ['count', 'luminance']) {
      const p = paletteForm(rgba, colours, order);
      forms.push({ colourType: 3, bpp: 1, samples: p.indices, plte: p.plte, trns: p.trns, order });
    }
    if (!grey) return forms;
  }
  const key = opaque ? null : transparentKey(rgba, grey);
  let ct;
  let trns = null;
  if (grey) {
    ct = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
  forms.push({ colourType: ct, bpp, samples: samplesOf(rgba, ct), plte: null, trns, order: '' });
  return forms;
}

function chunkBytes(form) {
  return (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);
}

function pngOfForm(width, height, form, idat) {
  const chunks = [['IHDR', ihdrOf(width, height, form.colourType)]];
  if (form.plte !== null) chunks.push(['PLTE', form.plte]);
  if (form.trns !== null) chunks.push(['tRNS', form.trns]);
  chunks.push(['IDAT', idat]);
  chunks.push(['IEND', new Uint8Array(0)]);
  return pngOf(chunks);
}

// ---------------------------------------------------------------------------
// PNG row filters
// ---------------------------------------------------------------------------

function filterRow(type, cur, prev, bpp, out) {
  const n = cur.length;
  if (type === 0) out.set(cur);
  else if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  } else if (type === 2) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (prev === null ? 0 : prev[i]);
  } else if (type === 3) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + (prev === null ? 0 : prev[i])) >> 1);
  } else {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      out[i] = cur[i] - paeth(a, b, c);
    }
  }
}

function signedSum(row) {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

const BRUTE_CONTEXT = 32768;
const BRUTE_LEVEL = 4;

function pairsOf(row, seen, stamp) {
  let n = 0;
  for (let i = 1; i < row.length; i++) {
    const pair = (row[i - 1] << 8) | row[i];
    if (seen[pair] !== stamp) {
      seen[pair] = stamp;
      n++;
    }
  }
  return n;
}

// Filtered raw data of `samples` by `choice`: a fixed filter 0-4 for every row, or
// 'minsum', 'pairs' or 'brute' (per-row choice).
function filtered(samples, width, height, bpp, choice, raw = new Uint8Array(height * (width * bpp + 1))) {
  const stride = width * bpp;
  const trial = Array.from({ length: 5 }, (_, t) => {
    const row = new Uint8Array(stride + 1);
    row[0] = t;
    return row;
  });
  const seen = new Uint32Array(65536);
  let stamp = 0;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (typeof choice === 'number') {
      raw[at] = choice;
      filterRow(choice, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
      continue;
    }
    const before = raw.subarray(Math.max(0, at - BRUTE_CONTEXT), at);
    let type = 0;
    let best = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRow(t, cur, prev, bpp, trial[t].subarray(1));
      let cost;
      if (choice === 'minsum') cost = signedSum(trial[t].subarray(1));
      else if (choice === 'pairs') cost = pairsOf(trial[t].subarray(1), seen, ++stamp);
      else cost = deflateSync(trial[t], before.length === 0 ? { level: BRUTE_LEVEL, memLevel: 9 } : { level: BRUTE_LEVEL, memLevel: 9, dictionary: before }).length;
      if (cost < best) {
        best = cost;
        type = t;
      }
    }
    raw.set(trial[type], at);
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Custom DEFLATE encoder: lazy matching with long hash chains, cost-aware match
// acceptance, per-block dynamic Huffman (or fixed when smaller). One zlib stream.
// Tuned on the practice set: maxChain 4096, 256 KiB blocks, lazy check up to
// length 258. Deterministic: fixed work per input, no clock or environment use.
// ---------------------------------------------------------------------------

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function lenSymOf(len) {
  let lo = 0, hi = 28;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (LEN_BASE[mid] <= len) lo = mid; else hi = mid - 1; }
  return 257 + lo;
}
function distSymOf(dist) {
  let lo = 0, hi = 29;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (DIST_BASE[mid] <= dist) lo = mid; else hi = mid - 1; }
  return lo;
}

const FIXED_LITLEN = new Uint8Array(288);
for (let i = 0; i < 144; i++) FIXED_LITLEN[i] = 8;
for (let i = 144; i < 256; i++) FIXED_LITLEN[i] = 9;
for (let i = 256; i < 280; i++) FIXED_LITLEN[i] = 7;
for (let i = 280; i < 288; i++) FIXED_LITLEN[i] = 8;
const FIXED_DIST = new Uint8Array(30).fill(5);

// Length-limited Huffman code lengths (zlib gen_bitlen style overflow fix).
function buildLengths(freq, maxBits) {
  const n = freq.length;
  let count = 0;
  for (let i = 0; i < n; i++) if (freq[i] > 0) count++;
  const lengths = new Uint8Array(n);
  if (count === 0) return lengths;
  if (count === 1) {
    for (let i = 0; i < n; i++) if (freq[i] > 0) { lengths[i] = 1; return lengths; }
  }
  const heap = [];
  const push = (node) => {
    heap.push(node);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p].f <= heap[i].f) break;
      const t = heap[p]; heap[p] = heap[i]; heap[i] = t; i = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l].f < heap[m].f) m = l;
        if (r < heap.length && heap[r].f < heap[m].f) m = r;
        if (m === i) break;
        const t = heap[m]; heap[m] = heap[i]; heap[i] = t; i = m;
      }
    }
    return top;
  };
  for (let i = 0; i < n; i++) if (freq[i] > 0) push({ f: freq[i], sym: i, left: null, right: null });
  while (heap.length > 1) {
    const a = pop(), b = pop();
    push({ f: a.f + b.f, sym: -1, left: a, right: b });
  }
  const root = pop();
  const depths = new Uint8Array(n);
  const walk = (node, d) => {
    if (node.sym >= 0) { depths[node.sym] = d; return; }
    walk(node.left, d + 1);
    walk(node.right, d + 1);
  };
  walk(root, 0);
  let maxLen = 0;
  for (let i = 0; i < n; i++) if (depths[i] > maxLen) maxLen = depths[i];
  if (maxLen <= maxBits) return depths;
  const bc = new Int32Array(maxBits + 1);
  for (let i = 0; i < n; i++) if (depths[i] > 0) bc[Math.min(depths[i], maxBits)]++;
  let ov = 0;
  for (let i = 0; i < n; i++) if (depths[i] > maxBits) ov++;
  do {
    let bits = maxBits - 1;
    while (bc[bits] === 0) bits--;
    bc[bits]--;
    bc[bits + 1] += 2;
    bc[maxBits]--;
    ov -= 2;
  } while (ov > 0);
  const order = [];
  for (let i = 0; i < n; i++) if (freq[i] > 0) order.push(i);
  order.sort((a, b) => freq[b] - freq[a] || a - b);
  const out = new Uint8Array(n);
  let k = 0;
  for (let bits = 1; bits <= maxBits; bits++) {
    for (let j = 0; j < bc[bits]; j++) out[order[k++]] = bits;
  }
  return out;
}

function codesFromLengths(lengths) {
  const n = lengths.length;
  let maxBits = 0;
  for (let i = 0; i < n; i++) if (lengths[i] > maxBits) maxBits = lengths[i];
  const blCount = new Int32Array(maxBits + 1);
  for (let i = 0; i < n; i++) blCount[lengths[i]]++;
  blCount[0] = 0;
  const nextCode = new Int32Array(maxBits + 1);
  let code = 0;
  for (let b = 1; b <= maxBits; b++) {
    code = (code + blCount[b - 1]) << 1;
    nextCode[b] = code;
  }
  const codes = new Uint16Array(n);
  for (let i = 0; i < n; i++) {
    const len = lengths[i];
    if (len) codes[i] = nextCode[len]++;
  }
  return codes;
}

function reverseBits(code, len) {
  let r = 0;
  for (let i = 0; i < len; i++) { r = (r << 1) | (code & 1); code >>>= 1; }
  return r;
}

function adler32(data) {
  let a = 1, b = 0;
  for (let i = 0; i < data.length;) {
    const end = Math.min(data.length, i + 5552);
    for (; i < end; i++) { a += data[i]; b += a; }
    a %= 65521; b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

const FIXED_LIT_CODE = codesFromLengths(FIXED_LITLEN);
const FIXED_DIST_CODE = codesFromLengths(FIXED_DIST);
const MAX_CHAIN = 4096;
const BLOCK_SIZE = 262144;
const LAZY_UP_TO = 258;

function deflateCustom(raw) {
  const n = raw.length;
  const data = new Uint8Array(n + 8);
  data.set(raw);
  const u32 = new Uint32Array(data.buffer, 0, (n + 8) >> 2);

  let out = new Uint8Array(Math.max(1024, n >> 2));
  let outPos = 0;
  let bitBuf = 0, bitCnt = 0;
  function putBits(val, len) {
    bitBuf |= (val << bitCnt) >>> 0;
    bitCnt += len;
    while (bitCnt >= 8) {
      if (outPos >= out.length) {
        const bigger = new Uint8Array(out.length * 2);
        bigger.set(out.subarray(0, outPos));
        out = bigger;
      }
      out[outPos++] = bitBuf & 0xff;
      bitBuf >>>= 8;
      bitCnt -= 8;
    }
  }
  function putRev(code, len) { putBits(reverseBits(code, len), len); }

  out[outPos++] = 0x78; out[outPos++] = 0x9c;

  const HASH_BITS = 16;
  const HASH_SIZE = 1 << HASH_BITS;
  const head = new Int32Array(HASH_SIZE);
  const prev = new Int32Array(n + 1);

  const maxTok = BLOCK_SIZE + 1024;
  const sym = new Uint16Array(maxTok);
  const dsym = new Uint16Array(maxTok);
  const xlen = new Uint16Array(maxTok);
  const xdist = new Uint16Array(maxTok);

  function hashAt(p) {
    const x = (data[p] << 16) | (data[p + 1] << 8) | data[p + 2];
    return (Math.imul(x, 2654435761) >>> 16) & (HASH_SIZE - 1);
  }

  function longestMatch(pos, blockEnd, limitChain) {
    const maxLen = Math.min(258, blockEnd - pos);
    if (maxLen < 3) return [0, 0];
    const h = hashAt(pos);
    let cand = head[h];
    let bestLen = 0, bestDist = 0;
    let chain = limitChain;
    while (cand !== -1 && chain-- > 0) {
      const dist = pos - cand;
      if (dist > 32768) break;
      if (data[cand] !== data[pos] || data[cand + 1] !== data[pos + 1] || data[cand + 2] !== data[pos + 2]) {
        cand = prev[cand];
        continue;
      }
      let len = 3;
      if (maxLen > 3 && data[cand + 3] === data[pos + 3]) {
        len = 4;
        if ((pos & 3) === 0 && (cand & 3) === 0 && maxLen > 4) {
          const a = (cand >> 2) + 1, b = (pos >> 2) + 1;
          const maxWords = (maxLen - 4) >> 2;
          let w = 0;
          while (w < maxWords && u32[a + w] === u32[b + w]) w++;
          len = 4 + (w << 2);
        }
        while (len < maxLen && data[cand + len] === data[pos + len]) len++;
      }
      if (len > bestLen) {
        bestLen = len; bestDist = dist;
        if (len >= maxLen) break;
        if (len >= 32) chain = Math.min(chain, limitChain >> 2);
      }
      cand = prev[cand];
    }
    return [bestLen, bestDist];
  }

  let pos = 0;
  head.fill(-1); // matcher history carries across blocks
  while (pos < n) {
    const blockStart = pos;
    const blockEnd = Math.min(n, pos + BLOCK_SIZE);
    const isLast = blockEnd === n;

    let ntok = 0;
    let p = blockStart;
    while (p < blockEnd) {
      if (p + 2 < blockEnd) {
        const h = hashAt(p);
        const [len, dist] = longestMatch(p, blockEnd, MAX_CHAIN);
        prev[p] = head[h]; head[h] = p;
        if (len >= 3) {
          let take = true;
          if (len < LAZY_UP_TO && p + 3 < blockEnd) {
            const [len2] = longestMatch(p + 1, blockEnd, MAX_CHAIN);
            if (len2 > len) take = false;
          }
          if (take) {
            const ls = lenSymOf(len);
            const ds = distSymOf(dist);
            const mCost = FIXED_LITLEN[ls] + LEN_EXTRA[ls - 257] + FIXED_DIST[ds] + DIST_EXTRA[ds];
            let lCost = 0;
            for (let k = 0; k < len; k++) lCost += FIXED_LITLEN[data[p + k]];
            if (mCost < lCost) {
              sym[ntok] = ls;
              dsym[ntok] = ds;
              xlen[ntok] = len - LEN_BASE[ls - 257];
              xdist[ntok] = dist - DIST_BASE[ds];
              ntok++;
              for (let k = 1; k < len; k++) {
                if (p + k + 2 < blockEnd) {
                  const hh = hashAt(p + k);
                  prev[p + k] = head[hh]; head[hh] = p + k;
                }
              }
              p += len;
              continue;
            }
          }
        }
      }
      sym[ntok] = data[p];
      dsym[ntok] = 0;
      xlen[ntok] = 0;
      xdist[ntok] = 0;
      ntok++;
      p++;
    }
    sym[ntok] = 256; dsym[ntok] = 0; xlen[ntok] = 0; xdist[ntok] = 0; ntok++;

    const litFreq = new Int32Array(288);
    const distFreq = new Int32Array(30);
    for (let i = 0; i < ntok; i++) {
      litFreq[sym[i]]++;
      if (sym[i] > 256) distFreq[dsym[i]]++;
    }
    if (distFreq.every((v) => v === 0)) distFreq[0] = 1;
    let litCount = 0; for (let i = 0; i < 288; i++) if (litFreq[i]) litCount++;
    if (litCount === 1) { if (!litFreq[0]) litFreq[0] = 1; else litFreq[1] = 1; }
    let distCount = 0; for (let i = 0; i < 30; i++) if (distFreq[i]) distCount++;
    if (distCount === 1) { if (!distFreq[0]) distFreq[0] = 1; else distFreq[1] = 1; }

    const litLen = buildLengths(litFreq, 15);
    const distLen = buildLengths(distFreq, 15);
    const litCode = codesFromLengths(litLen);
    const distCode = codesFromLengths(distLen);

    let fixedBits = 3;
    let dynTokBits = 0;
    for (let i = 0; i < ntok; i++) {
      const s = sym[i];
      fixedBits += FIXED_LITLEN[s];
      dynTokBits += litLen[s];
      if (s > 256) {
        fixedBits += LEN_EXTRA[s - 257] + FIXED_DIST[dsym[i]] + DIST_EXTRA[dsym[i]];
        dynTokBits += LEN_EXTRA[s - 257] + distLen[dsym[i]] + DIST_EXTRA[dsym[i]];
      }
    }
    let hlit = 288, hdist = 30;
    while (hlit > 257 && litLen[hlit - 1] === 0) hlit--;
    while (hdist > 1 && distLen[hdist - 1] === 0) hdist--;
    const total = hlit + hdist;
    const seq = new Uint8Array(total);
    seq.set(litLen.subarray(0, hlit), 0);
    seq.set(distLen.subarray(0, hdist), hlit);
    const clPairs = [];
    {
      let i = 0;
      while (i < total) {
        const v = seq[i];
        let run = 1;
        while (i + run < total && seq[i + run] === v) run++;
        let done = 0;
        if (v === 0) {
          while (run - done >= 11) { const t = Math.min(run - done, 138); clPairs.push([18, t]); done += t; }
          if (run - done >= 3) { clPairs.push([17, run - done]); done = run; }
          while (done < run) { clPairs.push([0, 0]); done++; }
        } else {
          clPairs.push([v, 0]); done++;
          while (run - done >= 3) { const t = Math.min(run - done, 6); clPairs.push([16, t]); done += t; }
          while (done < run) { clPairs.push([v, 0]); done++; }
        }
        i += run;
      }
    }
    const clFreq = new Int32Array(19);
    for (const [s] of clPairs) clFreq[s]++;
    let clCount = 0; for (let i = 0; i < 19; i++) if (clFreq[i]) clCount++;
    if (clCount === 1) { if (!clFreq[0]) clFreq[0] = 1; else clFreq[1] = 1; }
    const clLen = buildLengths(clFreq, 7);
    const clCode = codesFromLengths(clLen);
    let dynHeaderBits = 3 + 5 + 5 + 4;
    let hclen = 19;
    while (hclen > 4 && clLen[CL_ORDER[hclen - 1]] === 0) hclen--;
    dynHeaderBits += 3 * hclen;
    for (const [s] of clPairs) {
      dynHeaderBits += clLen[s];
      if (s === 16) dynHeaderBits += 2;
      else if (s === 17) dynHeaderBits += 3;
      else if (s === 18) dynHeaderBits += 7;
    }
    const dynBits = dynHeaderBits + dynTokBits;

    const useDynamic = dynBits < fixedBits;
    putBits(isLast ? 1 : 0, 1);
    if (useDynamic) {
      putBits(2, 2);
      putBits(hlit - 257, 5);
      putBits(hdist - 1, 5);
      putBits(hclen - 4, 4);
      for (let i = 0; i < hclen; i++) putBits(clLen[CL_ORDER[i]], 3);
      for (const [s, v] of clPairs) {
        putRev(clCode[s], clLen[s]);
        if (s === 16) putBits(v - 3, 2);
        else if (s === 17) putBits(v - 3, 3);
        else if (s === 18) putBits(v - 11, 7);
      }
      for (let i = 0; i < ntok; i++) {
        const s = sym[i];
        putRev(litCode[s], litLen[s]);
        if (s > 256) {
          putBits(xlen[i], LEN_EXTRA[s - 257]);
          putRev(distCode[dsym[i]], distLen[dsym[i]]);
          putBits(xdist[i], DIST_EXTRA[dsym[i]]);
        }
      }
    } else {
      putBits(1, 2);
      for (let i = 0; i < ntok; i++) {
        const s = sym[i];
        putRev(FIXED_LIT_CODE[s], FIXED_LITLEN[s]);
        if (s > 256) {
          putBits(xlen[i], LEN_EXTRA[s - 257]);
          putRev(FIXED_DIST_CODE[dsym[i]], FIXED_DIST[dsym[i]]);
          putBits(xdist[i], DIST_EXTRA[dsym[i]]);
        }
      }
    }
    pos = blockEnd;
  }
  if (bitCnt > 0) {
    if (outPos >= out.length) {
      const bigger = new Uint8Array(out.length * 2);
      bigger.set(out.subarray(0, outPos));
      out = bigger;
    }
    out[outPos++] = bitBuf & 0xff;
    bitBuf = 0; bitCnt = 0;
  }
  const ad = adler32(raw);
  if (outPos + 4 > out.length) {
    const bigger = new Uint8Array(outPos + 4);
    bigger.set(out.subarray(0, outPos));
    out = bigger;
  }
  out[outPos++] = (ad >>> 24) & 0xff;
  out[outPos++] = (ad >>> 16) & 0xff;
  out[outPos++] = (ad >>> 8) & 0xff;
  out[outPos++] = ad & 0xff;
  return out.subarray(0, outPos);
}

// ---------------------------------------------------------------------------
// Main pipeline: screen filter choices with zlib level 9, re-encode the winner
// with the custom DEFLATE encoder, verify the custom stream round-trips, write.
// ---------------------------------------------------------------------------

const FILTERS = {
  palette: [0],
  paletteByLuminance: [0, 'minsum', 'brute'],
  channels: [0, 1, 2, 4, 'minsum', 'pairs', 'brute'],
};
const PNG_OVERHEAD = 57; // signature 8 + IHDR 25 + IEND 12 + IDAT 12
const ZLIB9 = { level: 9, memLevel: 9 };

function encodeImage(rgba, width, height) {
  const forms = formsOf(rgba);
  let best = null;
  for (const form of forms) {
    const choices = form.colourType === 3 ? (form.order === 'count' ? FILTERS.palette : FILTERS.paletteByLuminance) : FILTERS.channels;
    for (const choice of choices) {
      const data = filtered(form.samples, width, height, form.bpp, choice);
      const z = deflateSync(data, ZLIB9);
      const total = z.length + chunkBytes(form) + PNG_OVERHEAD;
      if (best === null || total < best.total) best = { form, choice, data, zlib: z, total };
    }
  }
  // Re-encode the screened winner with the custom encoder; keep whichever is smaller.
  const custom = deflateCustom(best.data);
  let stream = custom;
  let streamBytes = custom.length;
  // Verify the custom stream round-trips exactly; fall back to zlib otherwise.
  let ok = false;
  try {
    const back = inflateSync(custom);
    ok = back.length === best.data.length && back.equals(best.data);
  } catch {
    ok = false;
  }
  if (!ok || best.zlib.length < custom.length) {
    stream = best.zlib;
    streamBytes = best.zlib.length;
  }
  return pngOfForm(width, height, best.form, stream);
}

for (const id of readdirSync(INPUT_DIR).sort()) {
  const inPath = join(INPUT_DIR, id, 'image.png');
  const outDir = join(OUTPUT_DIR, id);
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, 'image.png');
  let bytes;
  try {
    bytes = new Uint8Array(readFileSync(inPath));
  } catch {
    continue;
  }
  const image = decodePng(bytes);
  if (!image.ok || image.width !== 1280 || image.height !== 720) {
    // Safety net: an unreadable input is copied verbatim (valid format, 0 points)
    // rather than leaving the instance unanswered.
    copyFileSync(inPath, outPath);
    continue;
  }
  writeFileSync(outPath, encodeImage(image.rgba, image.width, image.height));
}
