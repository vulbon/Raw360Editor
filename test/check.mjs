// Runnable checks for the CPU-side modules: `node test/check.mjs [sample.dng]`
// Correctness asserts + timings for the DNG decoder / LJ92 encoder and the color math.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseDNG, decodeLJ92 } from '../src/dng.js';
import { encodeLJ92, linearDNG, tiles, jpegHeader, encodeJpegStrip } from '../src/export.js';
import { xyFromTempTint, tempTintFromXY, mm, tr, rx, ry, rz, eulerYXZ, fromTo } from '../src/color.js';

const time = (label, fn, runs = 3) => {
  let best = Infinity, out;
  for (let i = 0; i < runs; i++) { const t = performance.now(); out = fn(); best = Math.min(best, performance.now() - t); }
  console.log(`${label.padEnd(34)} ${best.toFixed(1).padStart(8)} ms`);
  return out;
};

// LJ92 round trip on synthetic data with edge cases (full range, constant runs, wrap-around differences)
{
  const w = 257, h = 33, comps = 3, data = new Uint16Array(w * h * comps);
  let s = 1;
  for (let i = 0; i < data.length; i++) { s = (s * 1103515245 + 12345) >>> 0; data[i] = i % 97 < 5 ? 65535 : i % 89 < 7 ? 0 : s >>> 16; }
  const dec = decodeLJ92(encodeLJ92(data, w, h, comps));
  assert.equal(dec.width, w); assert.equal(dec.comps, comps);
  assert.deepEqual(dec.data, data, 'LJ92 round trip must be lossless');
  console.log('LJ92 synthetic round trip           ok');
}

// color: temperature/tint round trip, Euler decomposition round trip
{
  for (const [T, tint] of [[2800, 0], [5500, 10], [8500, -20]]) {
    const [T2, t2] = tempTintFromXY(xyFromTempTint(T, tint));
    assert(Math.abs(T2 - T) / T < 0.005 && Math.abs(t2 - tint) < 0.5, `temp/tint round trip ${T}/${tint} -> ${T2}/${t2}`);
  }
  const D = Math.PI / 180, L = mm(ry(30 * D), mm(rx(-12 * D), rz(7 * D)));
  eulerYXZ(L).forEach((v, i) => assert(Math.abs(v - [30, -12, 7][i]) < 1e-9));
  assert(Math.abs(mm(L, tr(L))[1][1] - 1) < 1e-12);
  // fromTo: maps "down" onto any gravity and stays a rotation, a camera hanging upside down included
  for (const g of [[0.3, 0.9, -0.2], [1, 0, 0], [0, -1, 0], [0.001, -1, 0.001]]) {
    const n = Math.hypot(...g), b = g.map(x => x / n), R = fromTo([0, 1, 0], b), RtR = mm(tr(R), R);
    R.forEach((r, i) => assert(Math.abs(r[1] - b[i]) < 1e-6, `fromTo ${g}`));
    RtR.flat().forEach((x, i) => assert(Math.abs(x - (i % 4 === 0 ? 1 : 0)) < 1e-9, `fromTo orthonormal ${g}`));
  }
  console.log('color / rotation round trips        ok');
}

// real sample: decode timing + lossless re-encode through the DNG writer
// baseline JPEG: byte stuffing leaves no bare 0xFF, a flat gray block costs only a few bytes, the header carries the
// restart interval. Pixel-level decoding is checked in the browser (no JPEG decoder in Node).
{
  const W = 24, H = 16, gray = new Uint8Array(W * H * 4).fill(128), noisy = gray.map((_, i) => (i * 97 + 13) & 255);
  const flat = encodeJpegStrip(gray, W, H, 90), busy = encodeJpegStrip(noisy, W, H, 90);
  assert.ok(flat.length < 16, `flat gray should be tiny, got ${flat.length} bytes`);
  for (let i = 0; i < busy.length - 1; i++) assert.ok(busy[i] !== 0xFF || busy[i + 1] === 0, 'unstuffed 0xFF in entropy data');
  const hdr = Buffer.concat(jpegHeader(W, H, 90, 6, null).map(Buffer.from));
  assert.equal(hdr[0], 0xFF); assert.equal(hdr[1], 0xD8);
  assert.ok(hdr.includes(Buffer.from([0xFF, 0xDD, 0, 4, 0, 6])), 'DRI with the restart interval');
  console.log(`baseline JPEG 4:4:4 strip: flat ${flat.length} B, noisy ${busy.length} B   ok`);
}

const sample = process.argv[2] || 'ref/avata 360/DJI_20261004175341_0047_UP.DNG';
if (fs.existsSync(sample)) {
  const b = fs.readFileSync(sample), buf = b.buffer.slice(b.byteOffset, b.byteOffset + b.length);
  const d = time('parseDNG (decode one lens)', () => parseDNG(buf));
  { // timed before the round trip below, which keeps ~150 MB alive and lets GC distort the number
    const rgb = new Uint16Array(3840 * 1920 * 3);
    for (let i = 0; i < rgb.length; i++) rgb[i] = d.raw[(i / 3) | 0];
    time('linearDNG RGB 3840x1920 (export-like)', () => linearDNG(3840, 1920, tiles(rgb, 3840, 1920, 3), d, d.neutral, {}, null), 2);
  }
  const blob = time('linearDNG Bayer, lossless (one lens)', () => linearDNG(d.width, d.height, tiles(d.raw, d.width, d.height, 1), d, d.neutral, {}, d.cfa), 2);
  const re = parseDNG(await blob.arrayBuffer());
  assert.deepEqual(re.raw, d.raw, 'DNG re-encode must be lossless');
  console.log(`re-encoded ${(blob.size / 1048576).toFixed(1)} MB (source ${(b.length / 1048576).toFixed(1)} MB)   ok`);
} else console.log(`(no sample at ${sample}; skipped real-file checks)`);
