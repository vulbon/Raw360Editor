// GPU rendering: the WebGL2 context, raw development, color setup, view matrices and the stitch/projection draw.
import { STITCH, NCC, FLOW, BLUR } from './shaders.js';
import { createGPU } from './gpu.js';
import { createDeveloper } from './develop.js';
import { mm, tr, rx, ry, rz, RAD, PP_SRGB, xyFromTempTint, neutralOfXY, camToPP, illumWeight } from './color.js';
import { PROJ, PAN_PROJ, FLOW_W, FLOW_FADE, GAIN_FADE, SLIDERS } from './config.js';
import { S, session } from './state.js';

// Live bindings, set by initGL(): importers see the values once the context exists.
export let gl, gpu, dev, program, texture, target, targets, tgt, free, pass, stitch, ncc, flowProg;
let blurProg;

// Returns false when WebGL2 with float render targets is unavailable.
export function initGL(canvas) {
  gl = canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: false });
  if (!gl || !gl.getExtension('EXT_color_buffer_float')) return false;
  gpu = createGPU(gl);
  ({ program, texture, target, targets, tgt, free, pass } = gpu);
  dev = createDeveloper(gpu);
  [stitch, ncc, flowProg, blurProg] = [program(STITCH), program(NCC), program(FLOW), program(BLUR)];
  return true;
}

export const nrOpts = () => ({ nr: S.nr, nrc: S.nrc, method: S.nr ? dev.pickMethod() : 'wavelet' }); // device-tiered luma NR
export const developAll = () => { session.lenses.forEach(L => dev.develop(L, { ...nrOpts(), ca: L.src.cfa && caModel(L) })); dev.freeScratch(); };

// Lateral CA model of a lens: the camera's DNG WarpRectilinear plus, while CA correction is on, the profile's residual (r², r⁴).
const NO_WARP = { coef: [[1, 0, 0, 0], 0, [1, 0, 0, 0]], cx: 0.5, cy: 0.5 };
const lensWarp = L => (L.src.warp?.coef.length === 3 ? L.src.warp : NO_WARP);
function caModel(L) {
  const { width: W, height: H } = L.src, wp = lensWarp(L), a = S.ca ? L.geo.ca : null;
  const k = (c, x = [0, 0]) => [c[0], c[1] + x[0], c[2] + x[1], c[3]];
  return { R: k(wp.coef[0], a?.R), B: k(wp.coef[2], a?.B), cac: [wp.cx * W, wp.cy * H],
    cam: Math.hypot(Math.max(wp.cx, 1 - wp.cx) * W, Math.max(wp.cy, 1 - wp.cy) * H) };
}
const IDENTITY_CA = { R: [1, 0, 0, 0], B: [1, 0, 0, 0], cac: [0, 0], cam: 1 };

export const bandToWorld = () => mm(tr(session.lenses[0].geo.R), [[1, 0, 0], [0, 0, 1], [0, -1, 0]]); // band frame: pole = lens 0 axis

export function updateColor() {
  const src = session.lenses[0].src;
  session.neutral = neutralOfXY(src, xyFromTempTint(S.temp, S.tint));
  session.M = camToPP(src, session.neutral);
  const hs = src.hueSatMap || { dims: [1, 1, 1], map1: [0, 1, 1] }; // none: identity, never the previous shot's map
  const g = illumWeight(src, S.temp), data = hs.map2 ? hs.map1.map((v, i) => g * v + (1 - g) * hs.map2[i]) : hs.map1;
  gl.bindTexture(gl.TEXTURE_3D, session.hsmTex);
  gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB16F, hs.dims[1], hs.dims[0], hs.dims[2], 0, gl.RGB, gl.FLOAT, new Float32Array(data));
  session.hsmDims = hs.dims;
}
export function setupProfileTextures(src) {
  // ProfileToneCurve: (x, y) pairs, linear in / linear out. Without one (Insta360) a generic base curve, x^1.39·1.37 /
  // (x^1.39 + .37), fitted to DJI's (deep shadows, lifted mid-tones, soft highlight roll-off), instead of a flat linear look
  const lut = new Float32Array(1024), tc = src.toneCurve;
  for (let i = 0; i < 1024; i++) {
    const x = i / 1023;
    if (!tc) { lut[i] = x ** 1.39 * 1.37 / (x ** 1.39 + 0.37); continue; }
    let k = 2; while (k < tc.length - 2 && tc[k] < x) k += 2;
    const x0 = tc[k - 2], y0 = tc[k - 1], x1 = tc[k], y1 = tc[k + 1];
    lut[i] = y0 + (y1 - y0) * (x1 > x0 ? (x - x0) / (x1 - x0) : 0);
  }
  if (!session.toneTex) session.toneTex = texture();
  gl.bindTexture(gl.TEXTURE_2D, session.toneTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, 1024, 1, 0, gl.RED, gl.FLOAT, lut);
  if (!session.hsmTex) {
    session.hsmTex = texture(gl.TEXTURE_3D);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.REPEAT); // hue wraps
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
  }
}

export const levelMatrix = () => mm(ry(S.lyaw * RAD), mm(rx(S.lpitch * RAD), rz(S.lroll * RAD)));
// Unrolled projections pan vertically instead of tilting the sphere (tilting bends the horizon into a wave).
export const vShift = () => (PAN_PROJ.includes(S.proj) ? S.pitch * RAD : 0);
export const lookMatrix = () => mm(ry(S.yaw * RAD), rx(vShift() ? 0 : S.pitch * RAD));
export const viewMatrix = () => mm(levelMatrix(), lookMatrix());

// One draw of the stitch shader into the bound framebuffer. res = logical output size; (offX, off) shift the
// framebuffer origin within it (export strips, on-screen crop frame).
export function draw({ w, h, vy = 0, res, off = 0, offX = 0, shift = 0, flow = S.flow && !S.safe, flip = false, hq = false, mode = 0, only = -1, grid = false, proj = S.proj, fov = S.fov, view = viewMatrix() }) {
  const u = stitch.u;
  gl.useProgram(stitch.p);
  gl.viewport(0, vy, w, h);
  session.lenses.forEach((L, i) => {
    const g = L.geo, p = `u_lens[${i}].`, W = L.src.width, H = L.src.height;
    let R = g.R;
    if (i === 1) R = mm(mm(rz(S.rroll * RAD), mm(rx(S.rpitch * RAD), ry(S.ryaw * RAD))), R);
    gl.uniformMatrix3fv(u[p + 'R'], true, R.flat());
    gl.uniform4f(u[p + 'intr'], g.f * S.fscale * (i === 1 ? S.f2 : 1), g.cx + (i === 1 ? S.cx2 : 0), g.cy + (i === 1 ? S.cy2 : 0), g.rmax);
    gl.uniform2f(u[p + 'k'], g.k1, g.k2);
    gl.uniform1i(u[p + 'model'], g.model ?? 0);
    if (g.model === 1) { gl.uniform4f(u[p + 'mei'], g.xi, g.k3, g.p1, g.p2); gl.uniform2f(u[p + 'mei2'], g.fy / g.f, g.thmax); }
    gl.uniform3fv(u[p + 'gain'], L.gain);
    gl.uniform1f(u[p + 'vig'], S.vig);
    gl.uniform2f(u[p + 'size'], W, H);
    const ca = L.src.cfa ? IDENTITY_CA : caModel(L); // mosaic input: CA was corrected during development
    gl.uniform4fv(u[p + 'caR'], ca.R); gl.uniform4fv(u[p + 'caB'], ca.B);
    gl.uniform2fv(u[p + 'cac'], ca.cac); gl.uniform1f(u[p + 'cam'], ca.cam);
    gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, L.tex);
  });
  gl.uniform1i(u.u_tex0, 0); gl.uniform1i(u.u_tex1, 1);
  gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, session.toneTex); gl.uniform1i(u.u_tone, 2);
  gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_3D, session.hsmTex); gl.uniform1i(u.u_hsm, 3);
  // the base layer must not be bound while it is being rendered (feedback loop)
  gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, mode === 4 || !targets.base ? session.toneTex : targets.base.tex); gl.uniform1i(u.u_base, 4);
  for (const k of ['hl', 'sh', 'wh', 'bk']) gl.uniform1f(u['u_' + k], S[k] / 100);
  const flowOn = flow && !!session.flowTex && proj !== 'dual';
  gl.activeTexture(gl.TEXTURE5); gl.bindTexture(gl.TEXTURE_2D, flowOn ? session.flowTex : session.toneTex); gl.uniform1i(u.u_flow, 5);
  gl.uniform1i(u.u_flowOn, flowOn);
  const gainOn = !!session.seamGainTex && proj !== 'dual';
  gl.activeTexture(gl.TEXTURE6); gl.bindTexture(gl.TEXTURE_2D, gainOn ? session.seamGainTex : session.toneTex); gl.uniform1i(u.u_seamGain, 6);
  gl.uniform1i(u.u_gainOn, gainOn); gl.uniform1i(u.u_gainLens, session.gainLens); gl.uniform1f(u.u_gainW, GAIN_FADE);
  gl.uniformMatrix3fv(u.u_band, true, tr(bandToWorld()).flat()); // world → seam-band frame (flow and seam gain)
  if (flowOn) {
    gl.uniform1f(u.u_flowScale, 2 * Math.PI / FLOW_W); gl.uniform1f(u.u_flowW, FLOW_FADE);
  }
  gl.uniformMatrix3fv(u.u_view, true, view.flat());
  gl.uniformMatrix3fv(u.u_look, true, lookMatrix().flat());
  gl.uniformMatrix3fv(u.u_M, true, session.M.flat());
  gl.uniformMatrix3fv(u.u_out, true, PP_SRGB.flat());
  gl.uniform3fv(u.u_neutral, session.neutral);
  gl.uniform3fv(u.u_hsmDims, session.hsmDims);
  gl.uniform2f(u.u_res, res[0], res[1]);
  gl.uniform1f(u.u_off, off);
  gl.uniform1f(u.u_offX, offX);
  gl.uniform1f(u.u_shift, shift);
  gl.uniform1f(u.u_fov, fov * RAD);
  gl.uniform1f(u.u_stretch, S.stretch);
  gl.uniform1f(u.u_pd, S.pd);
  gl.uniform1f(u.u_seam, S.seam * RAD);
  gl.uniform1f(u.u_expo, 2 ** (session.lenses[0].src.baselineExposure + S.ev));
  gl.uniform1f(u.u_contrast, S.contrast / 100);
  gl.uniform1f(u.u_sat, S.sat / 100);
  gl.uniform1f(u.u_vib, S.vib / 100);
  gl.uniform1fv(u.u_hslH, SLIDERS.hslH.map(([k]) => S[k] * 0.3)); // ±100 = ±30°, toward the neighbouring band
  gl.uniform1fv(u.u_hslS, SLIDERS.hslS.map(([k]) => S[k] / 100));
  gl.uniform1fv(u.u_hslL, SLIDERS.hslL.map(([k]) => S[k] / 100));
  gl.uniform1f(u.u_sharp, S.sharp / 100 * 1.5);
  gl.uniform1f(u.u_defringe, S.defringe / 100);
  gl.uniform1i(u.u_proj, PROJ[proj].id);
  gl.uniform1i(u.u_mode, mode);
  gl.uniform1i(u.u_only, only);
  gl.uniform1i(u.u_flip, flip);
  gl.uniform1i(u.u_hq, hq);
  gl.uniform1i(u.u_hasHsm, !!session.lenses[0].src.hueSatMap);
  gl.uniform1i(u.u_grid, grid);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

// Blurred log-luminance of the current view at low resolution (shadows/highlights): Gaussian, sigma 1/64 of the
// width. It only depends on framing and color, not on output size, so the preview and every export strip use the same one.
export function renderBase(aspect, view, shift) {
  if (!S.hl && !S.sh) return;
  const bw = 512, bh = Math.max(8, Math.round(bw / aspect)), t = tgt('base', gl.R16F, bw, bh), tmp = tgt('baseB', gl.R16F, bw, bh);
  gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
  draw({ w: bw, h: bh, res: [bw, bh], mode: 4, shift, view });
  const blur = (src, dst, dir) => pass(blurProg, dst.fb, bw, bh, [['u_src', src.tex]], u => { gl.uniform2i(u.u_dir, ...dir); gl.uniform1f(u.u_sigma, bw / 64); });
  blur(t, tmp, [1, 0]); blur(tmp, t, [0, 1]);
}

