// This product includes DNG technology under license by Adobe.
// DNG reader: TIFF IFDs + lossless JPEG (LJ92) + the tags the pipeline needs.

const SIZES = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4 };

function readIFDs(buf) {
  const dv = new DataView(buf);
  const le = dv.getUint8(0) === 0x49;
  const u16 = o => dv.getUint16(o, le), u32 = o => dv.getUint32(o, le);
  const ifds = [];
  function value(type, count, off) {
    if (type === 2) return new TextDecoder('latin1').decode(new Uint8Array(buf, off, count)).replace(/\0+$/, '');
    if (type === 1 || type === 7 || type === 6) return new Uint8Array(buf.slice(off, off + count)); // copy: views would drag the whole file through postMessage
    const out = new Array(count);
    for (let i = 0; i < count; i++) {
      const p = off + i * SIZES[type];
      out[i] = type === 3 ? u16(p) : type === 4 || type === 13 ? u32(p) : type === 8 ? dv.getInt16(p, le)
        : type === 9 ? dv.getInt32(p, le) : type === 5 ? u32(p) / u32(p + 4)
        : type === 10 ? dv.getInt32(p, le) / dv.getInt32(p + 4, le) : type === 11 ? dv.getFloat32(p, le) : dv.getFloat64(p, le);
    }
    return out;
  }
  function walk(off, isTop) {
    while (off) {
      const n = u16(off), tags = {};
      for (let i = 0; i < n; i++) {
        const e = off + 2 + i * 12, tag = u16(e), type = u16(e + 2), count = u32(e + 4);
        if (!SIZES[type]) continue;
        const vo = SIZES[type] * count <= 4 ? e + 8 : u32(e + 8);
        tags[tag] = value(type, count, vo);
      }
      ifds.push(tags);
      if (tags[330]) for (const s of tags[330]) walk(s, false);
      if (tags[34665]) walk(tags[34665][0], false);
      off = isTop ? u32(off + 2 + n * 12) : 0;
    }
  }
  walk(u32(4), true);
  return ifds;
}

// Lossless JPEG (SOF3), any predictor, N interleaved components. Returns samples in scan order.
export function decodeLJ92(bytes) {
  let p = 2, W, H, comps, prec, pred, pt;
  const tables = [], compTable = [];
  for (;;) {
    const m = bytes[p + 1], L = (bytes[p + 2] << 8) | bytes[p + 3];
    if (m === 0xC3) {
      prec = bytes[p + 4]; H = (bytes[p + 5] << 8) | bytes[p + 6]; W = (bytes[p + 7] << 8) | bytes[p + 8]; comps = bytes[p + 9];
    } else if (m === 0xC4) {
      let q = p + 4;
      while (q < p + 2 + L) {
        const th = bytes[q] & 15, counts = bytes.subarray(q + 1, q + 17);
        // 16-bit direct lookup: entry = (len << 8) | symbol
        const lut = new Uint32Array(65536);
        let code = 0, s = q + 17;
        for (let len = 1; len <= 16; len++) {
          for (let k = 0; k < counts[len - 1]; k++, code++) {
            const lo = code << (16 - len), hi = lo + (1 << (16 - len));
            lut.fill((len << 8) | bytes[s++], lo, hi);
          }
          code <<= 1;
        }
        tables[th] = lut;
        q = s;
      }
    } else if (m === 0xDA) {
      const ns = bytes[p + 4];
      for (let i = 0; i < ns; i++) compTable[i] = tables[bytes[p + 6 + i * 2] >> 4];
      pred = bytes[p + 5 + ns * 2]; pt = bytes[p + 7 + ns * 2] & 15;
      p += 2 + L;
      break;
    } else if (m === 0xC0 || m === 0xC1 || m === 0xC2) throw new Error('Not a lossless JPEG');
    p += 2 + L;
  }

  // Hot loop: everything inline in locals (no per-sample closures). The bit buffer holds ≤ 32 bits; refilling while
  // ≤ 24 are left guarantees a whole Huffman code (≤ 16 bits); extra bits (≤ 15) may need a second refill.
  const out = new Uint16Array(W * H * comps), n = bytes.length, row = W * comps, init = 1 << (prec - pt - 1);
  let bitbuf = 0, bitcnt = 0, pos = p;
  for (let y = 0, i = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      for (let c = 0; c < comps; c++, i++) {
        while (bitcnt <= 24) {
          let byte = 0; // 0xFF00 is a stuffed 0xFF; 0xFF + anything else is a marker: feed zeros from there on
          if (pos < n) { byte = bytes[pos]; if (byte !== 0xFF) pos++; else if (bytes[pos + 1] === 0) pos += 2; else byte = 0; }
          bitbuf = (bitbuf << 8) | byte; bitcnt += 8;
        }
        const e = compTable[c][(bitbuf >>> (bitcnt - 16)) & 0xFFFF], s = e & 0xFF;
        bitcnt -= e >> 8;
        let dv = 0;
        if (s === 16) dv = 32768;
        else if (s) {
          while (bitcnt < s) {
            let byte = 0;
            if (pos < n) { byte = bytes[pos]; if (byte !== 0xFF) pos++; else if (bytes[pos + 1] === 0) pos += 2; else byte = 0; }
            bitbuf = (bitbuf << 8) | byte; bitcnt += 8;
          }
          dv = (bitbuf >>> (bitcnt - s)) & ((1 << s) - 1);
          bitcnt -= s;
          if (dv < 1 << (s - 1)) dv -= (1 << s) - 1;
        }
        let P;
        if (y === 0) P = x === 0 ? init : out[i - comps];
        else if (x === 0) P = out[i - row];
        else {
          const A = out[i - comps], B = out[i - row], C = out[i - row - comps];
          P = pred === 1 ? A : pred === 6 ? B + ((A - C) >> 1) : pred === 2 ? B : pred === 3 ? C : pred === 4 ? A + B - C
            : pred === 5 ? A + ((B - C) >> 1) : (A + B) >> 1;
        }
        out[i] = (P + dv) & 0xFFFF;
      }
    }
  }
  if (pt) for (let i = 0; i < out.length; i++) out[i] <<= pt;
  return { data: out, width: W, height: H, comps };
}

// Opcode lists: GainMap (9) and WarpRectilinear (1). Big-endian per spec.
function parseOpcodes(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = dv.getUint32(0), ops = { gainMaps: [] };
  let p = 4;
  for (let k = 0; k < n; k++) {
    const id = dv.getUint32(p), size = dv.getUint32(p + 12), d = p + 16;
    if (id === 1) {
      const planes = dv.getUint32(d), coef = [];
      for (let i = 0; i < planes; i++) coef.push([0, 1, 2, 3, 4, 5].map(j => dv.getFloat64(d + 4 + (i * 6 + j) * 8)));
      const c = d + 4 + planes * 48;
      ops.warp = { coef, cx: dv.getFloat64(c), cy: dv.getFloat64(c + 8) };
    } else if (id === 9) {
      const g = { top: dv.getUint32(d), left: dv.getUint32(d + 4), bottom: dv.getUint32(d + 8), right: dv.getUint32(d + 12),
        plane: dv.getUint32(d + 16), planes: dv.getUint32(d + 20), rowPitch: dv.getUint32(d + 24), colPitch: dv.getUint32(d + 28),
        rows: dv.getUint32(d + 32), cols: dv.getUint32(d + 36),
        spacingV: dv.getFloat64(d + 40), spacingH: dv.getFloat64(d + 48), originV: dv.getFloat64(d + 56), originH: dv.getFloat64(d + 64),
        mapPlanes: dv.getUint32(d + 72) };
      g.data = new Float32Array(g.rows * g.cols * g.mapPlanes);
      for (let i = 0; i < g.data.length; i++) g.data[i] = dv.getFloat32(d + 76 + i * 4);
      ops.gainMaps.push(g);
    }
    p = d + size;
  }
  return ops;
}

export function parseDNG(buf) {
  const ifds = readIFDs(buf), top = ifds[0];
  // CFA (camera raw) or LinearRaw (e.g. Lightroom "Enhanced" denoised DNG, already demosaiced)
  const raw = ifds.find(t => t[254]?.[0] === 0 && (t[262]?.[0] === 32803 || t[262]?.[0] === 34892));
  if (!raw) throw new Error('No CFA / LinearRaw image in this DNG');
  const spp = raw[277]?.[0] ?? 1;
  const W = raw[256][0], H = raw[257][0], comp = raw[259][0];
  const tiled = !!raw[324];
  const offs = raw[324] || raw[273], counts = raw[325] || raw[279];
  const tw = tiled ? raw[322][0] : W, th = tiled ? raw[323][0] : (raw[278]?.[0] || H);
  const img = new Uint16Array(W * H * spp), bytes = new Uint8Array(buf);
  const across = Math.ceil(W / tw), bigEndian = bytes[0] === 0x4D;
  if (comp !== 7 && comp !== 1) throw new Error('Unsupported DNG compression ' + comp);
  if (comp === 1 && raw[258][0] !== 16) throw new Error('Only 16-bit uncompressed DNG supported');
  offs.forEach((off, t) => {
    const x0 = (t % across) * tw, y0 = Math.floor(t / across) * th;
    let src;
    if (comp === 7) src = decodeLJ92(bytes.subarray(off, off + counts[t])).data;
    else {
      src = new Uint16Array(buf.slice(off, off + counts[t]));
      if (bigEndian) for (let i = 0; i < src.length; i++) src[i] = (src[i] >> 8) | ((src[i] & 255) << 8);
    }
    for (let y = 0; y < th && y0 + y < H; y++) {
      const n = Math.min(tw, W - x0) * spp;
      img.set(src.subarray(y * tw * spp, y * tw * spp + n), ((y0 + y) * W + x0) * spp);
    }
  });

  const xmp = top[700] ? new TextDecoder().decode(top[700]) : '';
  const xmpVal = k => xmp.match(new RegExp(k + '="([^"]*)"'))?.[1];
  const ops = raw[51022] ? parseOpcodes(raw[51022]) : {};
  const black = raw[50714] ? raw[50714].reduce((a, b) => a + b) / raw[50714].length : 0;
  let white = raw[50717]?.[0] ?? 65535;
  // OpcodeList2 gain maps (lens shading, per CFA phase) belong to the raw data: apply them here, once, for every use.
  const maps2 = raw[51009] ? parseOpcodes(raw[51009]).gainMaps : [];
  const cfa = spp === 1 ? Array.from(raw[33422]) : null;
  const noise = raw[51041] || top[51041] || (cfa && estimateNoise(img, W, H, cfa, black, white)); // before gain maps: dark corners
  const clip = Math.min(white, 65535); // raw at or above this is clipped (gain maps below keep such pixels at 65535)
  if (spp === 1 && maps2.length) white = applyGainMaps(img, W, H, maps2, black, white);
  const exif = ifds.find(t => t[33434]) || {};
  const hsm = top[50938] && { dims: top[50937], map1: top[50938], map2: top[50939] };
  return {
    width: W, height: H, raw: img, channels: spp,
    cfa, // 2x2, 0=R 1=G 2=B
    black, white, clip,
    model: top[50708] || top[272] || '', product: xmpVal('drone-dji:ProductName') || '',
    cm1: top[50721], cm2: top[50722], illum1: top[50778]?.[0] ?? 21, illum2: top[50779]?.[0],
    neutral: top[50728] || [1, 1, 1],
    baselineExposure: top[50730]?.[0] ?? 0,
    noise, // NoiseProfile (variance = S·x + O, first plane pair), or estimated from the image
    toneCurve: top[50940] || null, hueSatMap: hsm || null,
    warp: ops.warp || null, insta: instaCalibration(exif), gravity: instaGravity(buf), exif, top, xmp,
  };
}

// No NoiseProfile tag (Insta360): estimate variance = S·x + O, x normalized to black..white like the tag. Per square
// fisheye tile (one, or two side by side): read noise O from the corners outside the image circle (no light reaches
// them), then the shot-noise slope S from 16×16 green blocks in the tile's central half, keeping per brightness bin the
// quietest 20% (flat sky, walls; texture only adds variance). Noise per block: MAD of differences between same-color
// neighbours two pixels apart, where smooth signal cancels. measureNoise() in develop.js corrects the overall scale on
// the real data later, so this mainly has to get the split between shot and read noise right.
function estimateNoise(img, W, H, cfa, black, white) {
  const k = 1 / (white - black), g0 = [0, 1, 2, 3].find(i => cfa[i] === 1), oy = g0 >> 1, ox = g0 & 1;
  const blockStats = (x0, y0, w, h) => {
    const diff = [], vals = [];
    for (let y = y0 + oy; y < y0 + h; y += 2) for (let x = x0 + ox; x < x0 + w; x += 2) {
      const v = (img[y * W + x] - black) * k; vals.push(v); diff.push(v - (img[y * W + x + 2] - black) * k);
    }
    diff.sort((a, b) => a - b);
    const med = diff[diff.length >> 1], mad = diff.map(v => Math.abs(v - med)).sort((a, b) => a - b)[diff.length >> 1];
    return [vals.reduce((a, b) => a + b, 0) / vals.length, (1.4826 * mad) ** 2 / 2];
  };
  const T = W === 2 * H ? H : Math.min(W, H), tiles = W === 2 * H ? [0, H] : [(W - T) >> 1], B = 32, C = 96, dark = [], pts = [];
  for (const tx of tiles) {
    for (const [cx, cy] of [[0, 0], [T - C - 2, 0], [0, T - C], [T - C - 2, T - C]]) {
      const [m, v] = blockStats(tx + cx, cy, C, C);
      if (m < 0.003) dark.push(v); // really dark: a corner outside the image circle
    }
    for (let y = T >> 2 & ~1; y + B <= 3 * T >> 2; y += B) for (let x = T >> 2 & ~1; x + B + 2 <= 3 * T >> 2; x += B) {
      const [m, v] = blockStats(tx + x, y, B, B);
      if (m > 0.004 && m < 0.8) pts.push([m, v]);
    }
  }
  dark.sort((a, b) => a - b);
  const O = dark.length ? dark[dark.length >> 1] : 1e-8;
  const bins = new Map();
  for (const [m, v] of pts) { const b = Math.round(Math.log2(m) * 3); if (!bins.has(b)) bins.set(b, []); bins.get(b).push([m, v]); }
  let sxy = 0, sxx = 0;
  for (const list of bins.values()) {
    if (list.length < 8) continue;
    list.sort((p, q) => p[1] - q[1]);
    const q = list.slice(0, Math.max(2, Math.round(list.length * 0.2))), m = q.reduce((a, p) => a + p[0], 0) / q.length, v = q.reduce((a, p) => a + p[1], 0) / q.length;
    sxy += m * Math.max(0, v - O); sxx += m * m; // line through (0, O)
  }
  return sxx ? [Math.max(1e-7, sxy / sxx), Math.max(1e-9, O)] : null;
}

// DNG GainMap on 16-bit raw: value = black + (value − black)·gain, bilinear in the map, whose origin and spacing are
// relative to the whole image. Gains reach ~2.4 at a fisheye rim, so the whole image (maps may cover only part of it)
// is first scaled by 1/max gain to stay in 16 bits (the data is 12–14 bit, so no real precision is lost) and the white
// level moves down to match. Clipped pixels go to 65535, above any scaled value, so they stay recognisable.
function applyGainMaps(img, W, H, maps, black, white) {
  const gmax = Math.max(1, ...maps.map(m => m.data.reduce((a, b) => Math.max(a, b), 0)));
  for (let i = 0; i < img.length; i++) img[i] = img[i] >= white ? 65535 : Math.max(0, Math.round(black + (img[i] - black) / gmax));
  for (const m of maps) {
    const bottom = Math.min(m.bottom, H), right = Math.min(m.right, W), gRow = new Float32Array(m.cols);
    for (let y = m.top; y < bottom; y += m.rowPitch) {
      const v = Math.min(Math.max((y / H - m.originV) / m.spacingV, 0), m.rows - 1), r0 = Math.floor(v), r1 = Math.min(r0 + 1, m.rows - 1), fv = v - r0;
      for (let c = 0; c < m.cols; c++) gRow[c] = m.data[(r0 * m.cols + c) * m.mapPlanes] * (1 - fv) + m.data[(r1 * m.cols + c) * m.mapPlanes] * fv;
      for (let x = m.left; x < right; x += m.colPitch) {
        const h = Math.min(Math.max((x / W - m.originH) / m.spacingH, 0), m.cols - 1), c0 = Math.floor(h), c1 = Math.min(c0 + 1, m.cols - 1);
        const g = gRow[c0] + (gRow[c1] - gRow[c0]) * (h - c0), i = y * W + x;
        if (img[i] !== 65535) img[i] = Math.max(0, Math.min(65534, Math.round(black + (img[i] - black) * g)));
      }
    }
  }
  return black + (white - black) / gmax;
}

// Insta360 per-shot lens calibration ("offset"), written in EXIF UserComment / MakerNote as "…2_<lens 1>_<lens 2>…".
// Per lens: xi fx fy cx cy yaw pitch roll tx ty tz k1 k2 k3 p1 p2 calibW calibH lensType — the unified (Mei)
// omnidirectional model with radial-tangential distortion, in a calibW×calibH frame holding both lenses side by side.
const INSTA_KEYS = ['xi', 'fx', 'fy', 'cx', 'cy', 'yaw', 'pitch', 'roll', 'tx', 'ty', 'tz', 'k1', 'k2', 'k3', 'p1', 'p2', 'calibW', 'calibH', 'type'];
function instaCalibration(exif) {
  for (const tag of [37510, 37500]) {
    const b = exif[tag];
    if (!b) continue;
    const m = String.fromCharCode(...b).match(/(?:^|INSTA360|[^\d])2_((?:-?[\d.]+_){37}-?[\d.]+)/);
    if (!m) continue;
    const v = m[1].split('_').map(Number);
    return [0, 1].map(i => Object.fromEntries(INSTA_KEYS.map((k, j) => [k, v[i * INSTA_KEYS.length + j]])));
  }
  return null;
}

// Insta360 trailer (ends with an ASCII magic): records stored back to front, each followed by u16 id + u32 size.
// Record 0x300 is the IMU at 1 kHz: u64 time, then accelerometer and gyro as 3 + 3 offset-binary u16 (1 g ≈ 1024).
// Returns the accelerometer (sensor axes, points up at rest) averaged over the stillest 0.2 s, or null.
function instaGravity(buf) {
  const b = new Uint8Array(buf), n = b.length, MAGIC = '8db42d694ccc418790edff439fe026bf';
  if (n < 80 || String.fromCharCode(...b.subarray(n - 32)) !== MAGIC) return null;
  const dv = new DataView(buf);
  for (let pos = n - 72; pos > n - 4e6;) {
    const id = dv.getUint16(pos - 6, true), size = dv.getUint32(pos - 4, true), start = pos - 6 - size;
    if (start < 0 || id > 0x2000) return null;
    if (id === 0x300) {
      const k = Math.floor(size / 20), v = i => [0, 1, 2, 3, 4, 5].map(c => dv.getUint16(start + i * 20 + 8 + c * 2, true) - 32768), W = 200;
      if (k < W) return null;
      const s = Array.from({ length: k }, (_, i) => v(i)), spin = s.map(x => Math.hypot(x[3], x[4], x[5]));
      let best = 0, bestSum = Infinity, run = spin.slice(0, W).reduce((a, x) => a + x, 0);
      for (let i = W; i <= k; i++) { if (run < bestSum) { bestSum = run; best = i - W; } if (i < k) run += spin[i] - spin[i - W]; }
      const g = [0, 1, 2].map(c => s.slice(best, best + W).reduce((a, x) => a + x[c], 0) / W);
      return Math.abs(Math.hypot(...g) / 1024 - 1) < 0.25 ? g : null; // not ~1 g: the camera was moving
    }
    pos = start;
  }
  return null;
}

// One image holding both fisheyes side by side (Insta360): two lens images, left first.
export function splitDual(d) {
  const S = d.height;
  return [0, 1].map(i => {
    const raw = new Uint16Array(S * S);
    for (let y = 0; y < S; y++) raw.set(d.raw.subarray(y * d.width + i * S, y * d.width + i * S + S), y * S);
    return { ...d, width: S, raw, dualIndex: i };
  });
}
