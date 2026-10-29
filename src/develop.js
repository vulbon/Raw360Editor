// Raw development on the GPU: normalize -> (noise reduction) -> green -> (lateral CA) -> red/blue -> false-color
// median -> camera RGB (RGBA16F + mipmaps).
import { NORM, LINEARRAW, NR_PACK, NR_ATROUS, NR_DETAIL, NR_UNPACK, NR_NLM, RCD_DIR, RCD_LPF, RCD_GREEN, RCD_RB1, RCD_RB2, CA_CFA, CHROMA_MED, HL_GUIDE, HL_RECON, DEBLUR, DEBLUR_IO } from './shaders.js';

// Noise of unit-variance white noise at each level of the B3 à-trous transform: thresholds are in these units.
const ATROUS_SIGMA = [0.8908, 0.2007, 0.0856, 0.0413, 0.0205];
const MED_PASSES = 2; // false-color median rounds (across + down)
const SCRATCH = ['cfa', 'cfaCA', 'green', 'rcdDir', 'rcdLpf', 'rgb', 'hlGuide', 'dbY', 'dbA', 'dbB', 'dbR', 'dbT', 'nrA', 'nrB', 'nrC', 'nrD', 'nrN'];

export function createDeveloper({ gl, program, texture, tgt, free, pass, finish }) {
  const P = Object.fromEntries(Object.entries({ NORM, LINEARRAW, NR_PACK, NR_ATROUS, NR_DETAIL, NR_UNPACK, NR_NLM, RCD_DIR, RCD_LPF, RCD_GREEN, RCD_RB1, RCD_RB2, CA_CFA, CHROMA_MED, HL_GUIDE, HL_RECON, DEBLUR, DEBLUR_IO })
    .map(([k, v]) => [k, program(v)]));
  const aniso = gl.getExtension('EXT_texture_filter_anisotropic');

  // `tex` receives the developed image. The raw data goes to the GPU only while developing (re-uploaded from the
  // decoded copy when a slider re-develops): phones have no memory to keep 2 x 30 MB of it around.
  function upload(d) {
    const { width: W, height: H } = d, tex = texture();
    gl.texStorage2D(gl.TEXTURE_2D, 1 + Math.floor(Math.log2(Math.max(W, H))), gl.RGBA16F, W, H);
    if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, 8);
    return { tex };
  }
  function uploadRaw(d) {
    const lin = d.channels === 3, raw = texture(gl.TEXTURE_2D, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, lin ? gl.RGB16UI : gl.R16UI, d.width, d.height, 0, lin ? gl.RGB_INTEGER : gl.RED_INTEGER, gl.UNSIGNED_SHORT, d.raw);
    return raw;
  }

  // opts: nr / nrc = luma / color strength 0..100, method = 'wavelet' | 'nlm', nlmR = NLM search radius,
  // ca = { R, B, cac, cam } lateral CA model applied to the mosaic (see CA_CFA)
  function develop(L, opts = {}) {
    const d = L.src, W = d.width, H = d.height;
    L.raw = uploadRaw(d);
    const norm = u => { gl.uniform1f(u.u_black, d.black); gl.uniform1f(u.u_scale, 1 / (d.white - d.black)); };
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, L.tex, 0);
    if (d.channels === 3) pass(P.LINEARRAW, fb, W, H, [['u_raw', L.raw]], norm);
    else {
      const cfa = tgt('cfa', gl.R16F, W, H); // half float: finer than the raw's own steps except in the top stop
      if ((opts.nr || opts.nrc) && d.noise) denoise(L, cfa, opts);
      else pass(P.NORM, cfa.fb, W, H, [['u_raw', L.raw]], norm);
      // RCD demosaic: directions and low-pass, green, then red/blue from color differences (see the RCD_* shaders)
      const wb = d.neutral.map(v => d.neutral[1] / v); // as-shot white balance, green = 1
      const green = tgt('green', gl.R16F, W, H), dir = tgt('rcdDir', gl.RG8, W, H), lpf = tgt('rcdLpf', gl.R16F, W, H);
      const cfaU = u => { gl.uniform4iv(u.u_cfa, d.cfa); gl.uniform3fv(u.u_wb, wb); };
      const greenFrom = t => {
        pass(P.RCD_DIR, dir.fb, W, H, [['u_cfaTex', t.tex]], cfaU);
        pass(P.RCD_LPF, lpf.fb, W, H, [['u_cfaTex', t.tex]], cfaU);
        pass(P.RCD_GREEN, green.fb, W, H, [['u_cfaTex', t.tex], ['u_dir', dir.tex], ['u_lpf', lpf.tex]], cfaU);
      };
      let src = cfa;
      greenFrom(src);
      if (opts.ca) { // move red/blue into place, then redo green (its gradients use them)
        const { R, B, cac, cam } = opts.ca;
        src = tgt('cfaCA', gl.R16F, W, H);
        pass(P.CA_CFA, src.fb, W, H, [['u_cfaTex', cfa.tex], ['u_green', green.tex]], u => {
          cfaU(u); gl.uniform4fv(u.u_kR, R); gl.uniform4fv(u.u_kB, B); gl.uniform2fv(u.u_cac, cac); gl.uniform1f(u.u_cam, cam);
        });
        greenFrom(src);
      }
      const rgb = tgt('rgb', gl.RGBA16F, W, H), med = dir => u => { gl.uniform2i(u.u_dir, ...dir); gl.uniform3fv(u.u_wb, wb); };
      pass(P.RCD_RB1, rgb.fb, W, H, [['u_cfaTex', src.tex], ['u_dir', dir.tex], ['u_green', green.tex]], cfaU);
      pass(P.RCD_RB2, fb, W, H, [['u_rb', rgb.tex], ['u_dir', dir.tex], ['u_raw', L.raw]], u => { cfaU(u); gl.uniform1f(u.u_clip, d.clip ?? d.white); });
      for (let i = 0; i < (opts.medPasses ?? MED_PASSES); i++) { // repeated, like dcraw's median passes: each one reaches further
        pass(P.CHROMA_MED, rgb.fb, W, H, [['u_src', L.tex]], med([1, 0]));
        pass(P.CHROMA_MED, fb, W, H, [['u_src', rgb.tex]], med([0, 1]));
      }
      // highlight reconstruction (HL_GUIDE, HL_RECON), then back into the lens texture
      const gw = Math.ceil(W / 4), gh = Math.ceil(H / 4), lv = Math.floor(Math.log2(Math.max(gw, gh))) + 1;
      const guide = tgt('hlGuide', gl.RGBA16F, gw, gh, lv);
      pass(P.HL_GUIDE, guide.fb, gw, gh, [['u_src', L.tex]], u => gl.uniform3fv(u.u_wb, wb));
      gl.bindTexture(gl.TEXTURE_2D, guide.tex); gl.generateMipmap(gl.TEXTURE_2D);
      pass(P.HL_RECON, rgb.fb, W, H, [['u_src', L.tex], ['u_guide', guide.tex]], u => { gl.uniform3fv(u.u_wb, wb); gl.uniform1f(u.u_lods, lv - 1); });
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, rgb.fb); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, fb);
      gl.blitFramebuffer(0, 0, W, H, 0, 0, W, H, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      if (opts.deblur) { free(['cfa', 'cfaCA', 'green', 'rcdDir', 'rcdLpf']); deblur(L, fb, rgb, wb, opts.deblur); }
    }
    gl.deleteFramebuffer(fb);
    gl.deleteTexture(L.raw); L.raw = null;
    gl.bindTexture(gl.TEXTURE_2D, L.tex);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  }

  // Richardson-Lucy on luminance with the lens's radial blur profile (DEBLUR), then the gain onto the color in L.tex.
  // prof: { s0, s1 } blur sigma in pixels at the centre and the image circle, already scaled by the strength slider.
  function deblur(L, fb, rgb, wb, prof, iterations = 6) {
    const d = L.src, W = d.width, H = d.height, g = L.geo;
    const y = tgt('dbY', gl.R16F, W, H), est = [tgt('dbA', gl.R16F, W, H), tgt('dbB', gl.R16F, W, H)];
    const ratio = tgt('dbR', gl.R16F, W, H), tmp = tgt('dbT', gl.R16F, W, H);
    pass(P.DEBLUR_IO, y.fb, W, H, [['u_src', L.tex], ['u_y', L.tex], ['u_est', L.tex]], u => { gl.uniform3fv(u.u_wb, wb); gl.uniform1i(u.u_apply, 0); });
    const half = (dst, src, num, dir, mode) => pass(P.DEBLUR, dst.fb, W, H, [['u_src', src.tex], ['u_num', num.tex]], u => {
      gl.uniform2i(u.u_dir, ...dir); gl.uniform2f(u.u_ctr, g.cx, g.cy); gl.uniform1f(u.u_rmax, g.rmax);
      gl.uniform1f(u.u_s0, prof.s0); gl.uniform1f(u.u_s1, prof.s1); gl.uniform1i(u.u_mode, mode);
    });
    let cur = y;
    for (let i = 0; i < iterations; i++) { // estimate <- estimate * blur(observed / blur(estimate))
      const next = cur === est[0] ? est[1] : est[0];
      half(tmp, cur, cur, [1, 0], 0); half(ratio, tmp, y, [0, 1], 1);
      half(tmp, ratio, ratio, [1, 0], 0); half(next, tmp, cur, [0, 1], 2);
      cur = next;
    }
    pass(P.DEBLUR_IO, rgb.fb, W, H, [['u_src', L.tex], ['u_y', y.tex], ['u_est', cur.tex]], u => { gl.uniform3fv(u.u_wb, wb); gl.uniform1i(u.u_apply, 1); });
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, rgb.fb); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, fb);
    gl.blitFramebuffer(0, 0, W, H, 0, 0, W, H, gl.COLOR_BUFFER_BIT, gl.NEAREST);
  }

  // Raw-domain denoise on packed, variance-stabilized planes (see the NR_* shaders).
  function denoise(L, dst, opts) {
    const { nr = 0, nrc = 0, method = 'wavelet', nlmR = 3 } = opts;
    const d = L.src, w = d.width / 2, h = d.height / 2, [a, o = 0] = d.noise, b = o / (a * a);
    const g = [0, 1, 2, 3].filter(k => d.cfa[k] === 1), perm = [d.cfa.indexOf(0), g[0], g[1], d.cfa.indexOf(2)];
    const c = [tgt('nrA', gl.RGBA16F, w, h), tgt('nrB', gl.RGBA16F, w, h)], acc = [tgt('nrC', gl.RGBA16F, w, h), tgt('nrD', gl.RGBA16F, w, h)];
    pass(P.NR_PACK, c[0].fb, w, h, [['u_raw', L.raw]], u => {
      gl.uniform1f(u.u_black, d.black); gl.uniform1f(u.u_scale, 1 / (d.white - d.black));
      gl.uniform1f(u.u_a, a); gl.uniform1f(u.u_b, b); gl.uniform4iv(u.u_perm, perm);
    });
    // real noise level relative to the profile (needs the first wavelet level)
    pass(P.NR_ATROUS, c[1].fb, w, h, [['u_src', c[0].tex]], u => gl.uniform1i(u.u_step, 1));
    const sigma = (L.noiseScale ??= measureNoise(c[0], c[1], w, h));

    let kY = nr / 100 * 1.6; // luma capped lower: higher wipes real texture (sand, foliage)
    const kC = nrc / 100 * 3.5;
    let src = c[0];
    if (method === 'nlm' && nr) { // luma by NLM, color still by wavelets below
      // bandwidth in noise sigmas; PSNR peaks near 1.0 (tools/nr-bench.html), so the slider tops out a bit past it
      const n = tgt('nrN', gl.RGBA16F, w, h), hk = opts.nlmH ?? nr / 100 * 1.3;
      pass(P.NR_NLM, n.fb, w, h, [['u_src', c[0].tex]], u => {
        gl.uniform1f(u.u_h2, 2 * (hk * sigma) ** 2); gl.uniform1f(u.u_sig2, sigma * sigma); gl.uniform1i(u.u_R, nlmR);
      });
      src = n; kY = 0;
    }
    // à-trous: c[ci] → c[1-ci] is one level; soft-thresholded details accumulate in acc
    const ping = src === c[0] ? c : [src, c[1]];
    let ci = 0, ai = 0;
    ATROUS_SIGMA.forEach((sig, lv) => {
      if (!(lv === 0 && src === c[0])) pass(P.NR_ATROUS, ping[1 - ci].fb, w, h, [['u_src', ping[ci].tex]], u => gl.uniform1i(u.u_step, 1 << lv));
      pass(P.NR_DETAIL, acc[1 - ai].fb, w, h, [['u_c', ping[ci].tex], ['u_cn', ping[1 - ci].tex], ['u_acc', acc[ai].tex]], u => {
        gl.uniform4f(u.u_thr, kY * sig * sigma, kC * sig * sigma, kC * sig * sigma, kC * sig * sigma); gl.uniform1i(u.u_first, lv === 0);
      });
      ci = 1 - ci; ai = 1 - ai;
    });
    pass(P.NR_UNPACK, dst.fb, d.width, d.height, [['u_acc', acc[ai].tex], ['u_c', ping[ci].tex]], u => {
      gl.uniform4iv(u.u_perm, perm); gl.uniform1f(u.u_a, a); gl.uniform1f(u.u_b, b);
    });
    free(['nrA', 'nrB', 'nrC', 'nrD', 'nrN']); // done before the demosaic allocates: lower peak memory
  }

  // DJI's NoiseProfile barely changes with ISO, so the stabilized noise is only roughly unit variance. Measure it from
  // the finest wavelet level on a central crop with a robust MAD. Chroma planes only: after the orthonormal rotation
  // noise is equal in every plane, but scene texture lands mostly in luma and would inflate the estimate.
  function measureNoise(fine, coarse, w, h) {
    const n = Math.min(512, w, h), x0 = (w - n) >> 1, y0 = (h - n) >> 1, A = new Float32Array(n * n * 4), B = new Float32Array(n * n * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fine.fb); gl.readPixels(x0, y0, n, n, gl.RGBA, gl.FLOAT, A);
    gl.bindFramebuffer(gl.FRAMEBUFFER, coarse.fb); gl.readPixels(x0, y0, n, n, gl.RGBA, gl.FLOAT, B);
    const diff = new Float32Array(n * n / 4);
    const sig = [1, 2, 3].map(ch => {
      for (let i = 0; i < diff.length; i++) diff[i] = Math.abs(A[i * 16 + ch] - B[i * 16 + ch]); // every 4th pixel
      diff.sort();
      return diff[diff.length >> 1] / 0.6745 / ATROUS_SIGMA[0];
    }).sort((x, y) => x - y)[1];
    return Math.min(8, Math.max(0.1, sig));
  }

  // Pick the luma denoiser for this device by timing one NLM pass on a 512² tile and extrapolating to a 3840² lens
  // (1920² packed). NLM is ~2 dB better than wavelets (tools/nr-bench.html) but costs a search per pixel: use it
  // when the estimate stays under `budget` ms per lens. Measured once; the readback forces the GPU to finish.
  let method = null;
  function pickMethod(budget = 400) {
    if (method) return method;
    const n = 512, src = tgt('nrBenchA', gl.RGBA16F, n, n), dst = tgt('nrBenchB', gl.RGBA16F, n, n);
    const run = () => {
      pass(P.NR_NLM, dst.fb, n, n, [['u_src', src.tex]], u => { gl.uniform1f(u.u_h2, 2); gl.uniform1f(u.u_sig2, 1); gl.uniform1i(u.u_R, 3); });
      finish(dst.tex);
    };
    run(); // warm-up (shader compile, allocation)
    const t0 = performance.now(); run(); const est = (performance.now() - t0) * (1920 * 1920) / (n * n);
    free(['nrBenchA', 'nrBenchB']);
    method = est < budget ? 'nlm' : 'wavelet';
    return method;
  }

  // Scratch buffers are only needed while developing (peak ≈280 MB for a 3840² lens): free them so phones keep their memory.
  return { upload, develop, pickMethod, freeScratch: () => free(SCRATCH) };
}
