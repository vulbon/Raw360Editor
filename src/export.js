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
export const strips = (pixels, width, height, spp, rows = 64) => ({ rows, strips: Array.from({ length: Math.ceil(height / rows) }, (_, i) =>
  new Uint8Array(pixels.buffer, pixels.byteOffset + i * rows * width * spp * 2, Math.min(rows, height - i * rows) * width * spp * 2)) });

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

export async function jpegWithXMP(blob, xmpAttrs) {
  const jpg = new Uint8Array(await blob.arrayBuffer());
  const body = new TextEncoder().encode('http://ns.adobe.com/xap/1.0/\0' + xmpPacket(xmpAttrs));
  const seg = new Uint8Array(4 + body.length);
  seg.set([0xFF, 0xE1, (body.length + 2) >> 8, (body.length + 2) & 255]);
  seg.set(body, 4);
  return new Blob([jpg.subarray(0, 2), seg, jpg.subarray(2)], { type: 'image/jpeg' });
}
