// This product includes DNG technology under license by Adobe.
// Writers: 16-bit TIFF, linear DNG (LinearRaw), JPEG XMP injection.

const T = { BYTE: 1, ASCII: 2, SHORT: 3, LONG: 4, RATIONAL: 5, UNDEFINED: 7, SRATIONAL: 10, FLOAT: 11 };
const SZ = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 10: 8, 11: 4 };

// Lossless JPEG (SOF3, predictor 1) of one tile, `comps` interleaved 16-bit components. Returns a view into a reused
// scratch buffer: copy it before the next call.
let scratch = { n: 0 };
export function encodeLJ92(data, w, h, comps) {
  const n = w * h * comps, row = w * comps;
  if (scratch.n < n) scratch = { n, diff: new Int32Array(n), cat: new Uint8Array(n), out: new Uint8Array(n * 5 + 1024) };
  const { diff, cat, out } = scratch, freq = new Array(18).fill(0);
  for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < comps; c++, i++) {
    const P = y === 0 ? (x === 0 ? 32768 : data[i - comps]) : x === 0 ? data[i - row] : data[i - comps];
    const d = ((data[i] - P) << 16) >> 16, s = d ? 32 - Math.clz32(d < 0 ? -d : d) : 0;
    diff[i] = d; cat[i] = s; freq[s]++;
  }
  freq[17] = 1; // reserved symbol: takes the all-ones code, which JPEG forbids
  const len = huffLengths(freq), max = Math.max(...len);
  if (len[17] < max) { const s = len.indexOf(max); len[s] = len[17]; len[17] = max; }
  const code = new Uint32Array(18), counts = new Array(16).fill(0), syms = [];
  for (let l = 1, c = 0; l <= 16; l++, c <<= 1)
    for (let s = 0; s < 18; s++) if (len[s] === l) { code[s] = c++; if (s < 17) { counts[l - 1]++; syms.push(s); } }

  let pos = 0, acc = 0, nb = 0;
  const bytes = (...b) => { for (const x of b) out[pos++] = x; };
  bytes(0xFF, 0xD8, 0xFF, 0xC3, 0, 8 + 3 * comps, 16, h >> 8, h & 255, w >> 8, w & 255, comps);
  for (let c = 0; c < comps; c++) bytes(c, 0x11, 0);
  bytes(0xFF, 0xC4, 0, 19 + syms.length, 0, ...counts, ...syms);
  bytes(0xFF, 0xDA, 0, 6 + 2 * comps, comps);
  for (let c = 0; c < comps; c++) bytes(c, 0);
  bytes(1, 0, 0);
  // Hot loop, inline: append the code, flush whole bytes (0xFF stuffing), then the same for the extra bits.
  // Flushing between the two keeps acc under 7 + 16 = 23 bits.
  for (let i = 0; i < n; i++) {
    const s = cat[i];
    acc = (acc << len[s]) | code[s]; nb += len[s];
    while (nb >= 8) { nb -= 8; const b = (acc >>> nb) & 255; out[pos++] = b; if (b === 255) out[pos++] = 0; }
    if (s && s < 16) {
      const d = diff[i];
      acc = (acc << s) | ((d < 0 ? d + (1 << s) - 1 : d) & ((1 << s) - 1)); nb += s;
      while (nb >= 8) { nb -= 8; const b = (acc >>> nb) & 255; out[pos++] = b; if (b === 255) out[pos++] = 0; }
    }
    acc &= (1 << nb) - 1;
  }
  if (nb) { const pad = 8 - nb, b = ((acc << pad) | ((1 << pad) - 1)) & 255; out[pos++] = b; if (b === 255) out[pos++] = 0; }
  bytes(0xFF, 0xD9);
  return out.subarray(0, pos);
}

function huffLengths(freq) {
  for (;;) {
    const len = new Array(freq.length).fill(0);
    let nodes = freq.map((f, s) => ({ f, syms: [s] })).filter(n => n.f > 0);
    while (nodes.length > 1) {
      nodes.sort((a, b) => a.f - b.f);
      const [a, b] = nodes.splice(0, 2), syms = [...a.syms, ...b.syms];
      for (const s of syms) len[s]++;
      nodes.push({ f: a.f + b.f, syms });
    }
    if (Math.max(...len) <= 16) return len;
    freq = freq.map(f => (f ? Math.max(1, f >> 1) : 0)); // flatten until the code fits in 16 bits
  }
}

// Images are written as independent chunks so they can be produced band by band (and in parallel workers):
//   { tiles: [...] }        256x256 lossless-JPEG tiles, row-major (DNG)
//   { strips: [...], rows } uncompressed strips of `rows` image rows (TIFF)
export const TILE = 256;

// One row of tiles from a band of `rows` (≤ TILE) image rows, spp samples per pixel; right/bottom edges replicated.
export function encodeTileRow(band, width, rows, spp) {
  const ts = TILE, tile = new Uint16Array(ts * ts * spp), out = [];
  for (let tx = 0; tx < width; tx += ts) {
    const n = Math.min(ts, width - tx);
    for (let y = 0; y < ts; y++) {
      const src = Math.min(rows - 1, y) * width * spp, dst = y * ts * spp;
      tile.set(band.subarray(src + tx * spp, src + (tx + n) * spp), dst);
      for (let x = n; x < ts; x++) tile.copyWithin(dst + x * spp, dst + (n - 1) * spp, dst + n * spp);
    }
    // CFA rows go in as 2 interleaved components so each sample is predicted from its own color
    out.push((spp === 1 ? encodeLJ92(tile, ts / 2, ts, 2) : encodeLJ92(tile, ts, ts, spp)).slice());
  }
  return out;
}
// Whole-image helpers (tests, small images)
export const tiles = (pixels, width, height, spp) => ({ tiles: Array.from({ length: Math.ceil(height / TILE) }, (_, i) =>
  encodeTileRow(pixels.subarray(i * TILE * width * spp, Math.min(height, (i + 1) * TILE) * width * spp), width, Math.min(TILE, height - i * TILE), spp)).flat() });

// entries: [tag, type, values]; values: number[] | string | Uint8Array. exif: same format, written as a sub-IFD.
function writeTIFF(width, height, image, entries, exif = [], spp = 3) {
  const chunks = image.tiles || image.strips;
  entries = image.tiles
    ? [...entries, [322, T.LONG, [TILE]], [323, T.LONG, [TILE]], [324, T.LONG, new Array(chunks.length).fill(0)], [325, T.LONG, chunks.map(c => c.length)]]
    : [...entries, [273, T.LONG, new Array(chunks.length).fill(0)], [278, T.LONG, [image.rows]], [279, T.LONG, chunks.map(c => c.length)]];
  const compress = !!image.tiles;
  const all = [
    [256, T.LONG, [width]], [257, T.LONG, [height]], [258, T.SHORT, new Array(spp).fill(16)], [259, T.SHORT, [compress ? 7 : 1]],
    [277, T.SHORT, [spp]], [284, T.SHORT, [1]], ...entries,
  ];
  if (exif.length) all.push([34665, T.LONG, [0]]);
  all.sort((a, b) => a[0] - b[0]);
  exif.sort((a, b) => a[0] - b[0]);

  const meta = new DataView(new ArrayBuffer(1 << 20));
  let p = 8, offsetsAt = 0, exifPtrAt = 0;
  const bytesOf = ([, type, v]) => (typeof v === 'string' ? v.length + 1 : v.length) * SZ[type];
  function writeIFD(list) {
    const start = p;
    meta.setUint16(p, list.length, true);
    let data = p + 2 + list.length * 12 + 4;
    list.forEach((e, i) => {
      const [tag, type, v] = e, n = typeof v === 'string' ? v.length + 1 : v.length, size = bytesOf(e);
      const q = start + 2 + i * 12;
      meta.setUint16(q, tag, true); meta.setUint16(q + 2, type, true); meta.setUint32(q + 4, n, true);
      let at = q + 8;
      if (size > 4) { meta.setUint32(q + 8, data, true); at = data; data += size + (size & 1); }
      if (tag === 273 || tag === 324) offsetsAt = at;
      if (tag === 34665) exifPtrAt = at;
      for (let k = 0; k < n; k++) {
        const o = at + k * SZ[type];
        if (typeof v === 'string') meta.setUint8(o, k < v.length ? v.charCodeAt(k) : 0);
        else if (type === T.BYTE || type === T.UNDEFINED) meta.setUint8(o, v[k]);
        else if (type === T.SHORT) meta.setUint16(o, v[k], true);
        else if (type === T.LONG) meta.setUint32(o, v[k], true);
        else if (type === T.FLOAT) meta.setFloat32(o, v[k], true);
        else { // (S)RATIONAL
          const den = 1e6, num = Math.round(v[k] * den);
          if (type === T.RATIONAL) { meta.setUint32(o, num, true); meta.setUint32(o + 4, den, true); }
          else { meta.setInt32(o, num, true); meta.setInt32(o + 4, den, true); }
        }
      }
    });
    meta.setUint32(start + 2 + list.length * 12, 0, true);
    p = data;
  }
  writeIFD(all);
  if (exif.length) { meta.setUint32(exifPtrAt, p, true); writeIFD(exif); }
  let off = (p + 15) & ~15;
  const parts = [new Uint8Array(meta.buffer, 0, off)];
  chunks.forEach((c, i) => { meta.setUint32(offsetsAt + i * 4, off, true); off += c.length; parts.push(c); });
  parts[0] = new Uint8Array(meta.buffer.slice(0, parts[0].length));
  parts[0].set([0x49, 0x49, 42, 0, 8, 0, 0, 0]);
  return new Blob(parts, { type: 'image/tiff' });
}

const exifEntries = src => {
  const e = [], x = src.exif || {};
  if (x[33434]) e.push([33434, T.RATIONAL, x[33434]]);
  if (x[33437]) e.push([33437, T.RATIONAL, x[33437]]);
  if (x[34855]) e.push([34855, T.SHORT, x[34855]]);
  if (x[36867]) e.push([36867, T.ASCII, x[36867]]);
  if (x[37386]) e.push([37386, T.RATIONAL, x[37386]]);
  return e;
};

const xmpPacket = attrs => `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" xmlns:GPano="http://ns.google.com/photos/1.0/panorama/" xmlns:exif="http://ns.adobe.com/exif/1.0/" xmlns:drone-dji="http://www.dji.com/drone-dji/1.0/"
${Object.entries(attrs).map(([k, v]) => ` ${k}="${v}"`).join('\n')}/>
</rdf:RDF></x:xmpmeta>
<?xpacket end="w"?>`;

export function panoXMP(width, height, isFullEquirect) {
  return isFullEquirect ? {
    'GPano:ProjectionType': 'equirectangular', 'GPano:UsePanoramaViewer': 'True',
    'GPano:FullPanoWidthPixels': width, 'GPano:FullPanoHeightPixels': height,
    'GPano:CroppedAreaImageWidthPixels': width, 'GPano:CroppedAreaImageHeightPixels': height,
    'GPano:CroppedAreaLeftPixels': 0, 'GPano:CroppedAreaTopPixels': 0,
  } : {};
}

// Copy DJI GPS/attitude attributes from the source XMP so nothing is lost downstream.
export function sourceXMP(src) {
  const out = {};
  for (const m of src.xmp.matchAll(/(drone-dji:[A-Za-z]+)="([^"]*)"/g)) out[m[1]] = m[2];
  const lat = +out['drone-dji:GpsLatitude'], lon = +out['drone-dji:GpsLongitude'];
  const dm = (v, p, n) => `${Math.floor(Math.abs(v))},${((Math.abs(v) % 1) * 60).toFixed(6)}${v >= 0 ? p : n}`;
  if (lat || lon) { out['exif:GPSLatitude'] = dm(lat, 'N', 'S'); out['exif:GPSLongitude'] = dm(lon, 'E', 'W'); }
  return out;
}

export function tiff16(width, height, image, src, xmpAttrs) {
  const xmp = new TextEncoder().encode(xmpPacket(xmpAttrs));
  return writeTIFF(width, height, image, [
    [262, T.SHORT, [2]], [271, T.ASCII, String(src.top[271] || 'Unknown')], [272, T.ASCII, src.model], [305, T.ASCII, 'DroneImageProcess'],
    [700, T.BYTE, xmp],
  ], exifEntries(src));
}

// Linear DNG: pixels are stitched *camera RGB* (not white balanced), so Lightroom keeps full WB/exposure latitude
// and renders through the original DJI profile (color matrices, hue/sat map, tone curve).
// cfa: null for LinearRaw (RGB pixels), or a 2x2 pattern (0=R 1=G 2=B) for a re-mosaiced Bayer DNG (single-channel
// pixels) that Lightroom's AI Denoise accepts.
export function linearDNG(width, height, image, src, neutral, xmpAttrs, cfa = null) {
  const xmp = new TextEncoder().encode(xmpPacket(xmpAttrs));
  const n = cfa ? 1 : 3;
  const e = [
    [254, T.LONG, [0]], [262, T.SHORT, [cfa ? 32803 : 34892]], [271, T.ASCII, String(src.top[271] || 'Unknown')], [272, T.ASCII, src.model],
    [305, T.ASCII, 'DroneImageProcess'], [700, T.BYTE, xmp],
    [50706, T.BYTE, [1, 4, 0, 0]], [50707, T.BYTE, [1, 3, 0, 0]], [50708, T.ASCII, src.model + ' (stitched)'],
    [50714, T.SHORT, new Array(n).fill(0)], [50717, T.SHORT, new Array(n).fill(65535)],
    [50728, T.RATIONAL, neutral], [50730, T.SRATIONAL, [src.baselineExposure]],
    [50778, T.SHORT, [src.illum1]], [50721, T.SRATIONAL, src.cm1],
  ];
  if (src.cm2) e.push([50779, T.SHORT, [src.illum2]], [50722, T.SRATIONAL, src.cm2]);
  if (src.toneCurve) e.push([50940, T.FLOAT, src.toneCurve]);
  if (src.hueSatMap) e.push([50937, T.LONG, src.hueSatMap.dims], [50938, T.FLOAT, src.hueSatMap.map1]);
  if (src.hueSatMap?.map2) e.push([50939, T.FLOAT, src.hueSatMap.map2]); // single-illuminant profiles (Insta360) have one map
  if (src.top[50936]) e.push([50936, T.ASCII, src.top[50936]]);
  if (cfa) e.push([33421, T.SHORT, [2, 2]], [33422, T.BYTE, cfa], [50710, T.BYTE, [0, 1, 2]], [50711, T.SHORT, [1]]);
  return writeTIFF(width, height, image, e, exifEntries(src), n);
}

// ---------- baseline JPEG, 4:4:4 ----------
// Browsers' encoders halve the color resolution (4:2:0) below quality 100, which smears fine colored edges. This is a
// plain ITU-T T.81 baseline encoder without subsampling: JFIF YCbCr, the Annex K quantization tables scaled by quality
// (IJG formula), AAN float DCT, the Annex K Huffman tables. Strips end at restart markers, so workers encode them
// independently and the caller joins them (jpegHeader + segments with RSTn between + EOI).
const ZZ = (() => { // zigzag: natural index of each coefficient in scan order
  const z = [];
  for (let s = 0; s < 15; s++) for (let i = 0; i <= s; i++) {
    const [r, c] = s & 1 ? [i, s - i] : [s - i, i];
    if (r < 8 && c < 8) z.push(r * 8 + c);
  }
  return z;
})();
const QL = [16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99];
const QC = [17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99,
  ...new Array(32).fill(99)];
const AC_L = [1, 2, 3, 0, 4, 17, 5, 18, 33, 49, 65, 6, 19, 81, 97, 7, 34, 113, 20, 50, 129, 145, 161, 8, 35, 66, 177, 193, 21, 82, 209, 240,
  36, 51, 98, 114, 130, 9, 10, 22, 23, 24, 25, 26, 37, 38, 39, 40, 41, 42, 52, 53, 54, 55, 56, 57, 58, 67, 68, 69, 70, 71, 72, 73, 74, 83, 84,
  85, 86, 87, 88, 89, 90, 99, 100, 101, 102, 103, 104, 105, 106, 115, 116, 117, 118, 119, 120, 121, 122, 131, 132, 133, 134, 135, 136, 137,
  138, 146, 147, 148, 149, 150, 151, 152, 153, 154, 162, 163, 164, 165, 166, 167, 168, 169, 170, 178, 179, 180, 181, 182, 183, 184, 185, 186,
  194, 195, 196, 197, 198, 199, 200, 201, 202, 210, 211, 212, 213, 214, 215, 216, 217, 218, 225, 226, 227, 228, 229, 230, 231, 232, 233, 234,
  241, 242, 243, 244, 245, 246, 247, 248, 249, 250];
const AC_C = [0, 1, 2, 3, 17, 4, 5, 33, 49, 6, 18, 65, 81, 7, 97, 113, 19, 34, 50, 129, 8, 20, 66, 145, 161, 177, 193, 9, 35, 51, 82, 240, 21,
  98, 114, 209, 10, 22, 36, 52, 225, 37, 241, 23, 24, 25, 26, 38, 39, 40, 41, 42, 53, 54, 55, 56, 57, 58, 67, 68, 69, 70, 71, 72, 73, 74, 83,
  84, 85, 86, 87, 88, 89, 90, 99, 100, 101, 102, 103, 104, 105, 106, 115, 116, 117, 118, 119, 120, 121, 122, 130, 131, 132, 133, 134, 135,
  136, 137, 138, 146, 147, 148, 149, 150, 151, 152, 153, 154, 162, 163, 164, 165, 166, 167, 168, 169, 170, 178, 179, 180, 181, 182, 183, 184,
  185, 186, 194, 195, 196, 197, 198, 199, 200, 201, 202, 210, 211, 212, 213, 214, 215, 216, 217, 218, 226, 227, 228, 229, 230, 231, 232, 233,
  234, 242, 243, 244, 245, 246, 247, 248, 249, 250];
// [class/id, bits per code length 1..16, values]
const HUFF = [
  [0x00, [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]],
  [0x10, [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 125], AC_L],
  [0x01, [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]],
  [0x11, [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 119], AC_C],
];
const huffCodes = ([, bits, vals]) => { // canonical codes: value -> [code, length]
  const t = []; let code = 0, k = 0;
  bits.forEach((n, i) => { for (let j = 0; j < n; j++) t[vals[k++]] = [code++, i + 1]; code <<= 1; });
  return t;
};
const [DCL, ACL, DCC, ACC] = HUFF.map(huffCodes);
const quantTables = quality => {
  const s = quality < 50 ? 5000 / quality : 200 - 2 * quality;
  return [QL, QC].map(q => q.map(v => Math.min(255, Math.max(1, Math.floor((v * s + 50) / 100)))));
};
const AAN = [1, 1.387039845, 1.306562965, 1.175875602, 1, 0.785694958, 0.5411961, 0.275899379];

// Header up to and including SOS: SOI, JFIF, XMP (when given), DQT, SOF0 (1x1 sampling for all three), DHT, DRI.
export function jpegHeader(width, height, quality, restart, xmpAttrs) {
  const b = [], seg = (m, body) => b.push(0xFF, m, (body.length + 2) >> 8, (body.length + 2) & 255, ...body);
  const be = v => [v >> 8, v & 255];
  b.push(0xFF, 0xD8);
  seg(0xE0, [74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const parts = [new Uint8Array(b)];
  b.length = 0;
  if (xmpAttrs) {
    const x = new TextEncoder().encode('http://ns.adobe.com/xap/1.0/\0' + xmpPacket(xmpAttrs));
    parts.push(new Uint8Array([0xFF, 0xE1, (x.length + 2) >> 8, (x.length + 2) & 255]), x);
  }
  const [ql, qc] = quantTables(quality);
  seg(0xDB, [0, ...ZZ.map(i => ql[i]), 1, ...ZZ.map(i => qc[i])]);
  seg(0xC0, [8, ...be(height), ...be(width), 3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1]);
  seg(0xC4, HUFF.flatMap(([id, bits, vals]) => [id, ...bits, ...vals]));
  seg(0xDD, be(restart));
  seg(0xDA, [3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 63, 0]);
  parts.push(new Uint8Array(b));
  return parts;
}

// One restart interval: `rows` (8 | rows, except the last strip) x width RGBA pixels -> entropy-coded bytes, padded.
export function encodeJpegStrip(rgba, width, rows, quality) {
  const [ql, qc] = quantTables(quality), fl = new Float32Array(64), fc = new Float32Array(64);
  for (let i = 0; i < 64; i++) { const a = 1 / (AAN[i >> 3] * AAN[i & 7] * 8); fl[i] = a / ql[i]; fc[i] = a / qc[i]; }
  let out = new Uint8Array(Math.max(4096, width * rows)), n = 0, acc = 0, nb = 0;
  const put = (code, len) => {
    acc = (acc << len) | code; nb += len;
    while (nb >= 8) {
      const v = (acc >> (nb - 8)) & 255; nb -= 8; acc &= (1 << nb) - 1;
      if (n + 2 > out.length) { const o = new Uint8Array(out.length * 2); o.set(out); out = o; }
      out[n++] = v; if (v === 255) out[n++] = 0; // byte stuffing
    }
  };
  const blk = [new Float32Array(64), new Float32Array(64), new Float32Array(64)], q = new Int32Array(64), pred = [0, 0, 0];
  const dct = d => {
    for (let p = 0; p < 64; p += 8) dct8(d, p, 1);
    for (let p = 0; p < 8; p++) dct8(d, p, 8);
  };
  const code = (d, comp) => { // comp 0 = Y, 1 = Cb, 2 = Cr: own DC predictor each, chroma tables for 1 and 2
    dct(d);
    const c = comp > 0, f = c ? fc : fl, dc = c ? DCC : DCL, ac = c ? ACC : ACL;
    for (let i = 0; i < 64; i++) q[i] = Math.round(d[ZZ[i]] * f[ZZ[i]]);
    const bits = v => { let a = Math.abs(v), s = 0; while (a) { s++; a >>= 1; } return s; };
    const diff = q[0] - pred[comp]; pred[comp] = q[0];
    let s = bits(diff); put(...dc[s]); if (s) put(diff < 0 ? diff - 1 + (1 << s) : diff, s);
    let run = 0;
    for (let i = 1; i < 64; i++) {
      if (!q[i]) { run++; continue; }
      while (run > 15) { put(...ac[0xF0]); run -= 16; }
      s = bits(q[i]); put(...ac[(run << 4) | s]); put(q[i] < 0 ? q[i] - 1 + (1 << s) : q[i], s); run = 0;
    }
    if (run) put(...ac[0]);
  };
  for (let by = 0; by < rows; by += 8) for (let bx = 0; bx < width; bx += 8) {
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const i = (Math.min(by + y, rows - 1) * width + Math.min(bx + x, width - 1)) * 4, r = rgba[i], g = rgba[i + 1], b = rgba[i + 2], k = y * 8 + x;
      blk[0][k] = 0.299 * r + 0.587 * g + 0.114 * b - 128;
      blk[1][k] = -0.168736 * r - 0.331264 * g + 0.5 * b;
      blk[2][k] = 0.5 * r - 0.418688 * g - 0.081312 * b;
    }
    code(blk[0], 0); code(blk[1], 1); code(blk[2], 2);
  }
  if (nb) put((1 << (8 - nb)) - 1, 8 - nb); // pad the last byte with 1s
  return out.slice(0, n);
}
// AAN float forward DCT on 8 values at d[p + k*s] (jfdctflt), in place; the 1/8 and AAN factors go into the quantizer
function dct8(d, p, s) {
  const d0 = d[p], d1 = d[p + s], d2 = d[p + 2 * s], d3 = d[p + 3 * s], d4 = d[p + 4 * s], d5 = d[p + 5 * s], d6 = d[p + 6 * s], d7 = d[p + 7 * s];
  const t0 = d0 + d7, t7 = d0 - d7, t1 = d1 + d6, t6 = d1 - d6, t2 = d2 + d5, t5 = d2 - d5, t3 = d3 + d4, t4 = d3 - d4;
  const t10 = t0 + t3, t13 = t0 - t3, t11 = t1 + t2, t12 = t1 - t2;
  d[p] = t10 + t11; d[p + 4 * s] = t10 - t11;
  const z1 = (t12 + t13) * 0.707106781;
  d[p + 2 * s] = t13 + z1; d[p + 6 * s] = t13 - z1;
  const u10 = t4 + t5, u11 = t5 + t6, u12 = t6 + t7;
  const z5 = (u10 - u12) * 0.382683433, z2 = 0.5411961 * u10 + z5, z4 = 1.306562965 * u12 + z5, z3 = u11 * 0.707106781;
  const z11 = t7 + z3, z13 = t7 - z3;
  d[p + 5 * s] = z13 + z2; d[p + 3 * s] = z13 - z2; d[p + s] = z11 + z4; d[p + 7 * s] = z11 - z4;
}
