// Per-shot calibration on the GPU: seam alignment, lens gain matching, seam exposure/color and parallax (flow)
// and leveling. No DOM access: callers handle UI and progress.
import { mm, tr, rx, ry, rz, RAD, eulerYXZ, fromTo } from './color.js';
import { DEFAULTS, ALIGN_KEYS, BAND_DEG, FLOW_W, FLOW_BINS, FLOW_R, GAIN_BINS } from './config.js';
import { S, session } from './state.js';
import { gl, tgt, free, pass, texture, ncc, flowProg, draw, levelMatrix, bandToWorld } from './render.js';

// ---------- GPU NCC (seam alignment, JPG leveling) ----------
const bandH = W => Math.round(W * BAND_DEG / 180);
// Overlap ring rendered as a horizontal strip: equirect in a frame whose pole is lens 0's axis. `k` stacks several
// strips in one tall target (batched scoring).
export function drawBand(only, W, t, { mode = 1, k = 0, flow = false } = {}) {
  const h = bandH(W);
  gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
  draw({ w: W, h, vy: k * h, res: [W, W / 2], off: Math.round(W / 4 - h / 2) - k * h, mode, only, flow, proj: 'equirect', fov: 360,
    view: bandToWorld() });
}

// Score K candidates with one GPU round trip (each readback costs ~10 ms of sync even for a single pixel, drawing a
// candidate ~0.1 ms). Candidate k reads a at rows +k·aStride, b at rows +k·bStride. Returns NCC per candidate.
let nccBuf = new Float32Array(0);
export function nccBatch(aTex, bTex, w, h, K, aStride, bStride, lodB) {
  const bw = Math.ceil(w / 8), bh = Math.ceil(h / 8), r = tgt('ncc', gl.RGBA32F, bw, bh * K), u = ncc.u;
  gl.bindFramebuffer(gl.FRAMEBUFFER, r.fb);
  gl.useProgram(ncc.p);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, aTex); gl.uniform1i(u.u_a, 0);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, bTex); gl.uniform1i(u.u_b, 1);
  gl.uniform2i(u.u_size, w, h);
  gl.uniform1i(u.u_jpg, lodB !== undefined);
  gl.uniform1f(u.u_lodB, lodB || 0);
  for (let k = 0; k < K; k++) {
    gl.viewport(0, k * bh, bw, bh);
    gl.uniform2i(u.u_aOff, 0, k * aStride); gl.uniform2i(u.u_bOff, 0, k * bStride); gl.uniform1i(u.u_rowOff, k * bh);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  const n4 = bw * bh * 4;
  if (nccBuf.length < n4 * K) nccBuf = new Float32Array(n4 * K);
  gl.readPixels(0, 0, bw, bh * K, gl.RGBA, gl.FLOAT, nccBuf);
  return Array.from({ length: K }, (_, k) => {
    let sab = 0, saa = 0, sbb = 0, n = 0;
    for (let i = k * n4; i < (k + 1) * n4; i += 4) { sab += nccBuf[i]; saa += nccBuf[i + 1]; sbb += nccBuf[i + 2]; n += nccBuf[i + 3]; }
    const score = sab / Math.sqrt(saa * sbb);
    return n < 1000 || !Number.isFinite(score) ? 0 : score;
  });
}

// Batched compass search: every round scores ±step on each axis plus a pattern move (continue the last successful
// step) in a single batch, moves to the best improvement, else halves the steps. Few rounds = few GPU round trips.
function compassSearch(evalBatch, x0, steps, rounds) {
  let x = x0.slice(), fx = evalBatch([x])[0], st = steps.slice(), last = null;
  for (let r = 0; r < rounds; r++) {
    const cands = [];
    st.forEach((s, i) => { for (const sg of [1, -1]) { const c = x.slice(); c[i] += sg * s; cands.push(c); } });
    if (last) cands.push(x.map((v, i) => v + last[i]));
    const f = evalBatch(cands);
    let bi = -1, bf = fx;
    f.forEach((v, i) => { if (v < bf) { bf = v; bi = i; } });
    if (bi < 0) { st = st.map(s => s / 2); last = null; continue; }
    last = cands[bi].map((v, i) => v - x[i]); x = cands[bi]; fx = bf;
  }
  return [x, fx];
}

// Match the two lenses' exposure/color in the overlap ring (sensor & lens transmission differ slightly).
export function matchGains() {
  session.lenses.forEach(L => (L.gain = [1, 1, 1]));
  const W = 2048, h = bandH(W), a = new Float32Array(W * h * 4), b = new Float32Array(W * h * 4), sa = [0, 0, 0], sb = [0, 0, 0];
  const tA = tgt('bandA', gl.RGBA32F, W, h);
  drawBand(0, W, tA); gl.readPixels(0, 0, W, h, gl.RGBA, gl.FLOAT, a);
  drawBand(1, W, tA); gl.readPixels(0, 0, W, h, gl.RGBA, gl.FLOAT, b);
  for (let i = 0; i < a.length; i += 4) {
    if (a[i + 3] < 0.5) continue;
    const hi = Math.max(a[i], a[i + 1], a[i + 2], b[i], b[i + 1], b[i + 2]), lo = Math.min(a[i], a[i + 1], a[i + 2], b[i], b[i + 1], b[i + 2]);
    if (hi > 0.9 || lo < 0.002) continue; // clipped / black
    for (let c = 0; c < 3; c++) { sa[c] += a[i + c]; sb[c] += b[i + c]; }
  }
  if (!sa[1] || !sb[1]) return;
  // only the darker lens is corrected (the other keeps gain 1, here and in the seam residual): brightening never pulls
  // clipped highlights below white
  const k = (session.gainLens = sa[1] >= sb[1] ? 1 : 0);
  session.lenses[k].gain = sa.map((v, c) => (k ? v / sb[c] : sb[c] / v));
}

// Per-shot self-calibration (DJI does the same in-camera): refine lens 2 rotation, focal scale and optical center so
// both lenses agree in the overlap ring. Score = NCC of log-luminance gradients, computed on the GPU.
// Coarse-to-fine: low band resolution samples blurrier mip levels, widening the capture range.
export function autoAlign() {
  // weak prior toward the profile's calibration: keeps textureless rings (sky, sea) from drifting
  const p0 = ALIGN_KEYS.map(k => session.profile.l2?.[k] ?? DEFAULTS[k]), sigma = [0.2, 0.2, 0.2, 0.002, 2, 2, 0.005];
  const prior = p => 0.01 * p.reduce((s, v, i) => s + ((v - p0[i]) / sigma[i]) ** 2, 0);
  const set = p => ALIGN_KEYS.forEach((k, i) => (S[k] = p[i]));
  const K = 2 * ALIGN_KEYS.length + 1; // compass candidates + pattern move
  let p = ALIGN_KEYS.map(k => S[k]), v = 0;
  for (const [W, scale, rounds] of [[1024, 1, 25], [2048, 0.4, 20], [4096, 0.15, 20]]) {
    const h = bandH(W), tA = tgt('bandA', gl.RG16F, W, h * K), tB = tgt('bandB', gl.RG16F, W, h * K);
    const evalBatch = pts => { // both lenses per candidate: the shared focal scale moves lens 0 too
      pts.forEach((q, k) => { set(q); drawBand(0, W, tA, { mode: 5, k }); drawBand(1, W, tB, { mode: 5, k }); });
      return nccBatch(tA.tex, tB.tex, W, h, pts.length, h, h).map((s, i) => -s + prior(pts[i]));
    };
    [p, v] = compassSearch(evalBatch, p, [0.5, 0.5, 0.5, 0.005, 4, 4, 0.01].map(s => s * scale), rounds);
  }
  set(p);
  free(['bandA', 'bandB', 'ncc']);
  return -(v - prior(p));
}

// ---------- seam gain (local exposure / color match) ----------
// matchGains() fixes the average lens difference; what is left varies around the ring. Measure log(lens0/lens1) per
// azimuth sector and channel in the overlap (global gains already applied, clipped/black pixels skipped), smooth it
// with confidence weights, and let the shader apply it to the corrected lens with a wide fade. Only rows within ±2° of
// the seam are measured: that is where the shader applies the full correction.
function seamRatios() {
  const W = 1024, h = bandH(W), a = new Float32Array(W * h * 4), b = new Float32Array(W * h * 4), t = tgt('bandA', gl.RGBA32F, W, h);
  drawBand(0, W, t); gl.readPixels(0, 0, W, h, gl.RGBA, gl.FLOAT, a);
  drawBand(1, W, t); gl.readPixels(0, 0, W, h, gl.RGBA, gl.FLOAT, b);
  free(['bandA']);
  const s0 = new Float64Array(GAIN_BINS * 3), s1 = new Float64Array(GAIN_BINS * 3), n = new Float64Array(GAIN_BINS), rows = Math.round(W * 2 / 360);
  for (let y = (h >> 1) - rows; y <= (h >> 1) + rows; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4, bin = Math.floor(x * GAIN_BINS / W);
    if (a[i + 3] < 0.5) continue;
    const hi = Math.max(a[i], a[i + 1], a[i + 2], b[i], b[i + 1], b[i + 2]), lo = Math.min(a[i], a[i + 1], a[i + 2], b[i], b[i + 1], b[i + 2]);
    if (hi > 0.9 || lo < 0.002) continue;
    for (let c = 0; c < 3; c++) { s0[bin * 3 + c] += a[i + c]; s1[bin * 3 + c] += b[i + c]; }
    n[bin]++;
  }
  const out = new Float32Array(GAIN_BINS * 3);
  for (let bin = 0; bin < GAIN_BINS; bin++) for (let c = 0; c < 3; c++) {
    let sum = 0, wsum = 0.25; // a small weight of "no correction" pulls empty sectors back to 0
    for (let k = -2; k <= 2; k++) {
      const j = (bin + k + GAIN_BINS) % GAIN_BINS, g = Math.exp(-k * k / 2) * Math.min(1, n[j] / 100);
      if (n[j] > 10) { sum += g * Math.log(s0[j * 3 + c] / s1[j * 3 + c]); wsum += g; }
    }
    out[bin * 3 + c] = sum / wsum;
  }
  // patent-safe mode: one brightness value per sector, no per-sector color (NOTICE.md, EP 3,356,887)
  if (S.safe) for (let i = 0; i < out.length; i += 3) out[i] = out[i + 1] = out[i + 2] = (out[i] + out[i + 1] + out[i + 2]) / 3;
  return out;
}

// Two passes like the flow: measure, apply, measure what is left, add it.
export function measureSeamGain() {
  if (session.seamGainTex) { gl.deleteTexture(session.seamGainTex); session.seamGainTex = null; } // start from the global gains only
  const upload = f => {
    if (!session.seamGainTex) { session.seamGainTex = texture(); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT); }
    gl.bindTexture(gl.TEXTURE_2D, session.seamGainTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB16F, GAIN_BINS, 1, 0, gl.RGB, gl.FLOAT, f);
  };
  const g = seamRatios();
  upload(g);
  seamRatios().forEach((v, i) => (g[i] = Math.max(-0.7, Math.min(0.7, g[i] + v)))); // ±1 stop at most
  upload(g);
  return g;
}

// ---------- seam flow (near-object parallax) ----------
// Back-to-back lenses see near objects from points a few cm apart: across the seam they land up to ~0.6° apart, and
// how far depends on distance, so it varies around the ring. Measure the cross-seam offset per azimuth bin on the GPU
// (one pass, one readback), keep confident bins, smooth around the ring, and hand it to the stitch shader.
// Per-bin cross-seam offset (band px) and confidence, from lens bands rendered with or without the current flow.
export function flowOffsets(withFlow) {
  const W = FLOW_W, h = bandH(W), ns = 2 * FLOW_R + 1;
  const tA = tgt('bandA', gl.RG16F, W, h), tB = tgt('bandB', gl.RG16F, W, h), r = tgt('flow', gl.RGBA32F, FLOW_BINS, ns);
  drawBand(0, W, tA, { mode: 5, flow: withFlow }); drawBand(1, W, tB, { mode: 5, flow: withFlow });
  pass(flowProg, r.fb, FLOW_BINS, ns, [['u_a', tA.tex], ['u_b', tB.tex]], u => {
    gl.uniform2i(u.u_size, W, h); gl.uniform1i(u.u_bins, FLOW_BINS); gl.uniform1i(u.u_R, FLOW_R);
  });
  const px = new Float32Array(FLOW_BINS * ns * 4);
  gl.readPixels(0, 0, FLOW_BINS, ns, gl.RGBA, gl.FLOAT, px);
  free(['bandA', 'bandB', 'flow']);
  const shift = new Float32Array(FLOW_BINS), conf = new Float32Array(FLOW_BINS);
  for (let b = 0; b < FLOW_BINS; b++) {
    const c = Array.from({ length: ns }, (_, j) => {
      const i = (j * FLOW_BINS + b) * 4, v = px[i] / Math.sqrt(px[i + 1] * px[i + 2]);
      return px[i + 3] > 200 && Number.isFinite(v) ? v : -1;
    });
    const j = c.indexOf(Math.max(...c)), peak = c[j], med = c.slice().sort((x, y) => x - y)[ns >> 1];
    const d = j > 0 && j < ns - 1 ? c[j - 1] - 2 * peak + c[j + 1] : 0;
    shift[b] = j - FLOW_R + (d < 0 ? 0.5 * (c[j - 1] - c[j + 1]) / d : 0);
    conf[b] = peak > 0.15 && d < 0 ? peak - med : 0; // a clear peak above the bin's typical score, not at the limit
  }
  return { shift, conf };
}

// Confidence-weighted circular smoothing; the 0.05 floor pulls textureless stretches back to 0 (pure geometry).
function smoothFlow({ shift, conf }) {
  return Float32Array.from({ length: FLOW_BINS }, (_, b) => {
    let s = 0, wsum = 0.05;
    for (let k = -3; k <= 3; k++) { const i = (b + k + FLOW_BINS) % FLOW_BINS, g = Math.exp(-k * k / 4) * conf[i]; s += g * shift[i]; wsum += g; }
    return s / wsum;
  });
}

function uploadFlow(f) {
  if (!session.flowTex) {
    session.flowTex = texture();
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT); // azimuth wraps
  }
  gl.bindTexture(gl.TEXTURE_2D, session.flowTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, FLOW_BINS, 1, 0, gl.RED, gl.FLOAT, f);
}

// Two passes: measure the raw offsets, then measure again with that flow applied and add what is left (the smoothing
// and the fade-out under-correct a little on the first pass).
export function measureFlow() {
  if (session.flowTex) uploadFlow(new Float32Array(FLOW_BINS)); // start from pure geometry
  const first = flowOffsets(false), flow = smoothFlow(first);
  uploadFlow(flow);
  const rest = smoothFlow(flowOffsets(true));
  for (let b = 0; b < FLOW_BINS; b++) flow[b] = Math.max(-FLOW_R, Math.min(FLOW_R, flow[b] + rest[b]));
  uploadFlow(flow);
  session.flowStats = { maxPx: Math.max(...flow.map(Math.abs)), confident: first.conf.filter(c => c > 0).length };
  return flow;
}

// ---------- leveling ----------
// Drone attitude (body -> level world): pitch about x, roll about the nose (z).
export const attitude = (roll, pitch) => mm(rx(pitch * RAD), rz(roll * RAD));
// Leveling from the file: Insta360's accelerometer (gravity, mapped to lens axes by the profile), else DJI's flight attitude.
export function metadataLevel(src) {
  if (src.gravity && session.profile.imu) {
    const M = session.profile.imu, n = Math.hypot(...src.gravity), d = M.map(r => (r[0] * src.gravity[0] + r[1] * src.gravity[1] + r[2] * src.gravity[2]) / n);
    return fromTo([0, 1, 0], d); // the level frame's "down" onto gravity
  }
  const g = k => parseFloat(src.xmp.match(new RegExp(`drone-dji:${k}="([^"]+)"`))?.[1]);
  const roll = g('FlightRollDegree'), pitch = g('FlightPitchDegree');
  if (!Number.isFinite(roll) || !Number.isFinite(pitch)) return null;
  const [y, p, r] = session.profile.mount;
  return mm(mm(ry(y * RAD), mm(rx(p * RAD), rz(r * RAD))), tr(attitude(roll, pitch)));
}
export const setLevel = L => ([S.lyaw, S.lpitch, S.lroll] = eulerYXZ(L));

// Match DJI's own stitched JPG: search heading, then refine all three angles (GPU NCC against the JPG). `wide`: no tilt
// prior (patent-safe mode, or no flight attitude): every heading × pitch × roll (±40°) on a 10° grid at low resolution
// first (scanning them one after the other locks onto wrong headings).
export async function levelFromJPG(file, wide = false) {
  let bmp = await createImageBitmap(file, { resizeWidth: 2048, resizeHeight: 1024, resizeQuality: 'high' }).catch(() => createImageBitmap(file));
  if (bmp.width !== 2048 || bmp.height !== 1024) { // Safari may ignore the resize options
    const c = new OffscreenCanvas(2048, 1024), g = c.getContext('2d');
    g.imageSmoothingQuality = 'high'; g.drawImage(bmp, 0, 0, 2048, 1024); bmp.close();
    bmp = c.transferToImageBitmap();
  }
  const jt = texture(gl.TEXTURE_2D, gl.LINEAR);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  bmp.close();
  // our render of each candidate leveling, stacked in one tall target, scored against the JPG in one round trip
  const scoreAll = (W, pts) => {
    const H = W / 2, t = tgt('jpgA', gl.RG16F, W, H * pts.length);
    pts.forEach((q, k) => {
      [S.lyaw, S.lpitch, S.lroll] = q;
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
      draw({ w: W, h: H, vy: k * H, res: [W, H], off: -k * H, mode: 5, proj: 'equirect', fov: 360, view: levelMatrix() });
    });
    return nccBatch(t.tex, jt, W, H, pts.length, H, 0, Math.log2(2048 / W)).map(s => -s);
  };
  const top = (pts, W, k) => { // the k best, scored in batches that keep the stacked target under 8192 rows
    const n = Math.floor(8192 / (W / 2)), s = [];
    for (let i = 0; i < pts.length; i += n) s.push(...scoreAll(W, pts.slice(i, i + n)));
    return pts.map((p, i) => [s[i], p]).sort((a, b) => a[0] - b[0]).slice(0, k).map(([, p]) => p);
  };
  const refine = (p, W, st, rounds) => compassSearch(q => scoreAll(W, q), p, [st, st, st], rounds);
  const grid = [];
  if (wide) for (let y = -180; y < 180; y += 10) for (let x = -40; x <= 40; x += 10) for (let z = -40; z <= 40; z += 10) grid.push([y, x, z]);
  const L0 = levelMatrix(); // otherwise the heading is the only unknown: scan it
  // a wide search keeps its five best coarse cells and lets the first refinement decide between them
  let [p] = (wide ? top(grid, 128, 5) : top(Array.from({ length: 36 }, (_, i) => eulerYXZ(mm(L0, ry((i * 10 - 180) * RAD)))), 256, 1))
    .map(c => refine(c, 512, 3, 14)).sort((a, b) => a[1] - b[1])[0];
  for (const [W, st, rounds] of [[1024, 1, 12], [1024, 0.3, 10]]) [p] = refine(p, W, st, rounds);
  [S.lyaw, S.lpitch, S.lroll] = p;
  free(['jpgA', 'ncc']);
  gl.deleteTexture(jt);
}

// Two points on the horizon span its plane; rotate that plane's normal onto "up". Changes roll/pitch only.
export function levelToHorizon(a, b) {
  const cross = (u, v) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const norm = v => { const l = Math.hypot(...v); return v.map(x => x / l); };
  let n = cross(a, b);
  if (Math.hypot(...n) < 1e-3) return false; // points too close or opposite
  n = norm(n); if (n[1] > 0) n = n.map(x => -x); // pick the normal pointing up (y is down)
  const up = [0, -1, 0], k = cross(n, up), sn = Math.hypot(...k);
  if (sn > 1e-9) {
    const [x, y, z] = k.map(v => v / sn), ang = Math.atan2(sn, -n[1]), c = Math.cos(ang), s = Math.sin(ang), C = 1 - c;
    const Rc = [[c + x * x * C, x * y * C - z * s, x * z * C + y * s], [y * x * C + z * s, c + y * y * C, y * z * C - x * s], [z * x * C - y * s, z * y * C + x * s, c + z * z * C]];
    setLevel(mm(levelMatrix(), tr(Rc)));
  }
  return true;
}
