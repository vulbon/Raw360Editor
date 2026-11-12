// Browser regression helpers (dev only). Open src/index.html?load=<any shot> (that exposes window.__dbg), then in the
// console: const R = await import('/test/regress.js'); await R.shot('ref/avata 360/DJI_..._UP.DNG', '..._DOWN.DNG').
// Everything is measured from real exports, so it covers develop, stitch, tone and the encoders together.
const D = () => window.__dbg;
const wait = ms => new Promise(r => setTimeout(r, ms));
const busy = () => document.getElementById('busy').open;
export async function idle(limit = 120000) { const t = performance.now(); await wait(300); while (busy() && performance.now() - t < limit) await wait(100); }

// open a shot (paths relative to the site root) the way a drop does; returns timings, alignment score, status line
export async function shot(...paths) {
  const files = await Promise.all(paths.map(async p => new File([await (await fetch('/' + p.replace(/^\//, ''))).blob()], p.split('/').pop())));
  await idle(); // load() refuses while anything is still running
  const t0 = performance.now();
  await D().load(files); await idle();
  return { s: +((performance.now() - t0) / 1000).toFixed(1), ncc: +D().alignNCC.toFixed(3), timing: D().timing, status: document.getElementById('status').textContent };
}

// export through the dialog (so its limits apply); returns the Blob
export async function exportBlob(fmt = 'jpeg', width) {
  const urls = []; const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () { urls.push(this.href); };
  try {
    document.getElementById('export-btn').click(); await wait(200);
    const f = document.getElementById('fmt'); f.value = fmt; f.dispatchEvent(new Event('input', { bubbles: true }));
    if (width) { const ew = document.getElementById('ew'); ew.value = width; ew.dispatchEvent(new Event('input', { bubbles: true })); }
    const t0 = performance.now();
    document.querySelector('#export-dlg button[value=export]').click();
    while (!urls.length && performance.now() - t0 < 300000) await wait(200);
    if (!urls.length) throw new Error('export did not finish: ' + document.getElementById('status').textContent);
    const blob = await (await fetch(urls[0])).blob(); blob.seconds = +((performance.now() - t0) / 1000).toFixed(1);
    return blob;
  } finally { HTMLAnchorElement.prototype.click = click; await idle(); }
}

export async function pixels(src, W, H) { // Blob or URL -> RGBA bytes at W x H
  const b = typeof src === 'string' ? await (await fetch(src)).blob() : src;
  const bm = await createImageBitmap(b, W ? { resizeWidth: W, resizeHeight: H, resizeQuality: 'high' } : {});
  const c = new OffscreenCanvas(bm.width, bm.height), x = c.getContext('2d'); x.drawImage(bm, 0, 0);
  return { d: x.getImageData(0, 0, bm.width, bm.height).data, W: bm.width, H: bm.height };
}

// L* percentiles (10/50/90/99), mean Lab chroma, cos-latitude weighted (equirect), and mean |Laplacian| of green (detail)
export function stats({ d, W, H }, equirect = true) {
  const L = [], lin = v => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4), f = t => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  let sc = 0, sw = 0, lap = 0, nl = 0;
  for (let y = 0; y < H; y++) {
    const w = equirect ? Math.cos(((y + 0.5) / H - 0.5) * Math.PI) : 1;
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4, r = lin(d[o]), g = lin(d[o + 1]), b = lin(d[o + 2]);
      const fx = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.9505), fy = f(0.2126 * r + 0.7152 * g + 0.0722 * b), fz = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.089);
      L.push([116 * fy - 16, w]); sc += Math.hypot(500 * (fx - fy), 200 * (fy - fz)) * w; sw += w;
      if (x > 0 && y > 0 && x < W - 1 && y < H - 1) { lap += Math.abs(4 * d[o + 1] - d[o - 3] - d[o + 5] - d[o + 1 - 4 * W] - d[o + 1 + 4 * W]); nl++; }
    }
  }
  L.sort((a, b) => a[0] - b[0]);
  const pc = p => { let acc = 0; for (const [v, w] of L) if ((acc += w) >= p * sw) return +v.toFixed(1); return 100; };
  return { L10: pc(0.1), L50: pc(0.5), L90: pc(0.9), L99: pc(0.99), chroma: +(sc / sw).toFixed(1), detail: +(lap / nl).toFixed(2) };
}

// seam check on an equirect export: mean |difference| between the rows just above and below each lens seam would need
// the seam position, so instead compare our equirect against the camera's own stitched JPG after a best yaw shift:
// a low residual means geometry (lens model, alignment, leveling) agrees with the camera's.
export function geomMatch(a, b) { // both { d, W, H } equirect at the same size; returns best yaw shift and residual
  const lum = ({ d, W, H }) => { const o = new Float32Array(W * H); for (let i = 0; i < W * H; i++) o[i] = 0.2126 * d[4 * i] + 0.7152 * d[4 * i + 1] + 0.0722 * d[4 * i + 2]; return o; };
  const { W, H } = a, y0 = Math.round(H / 6), y1 = Math.round(5 * H / 6), band = v => v.subarray(y0 * W, y1 * W); // ±60° latitude
  const A = lum(a), B = lum(b), norm = v => { let m = 0; for (const x of v) m += x; m /= v.length; let s = 0; for (const x of v) s += (x - m) ** 2; return [m, Math.sqrt(s / v.length)]; };
  const [ma, sa] = norm(band(A)), [mb, sb] = norm(band(B)); let best = [-1, 0];
  for (let s = 0; s < W; s += 2) { // yaw shift in columns; rows within ±60° latitude
    let c = 0, n = 0;
    for (let y = y0; y < y1; y += 2) for (let x = 0; x < W; x += 2) { c += (A[y * W + x] - ma) * (B[y * W + (x + s) % W] - mb); n++; }
    c /= n * sa * sb; if (c > best[0]) best = [c, s];
  }
  return { corr: +best[0].toFixed(3), yawDeg: +(best[1] / W * 360).toFixed(1) };
}

// 360° wrap check (equirect): the same meridian exported once at the picture's edge (yaw 0) and once in its middle
// (yaw 180) must show the same brightness step across it; a difference is a line at the wrap (local tone, any filter
// that does not wrap). Returns the worst and mean difference in 8-bit levels over 32-row blocks: 0 is right.
export async function wrapSeam(width = 2048) {
  const steps = async yaw => {
    set('yaw', yaw); await idle();
    const { d, W, H } = await pixels(await exportBlob('jpeg', width)), x0 = yaw ? W / 2 : 0, out = [];
    const lum = (x, y) => { const o = (y * W + (x + W) % W) * 4; return 0.2126 * d[o] + 0.7152 * d[o + 1] + 0.0722 * d[o + 2]; };
    for (let y0 = 0; y0 + 32 <= H; y0 += 32) {
      let a = 0, b = 0;
      for (let y = y0; y < y0 + 32; y++) for (let k = 0; k < 8; k++) { a += lum(x0 + k, y); b += lum(x0 - 1 - k, y); }
      out.push((a - b) / 256);
    }
    return out;
  };
  const a = await steps(0), b = await steps(180), diff = a.map((v, i) => Math.abs(v - b[i]));
  set('yaw', 0); await idle();
  return { max: +Math.max(...diff).toFixed(2), mean: +(diff.reduce((x, y) => x + y) / diff.length).toFixed(2) };
}

// Lateral CA left in the developed lens images of the loaded shot (offline calibration of config.js `ca`; nothing here
// runs in the app). Each lens is developed from its full raw with the DNG warp plus `res` (per lens { R: [r², r⁴],
// B: [...] }; omit for the DNG warp alone), then bright→dark edges are collected along y where y is nearly radial
// (|x − cx| < 0.3 rmax; contrast ≥ 3:1, flat on both sides, nothing clipped). Per radial zone: the area between a
// color's normalized edge profile and green's = that color's shift in px, + = outward (dark side outward: +shift,
// inward: −shift, averaged by edge count). Returns per lens [{ r, n, R, B }]. To cancel a shift d at radius r add
// d / r to the radial scale there (scale = a·rn² + b·rn⁴, rn = r / half the image diagonal). Pool several shots:
// single shots scatter by ±0.2 px. Slow (seconds per lens at 7680²): keep the Browser pane visible.
export function caResidual(res, Z = [0.35, 0.55, 0.7, 0.82, 0.96], N = 10) {
  const { gpu: { gl }, dev, lenses, nrOpts, S } = D();
  return lenses.map((L, li) => {
    const keep = { src: L.src, tex: L.tex }, d = L.full, W = d.width, H = d.height, wp = d.warp, sc = W / 3840, g = L.geo, rm = g.rmax;
    const kk = (c, x = [0, 0]) => [c[0], c[1] + x[0], c[2] + x[1], c[3]], wb = d.neutral.map(v => d.neutral[1] / v);
    const ca = { R: kk(wp.coef[0], res?.[li]?.R), B: kk(wp.coef[2], res?.[li]?.B), cac: [wp.cx * W, wp.cy * H], cam: Math.hypot(Math.max(wp.cx, 1 - wp.cx) * W, Math.max(wp.cy, 1 - wp.cy) * H) };
    const nz = Z.length - 1, st = Array.from({ length: nz }, () => ({ n: 0, r: 0, R: 0, B: 0 }));
    L.src = d; L.tex = dev.upload(d).tex;
    const fb = gl.createFramebuffer();
    try {
      dev.develop(L, { ...nrOpts(), ca, deblur: S.deblur ? { s0: 0.5 * sc * S.deblur / 100, s1: 1.4 * sc * S.deblur / 100 } : null }); dev.freeScratch();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, L.tex, 0);
      const TH = 512, x0 = Math.round(g.cx - 0.3 * rm), BW = Math.round(0.6 * rm), buf = new Float32Array(BW * TH * 4), v = (x, y, c) => buf[(y * BW + x) * 4 + c] * wb[c];
      for (let y0 = 0; y0 + TH <= H; y0 += TH - 64) {
        gl.readPixels(x0, y0, BW, TH, gl.RGBA, gl.FLOAT, buf);
        for (let x = 4; x < BW - 4; x += 2) for (let j0 = N + 2; j0 + 48 < TH - N - 2; j0 += 48) {
          let bj = -1, bg = 0;
          for (let j = j0; j < j0 + 48; j++) { const q = Math.abs(v(x, j - 1, 1) - v(x, j + 1, 1)); if (q > bg) { bg = q; bj = j; } }
          if (bj < 0) continue;
          const yy = y0 + bj - g.cy, r = Math.hypot(x0 + x + 0.5 - g.cx, yy), z = Z.findIndex((a, i) => r >= a * rm && r < Z[i + 1] * rm);
          if (z < 0 || z >= nz) continue;
          let p = [0, 1, 2].map(c => Array.from({ length: 2 * N + 1 }, (_, t) => v(x, bj - N + t, c)));
          const darkDown = p[1][0] > p[1][2 * N];
          if (!darkDown) p = p.map(a => a.reverse()); // bright -> dark
          const hi = p.map(a => (a[0] + a[1] + a[2]) / 3), lo = p.map(a => (a[2 * N] + a[2 * N - 1] + a[2 * N - 2]) / 3);
          if (Math.max(...p.flat()) > 0.8 || hi[1] < 3 * lo[1] || lo[1] < 0.003 || Math.abs(p[1][0] - p[1][2]) > 0.1 * hi[1]
            || Math.abs(p[1][2 * N] - p[1][2 * N - 2]) > 0.1 * (hi[1] - lo[1]) || hi[0] < 2 * lo[0] || hi[2] < 2 * lo[2]) continue;
          const out = darkDown === (yy > 0) ? 1 : -1, area = c => p[c].reduce((a, q, t) => a + (q - lo[c]) / (hi[c] - lo[c]) - (p[1][t] - lo[1]) / (hi[1] - lo[1]), 0);
          const s = st[z]; s.n++; s.r += r; s.R += out * area(0); s.B += out * area(2);
        }
      }
    } finally { gl.deleteFramebuffer(fb); gl.deleteTexture(L.tex); L.src = keep.src; L.tex = keep.tex; }
    return st.map(s => ({ r: Math.round(s.r / (s.n || 1)), n: s.n, R: +(s.R / (s.n || 1)).toFixed(2), B: +(s.B / (s.n || 1)).toFixed(2) }));
  });
}

// Edge false color ("dirty edges"): on strong luminance edges (|central difference| > 40 levels, 8-bit), how much more
// Lab chroma a pixel has than the flatter side 6 px away (min over left/right/up/down). Mean over edge pixels, and
// the share above 6 (a visible fringe). Lower is cleaner; a colored object's own edge adds a floor, so compare builds.
export function fringe({ d, W, H }) {
  const lin = v => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4), f = t => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const Y = new Float32Array(W * H), C = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const r = lin(d[4 * i]), g = lin(d[4 * i + 1]), b = lin(d[4 * i + 2]);
    const fx = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.9505), fy = f(0.2126 * r + 0.7152 * g + 0.0722 * b), fz = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.089);
    Y[i] = 0.2126 * d[4 * i] + 0.7152 * d[4 * i + 1] + 0.0722 * d[4 * i + 2]; C[i] = Math.hypot(500 * (fx - fy), 200 * (fy - fz));
  }
  let n = 0, s = 0, big = 0;
  for (let y = 6; y < H - 6; y++) for (let x = 6; x < W - 6; x++) {
    const i = y * W + x, gx = Y[i + 1] - Y[i - 1], gy = Y[i + W] - Y[i - W];
    if (Math.abs(gx) < 40 && Math.abs(gy) < 40) continue;
    const flat = Math.abs(gx) >= Math.abs(gy) ? Math.min(C[i - 6], C[i + 6]) : Math.min(C[i - 6 * W], C[i + 6 * W]);
    const e = Math.max(0, C[i] - flat); s += e; n++; if (e > 6) big++;
  }
  return { edges: n, mean: +(s / (n || 1)).toFixed(2), over6: +(big / (n || 1) * 100).toFixed(1) };
}

export function set(k, v) { const e = document.querySelector(`[data-k=${k}]`); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); }
export function proj(p) { document.querySelector(`input[name=proj][value=${p}]`).click(); }
