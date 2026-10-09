import { initGL, gl, gpu, dev, target, tgt, nrOpts, developAll, updateColor, setupProfileTextures, draw, renderBase, levelMatrix, lookMatrix, viewMatrix, vShift } from './render.js';
import { TILE, tiff16, linearDNG, jpegWithXMP, panoXMP, sourceXMP, encodeTileRow } from './export.js';
import { STR } from './i18n.js';
import { drawBand, nccBatch, matchGains, autoAlign, measureSeamGain, flowOffsets, measureFlow, metadataLevel, setLevel, levelFromJPG, levelToHorizon } from './calibrate.js';
import { PROFILES, generic, instaProfile, PROJ, ASPECTS, SLIDERS, DEFAULTS, ALIGN_KEYS, HSL_BANDS, HSL_HUES } from './config.js';
import { parseDNG, splitDual } from './dng.js';
import { S, session } from './state.js';
import { RAD, mm, tr, rz, tempTintFromXY, xyOfNeutral } from './color.js';

const DONATE_URL = ''; // e.g. https://ko-fi.com/<you> or https://github.com/sponsors/<you>; button stays hidden until set

let baseName = 'pano', jpgFile = null;
let levelSource = 'levelNone', alignNCC = 0;

// ---------- i18n ----------
const $ = id => document.getElementById(id);
let lang = 'en', lastStatus = null, statusTimer = 0;
const t = (k, v = {}) => (STR[lang][k] ?? k).replace(/\{(\w+)\}/g, (_, x) => v[x] ?? '');
// The status pill: the loaded shot's exposure ('shot'), or a message that gives way to it again after a while.
function status(key, vars) {
  lastStatus = [key, vars];
  $('status').textContent = key === 'shot' ? shotInfo() : t(key, vars);
  clearTimeout(statusTimer);
  if (key !== 'shot' && key !== 'pickHint' && session.lenses.length === 2) statusTimer = setTimeout(() => status('shot'), 8000);
}
function shotInfo() {
  const v = (L, tag) => L.src.exif?.[tag]?.[0], exp = s => (!s ? '' : s >= 1 ? `${+s.toFixed(1)} s` : `1/${Math.round(1 / s)} s`);
  const names = session.lenses[0].src.insta ? ['lensFront', 'lensBack'] : ['lensUp', 'lensDown']; // Insta360 lenses face front/back
  const shot = L => `ISO ${v(L, 34855) ?? '?'} ${exp(v(L, 33434))}`.trim(), [a, b] = session.lenses.map(shot);
  const exposure = a === b ? [a] : session.lenses.map((L, i) => `${t(names[i])} ${shot(L)}`); // per lens only when they differ
  const L0 = session.lenses[0], f = v(L0, 37386), n = v(L0, 33437);
  return [session.profile.name, ...exposure, [f && `${+f.toFixed(2)} mm`, n && `f/${+n.toFixed(1)}`].filter(Boolean).join(' '), t(levelSource)]
    .filter(Boolean).join(' · ');
}
// Modal 'please wait' (native <dialog>: blocks the page, keeps focus, announced to screen readers).
// p = 0..1 for a progress bar, undefined for an indeterminate one.
function busy(key, vars, p) {
  const dlg = $('busy'), bar = dlg.querySelector('.bar');
  $('busy-msg').textContent = t(key, vars);
  bar.classList.toggle('indet', p == null);
  if (p != null) bar.style.setProperty('--p', `${Math.round(p * 100)}%`);
  if (!dlg.open) dlg.showModal();
}
const idle = () => $('busy').open && $('busy').close();
// let the dialog paint before synchronous GPU work (the timeout keeps hidden tabs, where rAF pauses, moving)
const paint = () => new Promise(r => { requestAnimationFrame(() => setTimeout(r)); setTimeout(r, 80); });
// Theme: dark (default, like a photo editor) or light, on <html data-theme> (one CSS block per theme). Each click
// switches; the icon shows the current one.
let themePref = 'dark';
function applyTheme(pref) {
  themePref = pref === 'light' ? 'light' : 'dark';
  try { localStorage.setItem('theme', themePref); } catch {}
  document.documentElement.dataset.theme = themePref;
  const btn = $('theme-btn');
  btn.firstElementChild.textContent = themePref === 'light' ? '☀' : '☾';
  btn.title = `${t('theme')}: ${t(themePref === 'light' ? 'themeLight' : 'themeDark')}`;
  btn.setAttribute('aria-label', btn.title);
  if (session.lenses.length) histogram(); // its blend mode depends on the background
}

function applyLang(l) {
  lang = STR[l] ? l : 'en';
  try { localStorage.setItem('lang', lang); } catch {}
  document.documentElement.lang = lang === 'zh' ? 'zh-Hant' : 'en';
  document.title = t('title');
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll('[data-i18n-title]')) { el.title = t(el.dataset.i18nTitle); el.setAttribute('aria-label', el.title); }
  for (const r of document.querySelectorAll('[name=lang]')) r.checked = r.value === lang;
  if (lastStatus) status(...lastStatus);
  if ($('theme-btn').title) applyTheme(themePref); // re-label in the new language
}

// ---------- on-screen crop frame: what you see inside the frame is exactly what gets exported ----------
const canvas = $('view');
const glOK = initGL(canvas);

function frameRect() {
  const cw = canvas.clientWidth, ch = canvas.clientHeight, gap = 12;
  // offsetLeft/Top give the panel's resting layout position, ignoring its slide-in/out transform
  const head = document.querySelector('header').getBoundingClientRect(), side = $('tools');
  let L = gap, T = head.bottom + gap, R = cw - gap, B = ch - gap - 44;
  if (!document.body.classList.contains('panel-off')) { if (side.offsetLeft > cw / 2) R = side.offsetLeft - gap; else B = side.offsetTop - gap - 44; }
  const aw = Math.max(50, R - L), ah = Math.max(50, B - T), a = (S.aspect === 'custom' ? S.ratio : ASPECTS[S.aspect]) || aw / ah;
  const w = Math.min(aw, ah * a), h = w / a;
  return { x: L + (aw - w) / 2, y: T + (ah - h) / 2, w, h };
}
let frame = null; // last frame rect, refreshed once per rendered frame (each frameRect() forces a layout read)
const curFrame = () => frame ?? (frame = frameRect());
const exportAspect = () => { const r = curFrame(); return r.w / r.h; };

let pending = false;
function render() {
  if (pending || session.lenses.length !== 2) return;
  pending = true;
  requestAnimationFrame(() => { pending = false; drawView(); });
}
function drawView() {
  const dpr = Math.min(devicePixelRatio, 2), cw = Math.round(canvas.clientWidth * dpr), ch = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
  const r = (frame = frameRect()), f = $('frame'), view = viewMatrix(), shift = vShift();
  Object.assign(f.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' });
  f.hidden = false;
  f.className = S.guide === 'none' ? '' : S.guide;
  renderBase(r.w / r.h, view, shift);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  draw({ w: cw, h: ch, res: [r.w * dpr, r.h * dpr], offX: -r.x * dpr, off: -(ch - (r.y + r.h) * dpr), shift, view, flip: true, grid: S.grid });
  syncExportSize();
  clearTimeout(histTimer); histTimer = setTimeout(histogram, 120);
}
// Projection change: a copy of the old picture fades out over the new one (no dip to dark in between).
function crossfade() {
  if (session.lenses.length !== 2 || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  drawView(); // the old projection, drawn in this task so the canvas can still be copied
  const ov = $('fade');
  ov.getAnimations().forEach(a => a.cancel());
  ov.width = canvas.width; ov.height = canvas.height;
  ov.getContext('2d').drawImage(canvas, 0, 0);
  ov.hidden = false;
  ov.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300, easing: 'ease-out' }).onfinish = () => { ov.hidden = true; };
}

// RGB histogram of the framed image (small render, drawn additively like Lightroom's)
let histTimer = 0;
function histogram() {
  if (session.lenses.length !== 2) return;
  const r = curFrame(), w = 192, h = Math.max(8, Math.round(w * r.h / r.w)), t = tgt('hist', gl.RGBA8, w, h), px = new Uint8Array(w * h * 4);
  gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
  draw({ w, h, res: [w, h], shift: vShift() });
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const bins = [new Uint32Array(64), new Uint32Array(64), new Uint32Array(64)];
  for (let i = 0; i < px.length; i += 4) for (let c = 0; c < 3; c++) bins[c][px[i + c] >> 2]++;
  const cv = $('hist'), g = cv.getContext('2d'), W = (cv.width = cv.clientWidth * 2), H = (cv.height = cv.clientHeight * 2);
  let peak = 1; // ignore the end bins so a clipped sky does not flatten everything else
  for (const b of bins) for (let i = 1; i < 63; i++) peak = Math.max(peak, b[i]);
  g.clearRect(0, 0, W, H);
  g.globalCompositeOperation = document.documentElement.dataset.theme === 'light' ? 'multiply' : 'lighter';
  ['#ff453a', '#30d158', '#0a84ff'].forEach((col, c) => {
    g.fillStyle = col + 'aa';
    g.beginPath(); g.moveTo(0, H);
    for (let i = 0; i < 64; i++) g.lineTo(i / 63 * W, H - Math.min(1, bins[c][i] / peak) * H * 0.95);
    g.lineTo(W, H); g.fill();
  });
}

// Direction (level frame) under a screen point: render that single pixel in mode 3 and read it back.
function dirAt(cx, cy) {
  const r = frameRect(), dpr = Math.min(devicePixelRatio, 2), t = tgt('pick', gl.RGBA32F, 1, 1), px = new Float32Array(4);
  gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
  draw({ w: 1, h: 1, res: [r.w * dpr, r.h * dpr], offX: (cx - r.x) * dpr - 0.5, off: (cy - r.y) * dpr - 0.5, shift: vShift(), mode: 3 });
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, px);
  return px[3] > 0.5 ? [px[0], px[1], px[2]] : null;
}
let picking = null;

async function autoLevel() {
  S.lyaw = S.lpitch = S.lroll = 0; levelSource = S.safe ? 'levelSafe' : 'levelNone';
  // patent-safe mode reads no tilt sensor / flight attitude (US 11,049,215): the camera's JPG, else level by hand
  const L = S.safe ? null : metadataLevel(session.lenses[0].src);
  if (L) { setLevel(L); levelSource = session.lenses[0].src.gravity ? 'levelImu' : 'levelMeta'; }
  if (jpgFile) {
    busy('levelingJpg'); await paint();
    try { await levelFromJPG(jpgFile, !L); levelSource = 'levelJpg'; }
    catch { if (L) setLevel(L); else S.lyaw = S.lpitch = S.lroll = 0; } // unreadable JPG: keep the metadata leveling
  }
  $('pick-level').classList.toggle('attn', levelSource === 'levelSafe'); // nothing to level from: point at the manual way
}

// Let the UI paint between heavy steps. MessageChannel is not throttled in background tabs like setTimeout is.
const yieldUI = () => new Promise(r => { const c = new MessageChannel(); c.port1.onmessage = () => r(); c.port2.postMessage(0); });

// ---------- loading ----------
// Workers fail where the page has no real origin (the built index.html opened straight from disk): probe once at
// start-up, and decode / encode on the main thread when they do (slower, and the page pauses meanwhile).
let workersOK = true;
try {
  const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  w.onmessage = () => w.terminate();
  w.onerror = () => { workersOK = false; w.terminate(); };
  w.postMessage(new ArrayBuffer(8)); // not a DNG: answers with an error message if it runs at all
} catch { workersOK = false; }
const decode = buf => (!workersOK ? Promise.resolve().then(() => parseDNG(buf)) : new Promise((res, rej) => {
  const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  w.onmessage = e => { w.terminate(); e.data.error ? rej(new Error(e.data.error)) : res(e.data); };
  w.postMessage(buf, [buf]);
}));

let loadSeq = 0, timing = {};
async function load(files) {
  const seq = ++loadSeq;
  files = [...files];
  const dngs = files.filter(f => /\.dng$/i.test(f.name));
  if (dngs.length !== 2 && dngs.length !== 1) return status('needTwo');
  jpgFile = files.find(f => /\.jpe?g$/i.test(f.name)) || null;
  busy('decoding'); await paint();
  const t0 = performance.now();
  let items;
  try {
    const decoded = await Promise.all(dngs.map(f => f.arrayBuffer().then(decode)));
    if (dngs.length === 1) { // one DNG with both fisheyes side by side (Insta360)
      if (decoded[0].width !== 2 * decoded[0].height) { idle(); return status('needTwo'); }
      items = splitDual(decoded[0]).map(src => ({ name: dngs[0].name, src, role: null }));
    } else items = dngs.map((f, i) => ({ name: f.name, src: decoded[i], role: /_UP\.dng$/i.test(f.name) ? 'UP' : /_DOWN\.dng$/i.test(f.name) ? 'DOWN' : null }));
  } catch (e) { idle(); return status('readFail', { e: e.message }); }
  if (seq !== loadSeq) return; // a newer drop superseded this one
  try { await prepare(items, t0); } catch (e) { status('readFail', { e: e.message }); }
  idle();
}

// develop, calibrate and level a decoded pair
async function prepare(items, t0) {
  items.sort((a, b) => Number(a.role === 'DOWN') - Number(b.role === 'DOWN')); // UP (or unknown) first
  const src = items[0].src;
  session.profile = PROFILES.find(p => p.match.test(`${src.model} ${src.product}`)) || (src.insta ? instaProfile(src) : generic(src.width));
  session.lenses.forEach(L => { gl.deleteTexture(L.tex); gl.deleteTexture(L.raw); });
  session.lenses = items.map((it, i) => ({ src: it.src, geo: session.profile.lenses[it.role] || session.profile.lenses[i], ...dev.upload(it.src), gain: [1, 1, 1] }));
  const tDecode = performance.now();
  developAll(); gpu.finish(session.lenses[1].tex);
  const tDevelop = performance.now();
  baseName = items[0].name.replace(/(_UP|_DOWN)?\.dng$/i, '');
  setupProfileTextures(src);
  busy('aligning'); await paint();
  calibrateSeam();
  const tAlign = performance.now();
  await autoLevel();
  asShot();
  timing = { decode: tDecode - t0, develop: tDevelop - tDecode, align: tAlign - tDevelop, level: performance.now() - tAlign };
  status('shot');
  $('empty').hidden = true;
  $('export-btn').disabled = false;
  syncInputs(); render();
}

// Lens 2 relative to lens 1: the per-shot fit (auto) or the profile's calibration, then everything measured on top.
function calibrateSeam() {
  for (const k of ALIGN_KEYS) S[k] = session.profile.l2?.[k] ?? DEFAULTS[k];
  alignNCC = S.autoAlign ? autoAlign() : 0; // gain-invariant score: no need to match gains first
  matchGains(); measureFlow(); measureSeamGain();
}

function asShot() {
  const n = [0, 1, 2].map(c => (session.lenses[0].src.neutral[c] + session.lenses[1].src.neutral[c]) / 2);
  [S.temp, S.tint] = tempTintFromXY(xyOfNeutral(session.lenses[0].src, n)).map(Math.round);
  updateColor();
}

// ---------- auto tone ("feeling lucky") ----------
// Targets measured on DJI's own stitched JPGs (17 shots, rows weighted by cos latitude): luma median .50 (here .48),
// 2nd percentile ~.09, mean saturation .33. Guards: 99th percentile of what is not pure white (a sun cannot come back)
// under .95, 2nd percentile over .05.
const LUCKY = { p50: 0.48, sat: 0.33, top: 0.95, floor: 0.05 };
// Luma percentiles and mean saturation of the framed image as rendered (equirect rows weighted by cos latitude).
function toneStats() {
  const r = curFrame(), w = 256, h = Math.max(8, Math.round(w * r.h / r.w)), t = tgt('lucky', gl.RGBA8, w, h), px = new Uint8Array(w * h * 4);
  renderBase(r.w / r.h, viewMatrix(), vShift());
  gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
  draw({ w, h, res: [w, h], shift: vShift() });
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const n = w * h, Y = new Float32Array(n), wt = new Float32Array(n);
  let sat = 0, ws = 0;
  for (let i = 0; i < n; i++) {
    const R = px[4 * i] / 255, G = px[4 * i + 1] / 255, B = px[4 * i + 2] / 255, mx = Math.max(R, G, B);
    wt[i] = S.proj === 'equirect' ? Math.cos(((Math.floor(i / w) + 0.5) / h - 0.5) * Math.PI) : 1;
    Y[i] = 0.2126 * R + 0.7152 * G + 0.0722 * B;
    sat += wt[i] * (mx > 0 ? (mx - Math.min(R, G, B)) / mx : 0); ws += wt[i];
  }
  const order = Array.from(Y.keys()).sort((a, b) => Y[a] - Y[b]), pct = (p, list = order) => {
    const total = list.reduce((a, i) => a + wt[i], 0);
    let acc = 0;
    for (const i of list) if ((acc += wt[i]) >= p * total) return Y[i];
    return 1;
  };
  return { p2: pct(0.02), p50: pct(0.5), p99: pct(0.99, order.filter(i => Y[i] < 0.995)), sat: sat / ws };
}
// Closed loop on the rendered image: exposure sets the median, highlights / shadows only guard against clipping and
// crushing, vibrance moves the color halfway to the reference (scenes differ); contrast comes from the tone curve.
// Damped steps, because each slider moves the others' targets a little; moderate ranges keep the result natural.
function autoTone() {
  const lim = (v, lo, hi) => Math.min(hi, Math.max(lo, v)), T = LUCKY;
  Object.assign(S, { ev: 0, contrast: 0, hl: 0, sh: 0, wh: 0, bk: 0, vib: 0, sat: 0 });
  const satT = (toneStats().sat + T.sat) / 2;
  for (let i = 0; i < 10; i++) {
    const s = toneStats();
    S.ev = lim(S.ev + 0.8 * Math.log2((T.p50 / Math.max(s.p50, 0.01)) ** 2.2), -4, 4);
    const over = s.p99 - T.top, under = T.floor - s.p2; // positive: clipping / crushing
    if (over > 0 || S.hl < 0) S.hl = lim(S.hl - 300 * over, -70, 0);
    if (under > 0 || S.sh > 0) S.sh = lim(S.sh + 400 * under, 0, 50);
    S.vib = lim(S.vib + 120 * (satT - s.sat), -25, 35);
  }
  for (const k of ['hl', 'sh', 'vib']) S[k] = Math.round(S[k]);
  S.ev = Math.round(S.ev * 100) / 100;
}

// ---------- export ----------
// Widest export that still adds detail: at this width one output pixel at the frame centre spans one sensor pixel
// (extent() maps the half-FOV to the projection plane, whose unit is radians at the centre).
function nativeWidth() {
  if (S.proj === 'dual') return 2 * session.lenses[0].src.width;
  const f = Math.max(...session.lenses.map(L => L.geo.f));
  return Math.min(2 * Math.round(f * extent(S.fov / 2 * RAD)), gl.getParameter(gl.MAX_TEXTURE_SIZE));
}
function openExport() {
  if (session.lenses.length !== 2) return;
  const max = nativeWidth(), ew = $('ew');
  ew.max = max;
  if (!(+ew.value) || +ew.value > max) ew.value = max;
  $('native').textContent = t('nativeMax', { n: max });
  $('q-row').hidden = $('fmt').value !== 'jpeg';
  syncExportSize();
  $('export-dlg').showModal();
}

function syncExportSize() {
  const h = String(Math.round((+$('ew').value || 7680) / exportAspect()));
  if ($('eh').value !== h) $('eh').value = h;
}

// Lossless-JPEG encoding runs on a small worker pool, one 256-row band at a time, while the GPU renders the next
// band: encoding overlaps rendering, uses several cores, and the full-size image never sits in memory at once.
function encoderPool() {
  if (!workersOK) return { size: 1, encode: (band, width, rows, spp) => Promise.resolve().then(() => encodeTileRow(band, width, rows, spp)), close() {} };
  const n = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1)), waiting = new Map();
  const workers = Array.from({ length: n }, () => new Worker(new URL('./export-worker.js', import.meta.url), { type: 'module' }));
  workers.forEach(w => (w.onmessage = ({ data }) => {
    const p = waiting.get(data.id); waiting.delete(data.id);
    data.error ? p.rej(new Error(data.error)) : p.res(data.chunks);
  }));
  let id = 0;
  return {
    size: n,
    encode: (band, width, rows, spp) => new Promise((res, rej) => {
      waiting.set(id, { res, rej });
      workers[id % n].postMessage({ id: id++, band, width, rows, spp }, [band.buffer]);
    }),
    close: () => workers.forEach(w => w.terminate()),
  };
}

// DNG data is stored at 1/2: reconstructed highlights above the raw clip level survive for Lightroom's Highlights slider
const DNG_HEADROOM = 2;
async function doExport() {
  if (session.lenses.length !== 2) return;
  const max = nativeWidth(), W = Math.min(+$('ew').value, max), H = Math.round(W / exportAspect()), fmt = $('fmt').value;
  if (!(W >= 16 && H >= 16) || H > 65535) return status('badSize', { max });
  const isFloat = fmt !== 'jpeg', bayer = fmt === 'bayer', mode = fmt === 'dng' || bayer ? 2 : 0, spp = bayer ? 1 : 3;
  const strip = isFloat ? TILE : Math.max(1, Math.min(H, Math.floor(4e6 / W))); // float formats: one tile row per strip
  const tg = target(isFloat ? gl.RGBA32F : gl.RGBA8, W, strip);
  const buf = isFloat ? new Float32Array(W * strip * 4) : new Uint8Array(W * strip * 4);
  const rgba = isFloat ? null : new Uint8ClampedArray(W * H * 4);
  const pool = fmt === 'dng' || bayer ? encoderPool() : null, bands = [];
  const cfa = session.lenses[0].src.cfa || [1, 0, 2, 1], view = viewMatrix(), shift = vShift();
  const k = mode === 2 ? 1 / DNG_HEADROOM : 1, q = v => (v <= 0 ? 0 : v * k >= 1 ? 65535 : Math.round(v * k * 65535));
  busy('exporting', { p: 0 }, 0); await paint();
  try {
    if (mode === 0) renderBase(W / H, view, shift);
    for (let y0 = 0; y0 < H; y0 += strip) {
      const h = Math.min(strip, H - y0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, tg.fb);
      draw({ w: W, h, res: [W, H], off: y0, shift, hq: true, mode, view });
      gl.readPixels(0, 0, W, h, gl.RGBA, isFloat ? gl.FLOAT : gl.UNSIGNED_BYTE, buf);
      if (!isFloat) rgba.set(buf.subarray(0, W * h * 4), y0 * W * 4);
      else {
        const band = new Uint16Array(W * h * spp);
        if (bayer) for (let y = 0; y < h; y++) for (let x = 0; x < W; x++) band[y * W + x] = q(buf[(y * W + x) * 4 + cfa[((y0 + y) & 1) * 2 + (x & 1)]]);
        else for (let i = 0, o = 0; o < band.length; i += 4, o += 3) { band[o] = q(buf[i]); band[o + 1] = q(buf[i + 1]); band[o + 2] = q(buf[i + 2]); }
        if (pool) {
          bands.push(pool.encode(band, W, h, spp));
          if (bands.length > 2 * pool.size) await bands[bands.length - 1 - 2 * pool.size]; // back-pressure: cap queued bands
        } else bands.push(new Uint8Array(band.buffer));
      }
      busy('exporting', { p: Math.round((y0 + h) / H * 100) }, (y0 + h) / H * (pool ? 0.85 : 1));
      await yieldUI();
    }
    tg.free();
    const src = session.lenses[0].src;
    const full = S.proj === 'equirect' && S.fov >= 360 && W === 2 * H && S.stretch === 1 && !S.pitch;
    const xmp = { ...sourceXMP(src), ...panoXMP(W, H, full) };
    let blob, ext;
    if (fmt === 'jpeg') {
      const c = new OffscreenCanvas(W, H);
      c.getContext('2d').putImageData(new ImageData(rgba, W, H), 0, 0);
      blob = await jpegWithXMP(await c.convertToBlob({ type: 'image/jpeg', quality: +$('q').value / 100 }), xmp);
      ext = 'jpg';
    } else if (fmt === 'tiff') {
      blob = tiff16(W, H, { strips: bands, rows: strip }, src, xmp);
      ext = 'tif';
    } else {
      // edits travel as Lightroom settings, not baked pixels; WB travels as AsShotNeutral
      Object.assign(xmp, { 'crs:HasSettings': 'True', 'crs:Exposure2012': S.ev.toFixed(2), 'crs:Contrast2012': S.contrast,
        'crs:Highlights2012': S.hl, 'crs:Shadows2012': S.sh, 'crs:Whites2012': S.wh, 'crs:Blacks2012': S.bk, 'crs:Saturation': S.sat, 'crs:Vibrance': S.vib,
        ...Object.fromEntries(HSL_BANDS.flatMap(b => [[`crs:HueAdjustment${b}`, S['hue' + b[0]]], [`crs:SaturationAdjustment${b}`, S['sat' + b[0]]], [`crs:LuminanceAdjustment${b}`, S['lum' + b[0]]]])), 'crs:Sharpness': S.sharp,
        ...(S.defringe ? { 'crs:DefringePurpleAmount': Math.round(S.defringe / 5), 'crs:DefringePurpleHueLo': 30, 'crs:DefringePurpleHueHi': 70 } : {}),
        ...(S.nrc ? { 'crs:ColorNoiseReduction': 0 } : {}) }); // our NR is baked in: keep LR from stacking its default on top
      busy('encoding', {}, 0.9);
      const hsrc = { ...src, baselineExposure: src.baselineExposure + Math.log2(DNG_HEADROOM) }; // same look, room above white
      blob = linearDNG(W, H, { tiles: (await Promise.all(bands)).flat() }, hsrc, session.neutral, xmp, bayer ? cfa : null);
      ext = 'dng';
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${baseName}_${S.proj}${bayer ? '_bayer' : ''}.${ext}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    status('exported', { name: a.download, mb: (blob.size / 1048576).toFixed(1) });
  } catch (e) {
    status('exportFail', { e: e.message });
  } finally {
    pool?.close();
    idle();
    render();
  }
}

// ---------- UI ----------
// Projection switcher, iOS segmented-control style: one highlight slides to the selected chip (CSS transition).
function movePill() {
  const chip = $('projs').querySelector(':checked')?.parentElement, pill = $('projs').querySelector('.pill');
  if (!chip || !chip.offsetWidth) return;
  Object.assign(pill.style, { width: chip.offsetWidth + 'px', transform: `translateX(${chip.offsetLeft}px)` });
  chip.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
}
function buildUI() {
  $('projs').innerHTML = '<span class="pill" aria-hidden="true"></span>'
    + Object.keys(PROJ).map(k => `<label class="chip"><input type="radio" name="proj" value="${k}"><span data-i18n="${k}"></span></label>`).join('');
  const ro = new ResizeObserver(() => movePill()); // labels arrive later (language, fonts) and change chip widths
  for (const c of $('projs').querySelectorAll('.chip')) ro.observe(c);
  $('aspects').innerHTML = Object.keys(ASPECTS).map(k => `<label class="chip"><input type="radio" name="aspect" value="${k}"><span ${k === 'free' ? 'data-i18n="free"' : ''}>${k}</span></label>`).join('')
    + '<input id="ratio" type="text" inputmode="decimal" placeholder="W:H" data-i18n-title="ratio" autocomplete="off">';
  for (const box of document.querySelectorAll('[data-sliders]'))
    box.innerHTML = SLIDERS[box.dataset.sliders].map(([k, min, max, step]) =>
      `<label class="sl"><span data-i18n="${/^(hue|sat|lum)[A-Z]$/.test(k) ? 'c' + k[3] : k}"></span><output></output><input type="range" data-k="${k}" min="${min}" max="${max}" step="${step}"></label>`).join('');
  // color mixer tracks: hue runs through the neighbouring hues, saturation from grey, luminance from dark to light
  HSL_HUES.forEach((h, i) => {
    const b = HSL_BANDS[i][0], col = (hh, l = 55) => `hsl(${hh} 85% ${l}%)`;
    for (const [k, g] of [['hue', `${col(h - 30)}, ${col(h)}, ${col(h + 30)}`], ['sat', `#8e8e93, ${col(h)}`], ['lum', `${col(h, 20)}, ${col(h)}, ${col(h, 85)}`]]) {
      const el = document.querySelector(`[data-k=${k}${b}]`);
      el.style.setProperty('--track', `linear-gradient(to right, ${g})`); el.dataset.ring = col(h);
    }
  });
  if (DONATE_URL) { $('donate').href = DONATE_URL; $('donate').hidden = false; }
}
// gradient stops (position %, rgb) matching the CSS tracks; the thumb ring takes the color under the thumb
const RAINBOW = [[0, 0x00c7ff], [17, 0x0a84ff], [34, 0x5e5ce6], [50, 0xbf5af2], [66, 0xff2d92], [83, 0xff6b2c], [100, 0xffd60a]];
const STOPS = { temp: [[0, 0x5b8cff], [45, 0xd9d9de], [100, 0xffb340]], tint: [[0, 0x3ccf6e], [50, 0xd9d9de], [100, 0xe45bd6]] };
function gradientAt(stops, p) {
  let i = 1; while (i < stops.length - 1 && stops[i][0] < p) i++;
  const [p0, c0] = stops[i - 1], [p1, c1] = stops[i], t = Math.min(1, Math.max(0, (p - p0) / (p1 - p0)));
  const ch = sh => Math.round(((c0 >> sh) & 255) * (1 - t) + ((c1 >> sh) & 255) * t);
  return `rgb(${ch(16)} ${ch(8)} ${ch(0)})`;
}
function fill(el) {
  const pos = v => (v - el.min) / (el.max - el.min) * 100, p = pos(+el.value), z = el.min < 0 && el.max > 0 ? pos(0) : 0;
  el.style.setProperty('--a', `${Math.min(p, z)}%`);
  el.style.setProperty('--b', `${Math.max(p, z)}%`);
  el.style.setProperty('--tc', Math.abs(p - z) < 0.01 ? 'transparent' : el.dataset.ring || gradientAt(STOPS[el.dataset.k] || RAINBOW, p));
}
const fmtVal = (k, v, el) => (k === 'temp' ? `${Math.round(v)} K` : `${el.min < 0 && v > 0 ? '+' : ''}${+v.toFixed(2)}`);
function syncInputs() {
  const pano = S.proj === 'equirect'; // a 360° pano for social sites: always the whole sphere at 2:1, nothing to crop
  if (pano) Object.assign(S, { fov: 360, aspect: '2:1', pitch: 0, stretch: 1 });
  $('aspects').hidden = $('aspects').previousElementSibling.hidden = pano;
  for (const k of ['fov', 'stretch', 'pitch']) document.querySelector(`[data-k=${k}]`).closest('.sl').hidden = pano;
  const fov = document.querySelector('[data-k=fov]'), fmax = String(PROJ[S.proj].max || 360);
  if (fov.max !== fmax) { fov.max = fmax; delete fov.dataset.v; } // new range: the fill has to be redrawn too
  for (const el of document.querySelectorAll('[data-k]')) {
    const k = el.dataset.k;
    if (el.type === 'checkbox') { el.checked = S[k]; el.disabled = k === 'flow' && S.safe; continue; } // safe mode: no parallax warp
    if (el.dataset.v === String(S[k])) continue; // unchanged: skip the DOM writes
    el.dataset.v = S[k]; el.value = S[k]; fill(el);
    el.parentElement.querySelector('output').textContent = fmtVal(k, +S[k], el);
  }
  for (const r of document.querySelectorAll('[name=proj],[name=aspect],[name=guide]')) r.checked = S[r.name] === r.value;
  movePill();
  if (S.aspect !== 'custom') $('ratio').value = '';
  document.querySelector('[data-k=pd]').closest('.sl').hidden = S.proj !== 'pannini'; // only Pannini uses it
}

function setProj(k) {
  const p = PROJ[k];
  Object.assign(S, { proj: k, fov: p.fov, aspect: p.aspect, pitch: p.pitch ?? (S.proj === 'planet' || S.proj === 'tunnel' ? 0 : S.pitch) });
}

buildUI();
let initialLang = 'en';
try { initialLang = localStorage.getItem('lang') || (navigator.language.startsWith('zh') ? 'zh' : 'en'); } catch {}
applyLang(initialLang);
let initialTheme = 'dark';
try { initialTheme = localStorage.getItem('theme') || 'dark'; } catch {}
applyTheme(initialTheme);
if (/iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.platform))) $('ioshint').hidden = false;
if (!glOK) { status('noGL'); for (const id of ['open', 'start-files', 'start-folder']) $(id).disabled = true; }
else status('hint');

document.addEventListener('input', e => {
  const el = e.target;
  if (el.name === 'lang') return applyLang(el.value);
  if (el.name === 'proj') { crossfade(); setProj(el.value); syncInputs(); return render(); }
  if (el.name === 'hslTab') { for (const g of ['hslH', 'hslS', 'hslL']) document.querySelector(`[data-sliders=${g}]`).hidden = g !== el.value; return; }
  if (el.name === 'aspect' || el.name === 'guide') { S[el.name] = el.value; syncInputs(); return render(); }
  if (el.id === 'q') { el.parentElement.querySelector('output').textContent = el.value; return fill(el); }
  if (el.id === 'ew') { if (+el.value > +el.max) el.value = el.max; return syncExportSize(); }
  if (el.id === 'ratio') { // custom aspect: "5:4", "5x4" or "2.39"
    const [w, h = 1] = el.value.split(/[:x×/]/).map(Number), r = w / h;
    if (!(r > 0.05 && r < 20)) return;
    Object.assign(S, { aspect: 'custom', ratio: r }); syncInputs(); return render();
  }
  const k = el.dataset.k;
  if (!k) return;
  S[k] = el.type === 'checkbox' ? el.checked : +el.value;
  if (session.lenses.length && (k === 'temp' || k === 'tint')) updateColor();
  syncInputs(); render();
});
// re-matching lens brightness reads back from the GPU: do it once when a lens slider is released, not per tick
document.addEventListener('change', e => {
  const k = e.target.dataset?.k;
  if (session.lenses.length && (k === 'vig' || k === 'safe')) { matchGains(); measureSeamGain(); render(); }
  if (session.lenses.length && k === 'safe') autoLevel().then(() => { idle(); status('shot'); syncInputs(); render(); });
  if (session.lenses.length && k === 'autoAlign') {
    busy('aligning'); paint().then(() => {
      const t0 = performance.now(); calibrateSeam(); idle();
      if (S.autoAlign) status('aligned', { ncc: alignNCC.toFixed(2), ms: Math.round(performance.now() - t0) });
      render();
    });
  }
  if (session.lenses.length && (k === 'nr' || k === 'nrc' || k === 'ca')) { // these change the development
    busy('denoising'); paint().then(() => { const t0 = performance.now(); developAll(); gpu.finish(session.lenses[1].tex); idle(); status('denoised', { ms: Math.round(performance.now() - t0) }); render(); });
  }
});
// double-click a slider (its label, track or thumb) to reset it, like Lightroom
document.addEventListener('dblclick', e => {
  const k = e.target.closest('.sl')?.querySelector('[data-k]')?.dataset.k;
  if (k) { S[k] = session.profile?.l2?.[k] ?? DEFAULTS[k]; if (session.lenses.length && (k === 'temp' || k === 'tint')) asShot(); syncInputs(); render(); }
});
$('asshot').onclick = () => { if (session.lenses.length) { asShot(); syncInputs(); render(); } };
$('lucky').onclick = () => { if (session.lenses.length) { autoTone(); syncInputs(); render(); } };
$('pick-level').onclick = () => { $('pick-level').classList.remove('attn'); if (session.lenses.length) { picking = []; S.grid = true; syncInputs(); render(); status('pickHint'); } };
$('reset-level').onclick = () => { S.lyaw = S.lpitch = S.lroll = 0; syncInputs(); render(); };
$('autolevel').onclick = async () => { if (session.lenses.length) { await autoLevel(); idle(); status('shot'); syncInputs(); render(); } };
$('export-btn').onclick = openExport;
// the form's submit fires right on the click (a dialog's 'close' event is queued, and throttled in background tabs)
$('export-dlg').querySelector('form').addEventListener('submit', e => e.submitter?.value === 'export' && queueMicrotask(doExport));
$('fmt').onchange = () => ($('q-row').hidden = $('fmt').value !== 'jpeg');
// collapsible tool panel (the crop frame uses the panel's resting position, so it re-fits immediately)
function setPanel(on) {
  document.body.classList.toggle('panel-off', !on);
  for (const b of [$('panel-btn'), $('panel-handle')]) b.setAttribute('aria-expanded', on);
  try { localStorage.setItem('panel', on ? '1' : '0'); } catch {}
  render();
}
$('panel-btn').onclick = $('panel-handle').onclick = () => setPanel(document.body.classList.contains('panel-off'));
$('theme-btn').onclick = () => applyTheme(themePref === 'dark' ? 'light' : 'dark');
try { if (localStorage.getItem('panel') === '0') setPanel(false); } catch {}
// ---------- opening: files or whole folders, from the dialog or dropped anywhere ----------
// Shots: DJI _UP + _DOWN (+ _D.JPG) by name, any other DNG on its own (Insta360 holds both lenses in one file).
function groupShots(files) {
  const shots = new Map();
  for (const f of files) {
    const m = f.name.match(/^(.*?)_(UP|DOWN|D)\.(dng|jpe?g)$/i), dng = /\.dng$/i.test(f.name);
    const key = m ? m[1] : dng ? f.name : null;
    if (!key) continue;
    if (!shots.has(key)) shots.set(key, { name: key, files: [] });
    shots.get(key).files.push(f);
  }
  return [...shots.values()].filter(s => s.files.filter(f => /\.dng$/i.test(f.name)).length === (/\.dng$/i.test(s.name) ? 1 : 2))
    .sort((a, b) => a.name.localeCompare(b.name));
}
function openFiles(files) {
  const shots = groupShots(files), dlg = $('open-dlg'), list = $('shots');
  $('open-msg').textContent = shots.length > 1 ? t('shotsFound', { n: shots.length }) : shots.length ? '' : t('noShots');
  list.hidden = shots.length < 2;
  if (shots.length === 1) { if (dlg.open) dlg.close(); return load(shots[0].files); }
  list.replaceChildren(...shots.map(s => {
    const li = document.createElement('li'), b = document.createElement('button'), kind = document.createElement('span');
    b.type = 'button'; b.textContent = s.name.replace(/\.dng$/i, '');
    kind.textContent = s.files.length > 1 && !/\.dng$/i.test(s.name) ? 'DJI' : 'DNG';
    b.append(kind); b.onclick = () => { dlg.close(); load(s.files); };
    li.append(b); return li;
  }));
  if (!dlg.open) dlg.showModal();
}
// a dropped folder arrives as a directory entry: walk it (readEntries returns batches until empty)
async function droppedFiles(dt) {
  const entries = [...dt.items].map(i => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return [...dt.files];
  const out = [], walk = async e => {
    if (e.isFile) out.push(await new Promise((res, rej) => e.file(res, rej)));
    else if (e.isDirectory) {
      const r = e.createReader();
      for (let batch; (batch = await new Promise((res, rej) => r.readEntries(res, rej))).length;) for (const c of batch) await walk(c);
    }
  };
  for (const e of entries) await walk(e);
  return out;
}
$('open').onclick = () => { $('open-msg').textContent = ''; $('shots').hidden = true; $('open-dlg').showModal(); };
// the start card picks directly; the Open dialog (header button) offers the same plus a list when several shots arrive
$('pick-files').onclick = $('start-files').onclick = () => $('files').click();
$('pick-folder').onclick = $('start-folder').onclick = () => $('folder').click();
$('pick-folder').hidden = $('start-folder').hidden = !('webkitdirectory' in $('folder')); // iOS has no folder picker
for (const id of ['files', 'folder']) $(id).onchange = e => { openFiles([...e.target.files]); e.target.value = ''; };
const hasFiles = e => e.dataTransfer?.types.includes('Files'); // not a dragged slider, text or image from the page
document.addEventListener('dragover', e => { if (!hasFiles(e)) return; e.preventDefault(); document.body.classList.add('drag'); });
document.addEventListener('dragleave', e => { if (!e.relatedTarget) document.body.classList.remove('drag'); });
document.addEventListener('drop', async e => { if (!hasFiles(e)) return; e.preventDefault(); document.body.classList.remove('drag'); openFiles(await droppedFiles(e.dataTransfer)); });

// Zoom in image-plane scale, not in degrees: rectilinear size grows with tan(fov/2), so equal degree steps
// explode near the limit. Half-width on the projection plane for half-FOV h:
function extent(h) {
  const id = PROJ[S.proj].id;
  return id === 3 ? Math.tan(Math.min(h, 1.55)) : id === 4 ? 2 * Math.tan(Math.min(h, 3.1) / 2)
    : id === 6 ? (S.pd + 1) * Math.sin(h) / Math.max(S.pd + Math.cos(h), 0.05) : h;
}
function zoom(factor) { // > 1 zooms out
  const target = extent(S.fov / 2 * RAD) * factor;
  let lo = 5 * RAD, hi = (PROJ[S.proj].max || 360) / 2 * RAD; // extent is monotonic: bisect for the new FOV
  for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (extent(m) < target) lo = m; else hi = m; }
  S.fov = (lo + hi) / RAD;
  syncInputs(); render();
}
canvas.addEventListener('wheel', e => {
  e.preventDefault();
  zoom(Math.exp(Math.max(-200, Math.min(200, e.deltaY * (e.deltaMode === 1 ? 40 : 1))) * 0.0012)); // lines → px; tame big jumps
}, { passive: false });

// pointers: one = look (Shift: level), two = pinch zoom + twist to level (roll about the view direction)
const pts = new Map();
let pinch = 0, twist = null, twistSum = 0, twisting = false;
const TWIST_DEADZONE = 4 * RAD; // a plain pinch never tilts the horizon
const spread = () => { const [a, b] = [...pts.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
const angle = () => { const [a, b] = [...pts.values()]; return Math.atan2(b.y - a.y, b.x - a.x); };
// +a turns the picture counter-clockwise on screen; about the current view axis, whatever the yaw/pitch
const rollView = a => { const K = lookMatrix(); setLevel(mm(levelMatrix(), mm(K, mm(rz(a), tr(K))))); };
canvas.addEventListener('pointerdown', e => {
  if (picking && session.lenses.length) {
    const d = dirAt(e.clientX, e.clientY);
    if (d) picking.push(d);
    if (picking.length === 2) { const ok = levelToHorizon(...picking); picking = null; status(ok ? 'picked' : 'pickHint'); syncInputs(); render(); }
    return;
  }
  pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
  try { canvas.setPointerCapture(e.pointerId); } catch {} // synthetic pointers cannot be captured
  pinch = pts.size === 2 ? spread() : 0;
  twist = pts.size === 2 ? angle() : null; twistSum = 0; twisting = false;
});
for (const ev of ['pointerup', 'pointercancel']) canvas.addEventListener(ev, e => { pts.delete(e.pointerId); pinch = 0; twist = null; });
canvas.addEventListener('pointermove', e => {
  const prev = pts.get(e.pointerId);
  if (!prev || S.proj === 'dual') return;
  pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pts.size === 2) {
    const d = spread(), ang = angle();
    if (pinch && d) zoom(pinch / d);
    pinch = d;
    if (twist != null) {
      const da = ((ang - twist + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;
      twistSum += da;
      if (twisting || Math.abs(twistSum) > TWIST_DEADZONE) { twisting = true; rollView(-da); syncInputs(); render(); } // follows the fingers
    }
    twist = ang;
    return;
  }
  const k = Math.min(S.fov, 180) / curFrame().w, dx = (e.clientX - prev.x) * k, dy = (e.clientY - prev.y) * k;
  if (e.shiftKey) { S.lroll += dx; S.lpitch -= dy; }
  else { S.yaw = ((S.yaw - dx + 540) % 360) - 180; S.pitch = Math.max(-90, Math.min(90, S.pitch + dy)); }
  syncInputs(); render();
});
// iOS drops the GL context under memory pressure or when the tab is suspended
canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); status('ctxLost'); });
canvas.addEventListener('dblclick', () => { setProj(S.proj); S.yaw = 0; syncInputs(); render(); });
new ResizeObserver(render).observe(canvas);
syncInputs();

// dev: ?load=a.dng,b.dng[,c.jpg] loads files served next to the page
const qs = new URLSearchParams(location.search).get('load');
if (qs) window.__dbg = { autoTone, toneStats, clearSeamGain: () => { gl.deleteTexture(session.seamGainTex); session.seamGainTex = null; render(); }, measureSeamGain, measureFlow, flowOffsets, get flowStats() { return session.flowStats; }, gpu, dev, nrOpts, draw, load, autoLevel, get timing() { return timing; }, get levelSource() { return levelSource; }, get alignNCC() { return alignNCC; }, S, levelMatrix, setLevel, metadataLevel, dirAt, drawBand, nccBatch, tgt, autoAlign, matchGains, render, get lenses() { return session.lenses; } };
if (qs) Promise.all(qs.split(',').map(async p => new File([await (await fetch(p)).blob()], p.split('/').pop()))).then(load);
