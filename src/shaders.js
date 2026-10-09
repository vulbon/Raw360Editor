export const VS = `#version 300 es
void main() { vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2); gl_Position = vec4(p * 2. - 1., 0, 1); }`;

// ---- raw development: normalize -> (optional denoise) -> demosaic ----
// Raw CFA ints -> normalized [0,1] floats.
export const NORM = `#version 300 es
precision highp float; precision highp usampler2D;
uniform usampler2D u_raw; uniform float u_black, u_scale;
out vec4 o;
void main() { o = vec4(max((float(texelFetch(u_raw, ivec2(gl_FragCoord.xy), 0).r) - u_black) * u_scale, 0.)); }`;

// LinearRaw (already demosaiced, e.g. Lightroom Enhanced DNG): just normalize.
export const LINEARRAW = `#version 300 es
precision highp float; precision highp usampler2D;
uniform usampler2D u_raw; uniform float u_black, u_scale;
out vec4 o;
void main() { o = vec4(max((vec3(texelFetch(u_raw, ivec2(gl_FragCoord.xy), 0).rgb) - u_black) * u_scale, 0.), 1); }`;

// Denoise, step 1: pack each 2x2 CFA cell into one texel, apply the generalized Anscombe transform with the DNG
// NoiseProfile (variance = a·x + b·a²) so noise becomes unit-variance Gaussian, then rotate the four planes into an
// orthonormal luma / chroma basis (so luma and color noise can be treated separately without changing the noise level).
export const NR_PACK = `#version 300 es
precision highp float; precision highp usampler2D;
uniform usampler2D u_raw; uniform float u_black, u_scale, u_a, u_b; uniform ivec4 u_perm; // 2x2 index of R, G1, G2, B
out vec4 o;
void main() {
  ivec2 P = ivec2(gl_FragCoord.xy) * 2; float v[4];
  for (int k = 0; k < 4; k++) {
    float x = (float(texelFetch(u_raw, P + ivec2(k & 1, k >> 1), 0).r) - u_black) * u_scale;
    v[k] = 2. * sqrt(max(x / u_a + .375 + u_b, 0.));
  }
  float r = v[u_perm.x], g1 = v[u_perm.y], g2 = v[u_perm.z], b = v[u_perm.w];
  o = vec4(r + g1 + g2 + b, r - g1 - g2 + b, 1.41421356 * (r - b), 1.41421356 * (g1 - g2)) * .5;
}`;

// Denoise, step 2: one level of the à-trous B3-spline wavelet (5x5 kernel with holes), mirrored borders.
export const NR_ATROUS = `#version 300 es
precision highp float;
uniform sampler2D u_src; uniform int u_step;
out vec4 o;
const float h[5] = float[](.0625, .25, .375, .25, .0625);
void main() {
  ivec2 P = ivec2(gl_FragCoord.xy), M = textureSize(u_src, 0) - 1; vec4 s = vec4(0);
  for (int j = 0; j < 5; j++) for (int i = 0; i < 5; i++) {
    ivec2 q = abs(P + ivec2(i - 2, j - 2) * u_step);
    s += h[i] * h[j] * texelFetch(u_src, min(q, 2 * M - q), 0);
  }
  o = s;
}`;

// Denoise, step 3: soft-threshold this level's detail (fine - coarse) and add it to the running reconstruction.
export const NR_DETAIL = `#version 300 es
precision highp float;
uniform sampler2D u_c, u_cn, u_acc; uniform vec4 u_thr; uniform bool u_first;
out vec4 o;
void main() {
  ivec2 P = ivec2(gl_FragCoord.xy);
  vec4 w = texelFetch(u_c, P, 0) - texelFetch(u_cn, P, 0);
  o = (u_first ? vec4(0) : texelFetch(u_acc, P, 0)) + sign(w) * max(abs(w) - u_thr, 0.);
}`;

// Denoise alternative: non-local means on the packed, variance-stabilized planes. Similarity is measured on luma
// (3x3 patches, unit-variance noise, so the expected noise-only distance 2σ² is subtracted), and all four planes are
// averaged with the same weights.
export const NR_NLM = `#version 300 es
precision highp float;
uniform sampler2D u_src; uniform float u_h2, u_sig2; uniform int u_R;
out vec4 o;
ivec2 M;
float Y(ivec2 p) { return texelFetch(u_src, clamp(p, ivec2(0), M), 0).x; }
void main() {
  ivec2 P = ivec2(gl_FragCoord.xy); M = textureSize(u_src, 0) - 1;
  float c[9];
  for (int k = 0; k < 9; k++) c[k] = Y(P + ivec2(k % 3 - 1, k / 3 - 1));
  vec4 sum = vec4(0); float ws = 0.;
  for (int dy = -u_R; dy <= u_R; dy++) for (int dx = -u_R; dx <= u_R; dx++) {
    ivec2 q = P + ivec2(dx, dy); float d = 0.;
    for (int k = 0; k < 9; k++) { float e = c[k] - Y(q + ivec2(k % 3 - 1, k / 3 - 1)); d += e * e; }
    float w = exp(-max(d / 9. - 2. * u_sig2, 0.) / u_h2);
    sum += w * texelFetch(u_src, clamp(q, ivec2(0), M), 0); ws += w;
  }
  o = sum / ws;
}`;

// Denoise, step 4: details + coarsest level, inverse rotation, unpack to the CFA mosaic, and invert the Anscombe
// transform with the Mäkitalo–Foi closed-form unbiased inverse (a plain algebraic inverse would darken the shadows).
export const NR_UNPACK = `#version 300 es
precision highp float;
uniform sampler2D u_acc, u_c; uniform ivec4 u_perm; uniform float u_a, u_b;
out vec4 o;
void main() {
  ivec2 Q = ivec2(gl_FragCoord.xy);
  vec4 t = texelFetch(u_acc, Q / 2, 0) + texelFetch(u_c, Q / 2, 0);
  float sY = .5 * (t.x + t.y), dY = .5 * (t.x - t.y), z = .70710678;
  float v[4];
  v[u_perm.x] = sY + z * t.z; v[u_perm.w] = sY - z * t.z; v[u_perm.y] = dY + z * t.w; v[u_perm.z] = dY - z * t.w;
  float y = max(v[(Q.x & 1) + 2 * (Q.y & 1)], 1.), y2 = y * y;
  float n = .25 * y2 + .30618622 / y - 1.375 / y2 + .76546554 / (y2 * y) - .125;
  o = vec4(max(u_a * (n - u_b), 0.));
}`;

// Demosaic, RCD style (ratio-corrected demosaicing, L. Sanz Rodríguez 2017; implemented from its description; it beat
// Hamilton–Adams by 0.8-3 dB in tools/demosaic-bench.html). Every color-difference step (green, red/blue, CA,
// false-color median) works on white-balanced values (u_wb, the as-shot multipliers): unbalanced, a neutral detail
// brighter than its surroundings would inherit their R−G / B−G and turn pink. Outputs stay in camera units. 1) Direction: local detail energy along each axis (and each diagonal) as a
// 0..1 ratio, so a pixel interpolates along its edge, not across it.
const RCD_HEAD = `#version 300 es
precision highp float;
uniform sampler2D u_cfaTex; uniform ivec4 u_cfa; uniform vec3 u_wb;
out vec4 o;
ivec2 P, S;
int col(ivec2 q) { return u_cfa[(q.y & 1) * 2 + (q.x & 1)]; }
float c(ivec2 d) { ivec2 q = clamp(P + d, ivec2(0), S - 1); return texelFetch(u_cfaTex, q, 0).r * u_wb[col(q)]; }
`;
export const RCD_DIR = RCD_HEAD + `
float e(ivec2 p, ivec2 d) { float a = c(p - d) - c(p + d), b = 2. * c(p) - c(p - 2 * d) - c(p + 2 * d); return a * a + .25 * b * b; }
float stat(ivec2 d) { return e(-d, d) + e(ivec2(0), d) + e(d, d); }
void main() {
  P = ivec2(gl_FragCoord.xy); S = textureSize(u_cfaTex, 0);
  float v = stat(ivec2(0, 1)), h = stat(ivec2(1, 0)), p = stat(ivec2(1, 1)), q = stat(ivec2(1, -1));
  o = vec4(v / (v + h + 1e-12), p / (p + q + 1e-12), 0, 1);
}`;
// 2) Low-pass of the mosaic (all colors mixed): the ratio corrections below compare it at two sites.
export const RCD_LPF = RCD_HEAD + `
void main() {
  P = ivec2(gl_FragCoord.xy); S = textureSize(u_cfaTex, 0);
  o = vec4(.25 * c(ivec2(0)) + .125 * (c(ivec2(-1, 0)) + c(ivec2(1, 0)) + c(ivec2(0, -1)) + c(ivec2(0, 1)))
    + .0625 * (c(ivec2(-1, -1)) + c(ivec2(1, -1)) + c(ivec2(-1, 1)) + c(ivec2(1, 1))));
}`;
// direction weight: the pixel's own, or its neighbours' mean when that is more decided (RCD's refinement)
const RCD_DISC = `
float disc(sampler2D t, int ch, bool diag) {
  float m = texelFetch(t, P, 0)[ch], n = 0.;
  for (int k = 0; k < 4; k++) {
    ivec2 d = diag ? ivec2(k & 1, k >> 1) * 2 - 1 : ivec2(k == 0 ? -1 : k == 1 ? 1 : 0, k == 2 ? -1 : k == 3 ? 1 : 0);
    n += .25 * texelFetch(t, clamp(P + d, ivec2(0), S - 1), 0)[ch];
  }
  return abs(.5 - m) < abs(.5 - n) ? n : m;
}`;
// 3) Green at red/blue sites: each neighbour green scaled by the low-pass ratio between here and its far side, the
// two sides of an axis weighted by their gradients, the axes blended by the direction weight.
export const RCD_GREEN = RCD_HEAD + RCD_DISC + `
uniform sampler2D u_dir, u_lpf;
float L(ivec2 d) { return texelFetch(u_lpf, clamp(P + d, ivec2(0), S - 1), 0).r; }
float grad(ivec2 d) { return 1e-5 + abs(c(d) - c(-d)) + abs(c(ivec2(0)) - c(2 * d)) + abs(c(d) - c(3 * d)) + abs(c(2 * d) - c(4 * d)); }
float est(ivec2 d) { return c(d) * 2. * L(ivec2(0)) / (1e-5 + L(ivec2(0)) + L(2 * d)); }
float axis(ivec2 d) { float a = grad(-d), b = grad(d); return (a * est(d) + b * est(-d)) / (a + b); }
void main() {
  P = ivec2(gl_FragCoord.xy); S = textureSize(u_cfaTex, 0);
  if (col(P) == 1) { o = vec4(c(ivec2(0))); return; }
  float w = disc(u_dir, 0, true);
  o = vec4(max(w * axis(ivec2(1, 0)) + (1. - w) * axis(ivec2(0, 1)), 0.));
}`;
// 4) At red/blue sites the other of the two, from color differences along the diagonals (diagonal direction weight).
export const RCD_RB1 = RCD_HEAD + RCD_DISC + `
uniform sampler2D u_dir, u_green;
float G(ivec2 d) { return texelFetch(u_green, clamp(P + d, ivec2(0), S - 1), 0).r; }
float grad(ivec2 d) { return 1e-5 + abs(c(d) - c(-d)) + abs(c(d) - c(3 * d)) + abs(G(ivec2(0)) - G(2 * d)); }
float axis(ivec2 d) { float a = grad(-d), b = grad(d); return (a * (c(d) - G(d)) + b * (c(-d) - G(-d))) / (a + b); }
void main() {
  P = ivec2(gl_FragCoord.xy); S = textureSize(u_cfaTex, 0);
  int k = col(P); float g = G(ivec2(0)), x = c(ivec2(0));
  if (k == 1) { o = vec4(0, g, 0, 1); return; }
  float w = disc(u_dir, 1, false), y = g + w * axis(ivec2(1, -1)) + (1. - w) * axis(ivec2(1, 1));
  o = vec4(k == 0 ? vec3(x, g, y) : vec3(y, g, x), 1);
}`;
// 5) At green sites red and blue from the four red/blue neighbours (now complete), axis direction weight; then back to
// camera units. alpha codes which colors have a clipped raw site in the 3×3 around (bits R 1, G 2, B 4; alpha =
// 1 - bits/8): those values are only a lower bound (green clips first, so usually magenta); HL_RECON rebuilds them.
export const RCD_RB2 = `#version 300 es
precision highp float;
uniform sampler2D u_rb, u_dir; uniform ivec4 u_cfa; uniform vec3 u_wb;
uniform highp usampler2D u_raw; uniform float u_clip;
out vec4 o;
ivec2 P, S;
int col(ivec2 q) { return u_cfa[(q.y & 1) * 2 + (q.x & 1)]; }
vec3 X(ivec2 d) { return texelFetch(u_rb, clamp(P + d, ivec2(0), S - 1), 0).rgb; }
` + RCD_DISC + `
vec2 grad(ivec2 d) { vec3 a = X(d), b = X(-d), f = X(3 * d); return 1e-5 + abs(X(ivec2(0)).g - X(2 * d).g) + abs(a.rb - b.rb) + abs(a.rb - f.rb); }
vec2 axis(ivec2 d) { vec2 a = grad(-d), b = grad(d); return (a * (X(d).rb - X(d).g) + b * (X(-d).rb - X(-d).g)) / (a + b); }
void main() {
  P = ivec2(gl_FragCoord.xy); S = textureSize(u_rb, 0);
  vec3 rgb = X(ivec2(0));
  if (col(P) == 1) { float w = disc(u_dir, 0, true); rgb.rb = rgb.g + w * axis(ivec2(1, 0)) + (1. - w) * axis(ivec2(0, 1)); }
  int m = 0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    ivec2 q = clamp(P + ivec2(x, y), ivec2(0), S - 1);
    if (float(texelFetch(u_raw, q, 0).r) >= u_clip) m |= 1 << col(q);
  }
  o = vec4(max(rgb / u_wb, 0.), 1. - float(m) / 8.);
}`;

// Highlight reconstruction. Most "blown" sky is clipped in one or two colors only (green first): the others still hold
// its brightness and detail. 1) Guide: the mean white-balanced color of pixels with nothing clipped nearby, at quarter
// resolution, mipmapped (alpha = their share), so each clipped pixel finds its nearest unclipped surroundings.
export const HL_GUIDE = `#version 300 es
precision highp float;
uniform sampler2D u_src; uniform vec3 u_wb;
out vec4 o;
void main() {
  ivec2 P = ivec2(gl_FragCoord.xy) * 4, S = textureSize(u_src, 0); vec4 s = vec4(0);
  for (int y = 0; y < 4; y++) for (int x = 0; x < 4; x++) {
    vec4 c = texelFetch(u_src, min(P + ivec2(x, y), S - 1), 0);
    if (c.a == 1.) s += vec4(c.rgb * u_wb, 1);
  }
  o = s / 16.;
}`;

// 2) Where some colors clipped, the survivors set the brightness and the guide (finest level with unclipped
// neighbours) the color. A clipped value is only ever raised: the true one was at least what was recorded. All three
// clipped: kept and marked (alpha 0) for the stitch to render neutral; otherwise alpha 1.
export const HL_RECON = `#version 300 es
precision highp float;
uniform sampler2D u_src, u_guide; uniform vec3 u_wb; uniform float u_lods;
out vec4 o;
void main() {
  ivec2 P = ivec2(gl_FragCoord.xy); vec4 C = texelFetch(u_src, P, 0);
  int m = int(round((1. - C.a) * 8.));
  if (m == 0 || m == 7) { o = vec4(C.rgb, m == 7 ? 0. : 1.); return; }
  vec2 uv = (vec2(P) + .5) / vec2(textureSize(u_src, 0));
  vec4 g = vec4(0);
  for (float l = 0.; l <= u_lods; l++) { g = textureLod(u_guide, uv, l); if (g.a > .01) break; }
  if (g.a <= .01) { o = vec4(C.rgb, 0.); return; }
  vec3 known = vec3((m & 1) == 0, (m & 2) == 0, (m & 4) == 0), c = C.rgb * u_wb, ch = g.rgb / g.a;
  vec3 est = min(dot(c, known) / max(dot(ch, known), 1e-6) * ch, vec3(8));
  o = vec4(mix(max(c, est), c, known) / u_wb, 1.);
}`;

// False-color suppression after demosaicing (median filtering of color, after Freeman 1988; the patent expired):
// log(R/G) and log(B/G), white-balanced, become their 5-tap median along u_dir, run once across and once down.
// Detail thinner than the red/blue sampling (twigs, wires: ~2 px) gets the color around it instead of an aliased guess,
// and a channel's blur tail beside a bright edge (an outlier ratio) is dropped; larger colored areas keep theirs.
// Ratios, unlike differences, do not depend on brightness: a bright neutral twig on dark leaves stays neutral.
export const CHROMA_MED = `#version 300 es
precision highp float;
uniform sampler2D u_src; uniform ivec2 u_dir; uniform vec3 u_wb;
out vec4 o;
void sort2(inout vec2 a, inout vec2 b) { vec2 t = min(a, b); b = max(a, b); a = t; } // per channel
const float E = .002; // keeps the ratios of near-black pixels from blowing up
void main() {
  ivec2 P = ivec2(gl_FragCoord.xy), S = textureSize(u_src, 0);
  vec2 v[5];
  for (int k = 0; k < 5; k++) { vec3 c = texelFetch(u_src, clamp(P + (k - 2) * u_dir, ivec2(0), S - 1), 0).rgb * u_wb + E; v[k] = log(c.rb / c.g); }
  sort2(v[0], v[1]); sort2(v[3], v[4]); sort2(v[2], v[4]); sort2(v[2], v[3]); sort2(v[0], v[3]); // 5-element
  sort2(v[0], v[2]); sort2(v[1], v[4]); sort2(v[1], v[3]); sort2(v[1], v[2]);                     // sorting network
  vec4 C = texelFetch(u_src, P, 0); float G = C.g * u_wb.g + E;
  o = vec4(max((vec3(G * exp(v[2].x), G, G * exp(v[2].y)) - E) / u_wb, 0.), C.a); // alpha: clip mark, passed through
}`;

// Lateral CA on the mosaic, before red/blue are demosaiced: each red/blue site takes its color at the radially
// rescaled position (DNG WarpRectilinear form, u_kR / u_kB), read as green there plus the bilinear color difference
// of the surrounding same-color sites. Done after demosaicing instead, the shift would also move the fine detail that
// red/blue borrow from green, leaving the fringes in place.
export const CA_CFA = `#version 300 es
precision highp float;
uniform sampler2D u_cfaTex, u_green; uniform ivec4 u_cfa; uniform vec4 u_kR, u_kB; uniform vec2 u_cac; uniform float u_cam; uniform vec3 u_wb;
out vec4 o;
ivec2 S;
float c(ivec2 q) { q = clamp(q, ivec2(0), S - 1); return texelFetch(u_cfaTex, q, 0).r * u_wb[u_cfa[(q.y & 1) * 2 + (q.x & 1)]]; }
float g(ivec2 q) { return texelFetch(u_green, clamp(q, ivec2(0), S - 1), 0).r; }
float d(ivec2 q) { return c(q) - g(q); }
void main() {
  ivec2 P = ivec2(gl_FragCoord.xy); S = textureSize(u_cfaTex, 0);
  int k = u_cfa[(P.y & 1) * 2 + (P.x & 1)];
  if (k == 1) { o = vec4(c(P) / u_wb.g); return; }
  vec4 K = k == 0 ? u_kR : u_kB;
  vec2 q = vec2(P) + .5, dd = (q - u_cac) / u_cam; float r2 = dot(dd, dd);
  vec2 qs = u_cac + (q - u_cac) * (K.x + r2 * (K.y + r2 * (K.z + r2 * K.w))) - .5;
  ivec2 g0 = ivec2(floor(qs)); vec2 gf = qs - vec2(g0);
  float G = mix(mix(g(g0), g(g0 + ivec2(1, 0)), gf.x), mix(g(g0 + ivec2(0, 1)), g(g0 + ivec2(1, 1)), gf.x), gf.y);
  ivec2 off = P & 1; vec2 lp = (qs - vec2(off)) * .5; ivec2 l0 = ivec2(floor(lp)); vec2 lf = lp - vec2(l0); ivec2 s = l0 * 2 + off;
  // bilinear over the four same-color sites, down-weighting sites whose green differs (across an edge): otherwise a
  // bright object's color difference bleeds a line into its darker surroundings
  float D = 0., ws = 0.;
  for (int j = 0; j < 4; j++) {
    ivec2 o2 = ivec2(j & 1, j >> 1) * 2; vec2 b = mix(1. - lf, lf, vec2(j & 1, j >> 1));
    float e = (g(s + o2) - G) / (.01 + .1 * G), w = b.x * b.y * exp(-e * e);
    D += w * d(s + o2); ws += w;
  }
  D = ws > 1e-4 ? D / ws : mix(mix(d(s), d(s + ivec2(2, 0)), lf.x), mix(d(s + ivec2(0, 2)), d(s + ivec2(2, 2)), lf.x), lf.y);
  o = vec4(max(G + D, 0.) / u_wb[k]);
}`;

// Separable Gaussian (one axis per pass, u_dir) for the shadows/highlights base: smooth, unlike a mip chain, whose
// box averages and linear upsampling show as blocks and stair-steps along bright/dark edges once the tone is pushed.
export const BLUR = `#version 300 es
precision highp float;
uniform sampler2D u_src; uniform ivec2 u_dir; uniform float u_sigma;
out vec4 o;
void main() {
  ivec2 P = ivec2(gl_FragCoord.xy), S = textureSize(u_src, 0);
  int R = int(ceil(3. * u_sigma)); float s = 0., ws = 0.;
  for (int k = -R; k <= R; k++) {
    float w = exp(-.5 * float(k * k) / (u_sigma * u_sigma));
    s += w * texelFetch(u_src, clamp(P + k * u_dir, ivec2(0), S - 1), 0).r; ws += w;
  }
  o = vec4(s / ws);
}`;

// Output pixel -> projection -> world ray -> each fisheye (per-channel CA warp for LinearRaw input) -> seam blend -> color.
export const STITCH = `#version 300 es
precision highp float; precision highp sampler3D;
// model 0: r = f·θ(1 + k1θ² + k2θ⁴) (DJI); model 1: unified/Mei with radial-tangential distortion (Insta360), mei = (xi, k3, p1, p2),
// mei2 = (fy/fx, widest valid angle)
struct Lens { mat3 R; vec4 intr; vec2 k; vec3 gain; float vig; vec2 size; vec4 caR; vec4 caB; vec2 cac; float cam; int model; vec4 mei; vec2 mei2; };
uniform Lens u_lens[2];
uniform sampler2D u_tex0, u_tex1, u_tone, u_base, u_flow; // u_flow: seam parallax per azimuth (band px), R16F N×1
uniform mat3 u_band; uniform float u_flowScale, u_flowW; uniform bool u_flowOn; // world→seam-band frame, px→rad, falloff
uniform sampler2D u_seamGain; uniform float u_gainW; uniform bool u_gainOn; uniform int u_gainLens; // per-azimuth log(lens0/lens1) residual, RGB16F N×1 // u_base: blurred log-luminance of this view (mode 4 output, mipmapped)
uniform sampler3D u_hsm;
uniform mat3 u_view, u_look, u_M, u_out; // u_look: view rotation only (level frame), for the horizon guide
uniform vec3 u_neutral, u_hsmDims;
uniform vec2 u_res;
uniform float u_shift; // vertical pan (rad) for unrolled projections, so the horizon stays straight
uniform float u_hslH[8], u_hslS[8], u_hslL[8]; // color mixer per band (red ... magenta): hue shift in degrees, saturation and luminance -1..1
uniform float u_off, u_offX, u_fov, u_stretch, u_pd, u_seam, u_expo, u_contrast, u_sat, u_vib, u_hl, u_sh, u_wh, u_bk, u_sharp, u_defringe;
uniform int u_proj, u_mode, u_only;
uniform bool u_flip, u_hq, u_hasHsm, u_grid;
out vec4 o;
const float PI = 3.14159265359;

// Catmull-Rom with 9 bilinear taps
vec4 cubic(sampler2D t, vec2 uv) {
  vec2 sz = vec2(textureSize(t, 0)), sp = uv * sz, tp = floor(sp - .5) + .5, f = sp - tp;
  vec2 w0 = f * (-.5 + f * (1. - .5 * f)), w1 = 1. + f * f * (-2.5 + 1.5 * f), w2 = f * (.5 + f * (2. - 1.5 * f)), w3 = f * f * (-.5 + .5 * f);
  vec2 w12 = w1 + w2, t0 = (tp - 1.) / sz, t3 = (tp + 2.) / sz, t12 = (tp + w2 / w12) / sz;
  return (textureLod(t, vec2(t0.x, t0.y), 0.) * w0.x + textureLod(t, vec2(t12.x, t0.y), 0.) * w12.x + textureLod(t, vec2(t3.x, t0.y), 0.) * w3.x) * w0.y
       + (textureLod(t, vec2(t0.x, t12.y), 0.) * w0.x + textureLod(t, t12, 0.) * w12.x + textureLod(t, vec2(t3.x, t12.y), 0.) * w3.x) * w12.y
       + (textureLod(t, vec2(t0.x, t3.y), 0.) * w0.x + textureLod(t, vec2(t12.x, t3.y), 0.) * w12.x + textureLod(t, t3, 0.) * w3.x) * w3.y;
}

vec3 sph(float lon, float lat) { return vec3(cos(lat) * sin(lon), sin(lat), cos(lat) * cos(lon)); }

// X: x in [-1,1] across the width, y scaled by the same unit (down = +). World: x right, y down, z forward.
bool project(vec2 X, out vec3 d) {
  float h = u_fov * .5;
  d = vec3(0, 0, 1);
  if (u_proj == 0) { float lon = X.x * h, lat = X.y * h - u_shift; d = sph(lon, lat); return abs(lat) <= PI * .5 && abs(lon) <= PI; }
  if (u_proj == 1) { float lon = X.x * h; d = normalize(vec3(sin(lon), X.y * h - tan(u_shift), cos(lon))); return abs(lon) <= PI; }
  if (u_proj == 2) { float lon = X.x * h; d = sph(lon, atan(sinh(X.y * h - asinh(tan(u_shift))))); return abs(lon) <= PI; }
  if (u_proj == 3) { d = normalize(vec3(X * tan(min(h, 1.55)), 1.)); return true; }
  float r = length(X); vec2 dir = r > 0. ? X / r : vec2(0);
  if (u_proj == 4) { float th = 2. * atan(r * tan(min(h, 3.1) * .5)); d = vec3(sin(th) * dir, cos(th)); return th <= PI; }
  if (u_proj == 5) { float th = r * h; d = vec3(sin(th) * dir, cos(th)); return th <= PI; }
  // Pannini (u_pd = 0 is rectilinear, 1 is classic Pannini)
  float xe = (u_pd + 1.) * sin(h) / max(u_pd + cos(h), .05);
  vec2 p = X * xe - vec2(0, tan(u_shift));
  float k = p.x * p.x / ((u_pd + 1.) * (u_pd + 1.)), dis = k * k * u_pd * u_pd - (k + 1.) * (k * u_pd * u_pd - 1.);
  if (dis < 0.) return false;
  float clon = (-k * u_pd + sqrt(dis)) / (k + 1.), S = (u_pd + 1.) / (u_pd + clon);
  d = sph(atan(p.x, S * clon), atan(p.y, S));
  return true;
}

vec2 lensPix(Lens L, vec3 w, out float th, out float r) {
  vec3 l = L.R * w;
  th = acos(clamp(l.z, -1., 1.));
  if (L.model == 1) {
    vec2 m = l.xy / (l.z + L.mei.x), d; float q = dot(m, m); // |l| = 1
    d = m * (1. + q * (L.k.x + q * (L.k.y + q * L.mei.y)))
      + vec2(2. * L.mei.z * m.x * m.y + L.mei.w * (q + 2. * m.x * m.x), L.mei.z * (q + 2. * m.y * m.y) + 2. * L.mei.w * m.x * m.y);
    vec2 p = L.intr.yz + vec2(1., L.mei2.x) * L.intr.x * d;
    r = th > L.mei2.y ? 1e9 : length(p - L.intr.yz); // past the widest angle the projection folds back: outside
    return p;
  }
  float t2 = th * th, q = length(l.xy);
  r = L.intr.x * th * (1. + t2 * (L.k.x + t2 * L.k.y));
  return L.intr.yz + r * (q > 1e-9 ? l.xy / q : vec2(0));
}

// DNG WarpRectilinear per plane: lateral chromatic aberration relative to green
// gx, gy: screen-space derivatives of the texture coordinate, taken before any branching (see main)
vec3 sampleLens(sampler2D t, Lens L, vec2 pix, vec2 gx, vec2 gy) {
  vec2 dd = (pix - L.cac) / L.cam; float r2 = dot(dd, dd);
  float sR = L.caR.x + r2 * (L.caR.y + r2 * (L.caR.z + r2 * L.caR.w));
  float sB = L.caB.x + r2 * (L.caB.y + r2 * (L.caB.z + r2 * L.caB.w));
  vec2 is = 1. / L.size, pR = (L.cac + (pix - L.cac) * sR) * is, pG = pix * is, pB = (L.cac + (pix - L.cac) * sB) * is;
  if (u_hq) return vec3(cubic(t, pR).r, cubic(t, pG).g, cubic(t, pB).b);
  return vec3(textureGrad(t, pR, gx, gy).r, textureGrad(t, pG, gx, gy).g, textureGrad(t, pB, gx, gy).b);
}

vec3 hsv2rgb(float h, float s, float v) {
  float i = floor(h), f = h - i, p = v * (1. - s), q = v * (1. - s * f), t = v * (1. - s * (1. - f));
  if (i < 1.) return vec3(v, t, p); if (i < 2.) return vec3(q, v, p); if (i < 3.) return vec3(p, v, t);
  if (i < 4.) return vec3(p, q, v); if (i < 5.) return vec3(t, p, v); return vec3(v, p, q);
}
// DNG ProfileHueSatMap, applied in linear ProPhoto like the DNG SDK
vec3 hsm(vec3 c) {
  float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b)), gap = mx - mn;
  if (mx <= 0.) return c;
  float h = 0., s = gap / mx;
  if (gap > 0.) {
    if (c.r == mx) { h = (c.g - c.b) / gap; if (h < 0.) h += 6.; }
    else if (c.g == mx) h = 2. + (c.b - c.r) / gap;
    else h = 4. + (c.r - c.g) / gap;
  }
  vec3 m = texture(u_hsm, vec3((s * (u_hsmDims.y - 1.) + .5) / u_hsmDims.y, (h * u_hsmDims.x / 6. + .5) / u_hsmDims.x,
                               (min(mx, 1.) * (u_hsmDims.z - 1.) + .5) / u_hsmDims.z)).xyz;
  return hsv2rgb(mod(h + m.x / 60., 6.), clamp(s * m.y, 0., 1.), mx * m.z);
}
float tone(float x) { return texture(u_tone, vec2(clamp(x, 0., 1.) * (1023. / 1024.) + .5 / 1024., .5)).r; }
vec3 oetf(vec3 c) { return mix(12.92 * c, 1.055 * pow(c, vec3(1. / 2.4)) - .055, step(.0031308, c)); }

void main() {
  float fy = gl_FragCoord.y + u_off, row = u_flip ? u_res.y - fy : fy, fx = gl_FragCoord.x + u_offX;
  vec2 X = vec2(2. * fx - u_res.x, 2. * row - u_res.y) / u_res.x;
  X.y /= u_stretch;
  vec3 d; bool inside = project(X, d);
  vec3 w = u_view * d;

  // Seam parallax: near the seam each lens is moved half the measured cross-seam offset (in opposite directions) so
  // near objects meet in the middle; the warp fades out u_flowW away from the seam, leaving pure geometry there.
  vec3 wd0 = w, wd1 = w, b = u_band * w;
  float az = atan(b.x, b.z), el = asin(clamp(b.y, -1., 1.));
  if (u_flowOn) {
    float dl = .5 * u_flowScale * textureLod(u_flow, vec2(az / (2. * PI) + .5, .5), 0.).r * max(0., 1. - abs(el) / u_flowW);
    wd0 = transpose(u_band) * sph(az, el - dl); wd1 = transpose(u_band) * sph(az, el + dl);
  }
  float th0, th1, r0, r1;
  vec2 p0 = lensPix(u_lens[0], wd0, th0, r0), p1 = lensPix(u_lens[1], wd1, th1, r1);
  if (u_proj == 7) { // dual fisheye, uncorrected: native lens images side by side
    vec2 q = vec2(X.x < 0. ? X.x + .5 : X.x - .5, X.y) * 2.;
    p0 = u_lens[0].size * (.5 + .5 * q); p1 = u_lens[1].size * (.5 + .5 * q);
    r0 = length(p0 - u_lens[0].intr.yz); r1 = length(p1 - u_lens[1].intr.yz);
    th0 = r0 / u_lens[0].intr.x; th1 = r1 / u_lens[1].intr.x;
    inside = abs(q.x) <= 1. && abs(q.y) <= 1.;
  }
  bool ok0 = r0 < u_lens[0].intr.w, ok1 = r1 < u_lens[1].intr.w;
  float w0 = smoothstep(-u_seam, u_seam, th1 - th0);
  if (!ok0) w0 = 0.; if (!ok1) w0 = 1.; if (!ok0 && !ok1) w0 = th0 < th1 ? 1. : 0.;
  if (u_proj == 7) w0 = X.x < 0. ? 1. : 0.;
  if (u_only >= 0) w0 = u_only == 0 ? 1. : 0.;
  // Outside the narrow overlap ring one lens has zero weight: skip its fetches (about half the texture work).
  // Mip derivatives must come from uniform control flow, so take them here and sample with textureGrad.
  vec2 t0 = p0 / u_lens[0].size, t1 = p1 / u_lens[1].size;
  vec2 g0x = dFdx(t0), g0y = dFdy(t0), g1x = dFdx(t1), g1y = dFdy(t1);
  vec3 s0 = vec3(0), s1 = vec3(0);
  if (w0 > 0.) s0 = sampleLens(u_tex0, u_lens[0], p0, g0x, g0y);
  if (w0 < 1.) s1 = sampleLens(u_tex1, u_lens[1], p1, g1x, g1y);
  float q0 = th0 * th0, q1 = th1 * th1;
  // Brightness/color differences between the lenses vary around the ring (sun, haze, flare at each lens edge): the
  // measured residual goes to the corrected lens (u_gainLens) and fades out slowly away from the seam, so no new edge appears.
  vec3 lg = u_gainOn ? textureLod(u_seamGain, vec2(az / (2. * PI) + .5, .5), 0.).rgb * max(0., 1. - abs(el) / u_gainW) : vec3(0);
  vec3 m1 = u_gainLens == 1 ? exp(lg) : vec3(1), m0 = u_gainLens == 0 ? exp(-lg) : vec3(1);
  vec3 cam = mix(s1 * u_lens[1].gain * m1 * (1. + u_lens[1].vig * q1 * q1), s0 * u_lens[0].gain * m0 * (1. + u_lens[0].vig * q0 * q0), w0);
  // clipped highlights (development marks them in alpha): neutral at their brightest channel, so specular glitter and
  // blown edges come out white instead of magenta, in DNG exports too
  float a0 = w0 > 0. ? textureGrad(u_tex0, t0, g0x, g0y).a : 1., a1 = w0 < 1. ? textureGrad(u_tex1, t1, g1x, g1y).a : 1.;
  float clipped = 1. - mix(a1, a0, w0);
  if (clipped > 0.) { vec3 wb = cam / u_neutral; cam = mix(cam, u_neutral * max(wb.r, max(wb.g, wb.b)), clipped); }

  if (u_mode == 3) { o = vec4(u_look * d, inside ? 1. : 0.); return; } // picking: level-frame direction
  // no image here: opaque black in exports, transparent on screen (u_flip) so the page's checkerboard shows through
  if (!inside) { o = vec4(0, 0, 0, u_mode == 0 && !u_flip ? 1. : 0.); return; }
  // linear camera RGB: 1 = alpha marks the lens overlap (gain match / seam align), 2 = alpha 1 (DNG, JPG align)
  if (u_mode == 1 || u_mode == 2) { o = vec4(max(cam, 0.), u_mode == 2 || (ok0 && ok1) ? 1. : 0.); return; }
  // 5: compact score input (RG16F): green in .r, validity in .g (lens overlap when one lens is forced, else 1)
  if (u_mode == 5) { o = vec4(max(cam.g, 0.), u_only < 0 || (ok0 && ok1) ? 1. : 0., 0, 1); return; }

  // Sharpening (picture output only; DNG carries it as a Lightroom setting): unsharp mask on green in log space, so
  // colors do not shift, against the next coarser mip level (~1 px blur at full size, the display scale when zoomed
  // out). The clamp keeps bright/dark edges from ringing.
  if (u_sharp > 0.) {
    float d0 = 0., d1 = 0.;
    if (w0 > 0.) d0 = log((s0.g + 1e-4) / (textureLod(u_tex0, t0, max(log2(max(length(g0x), length(g0y)) * u_lens[0].size.x), 0.) + 1.).g + 1e-4));
    if (w0 < 1.) d1 = log((s1.g + 1e-4) / (textureLod(u_tex1, t1, max(log2(max(length(g1x), length(g1y)) * u_lens[1].size.x), 0.) + 1.).g + 1e-4));
    cam *= exp(u_sharp * clamp(mix(d1, d0, w0), -.35, .35));
  }

  vec3 c = max(u_M * (cam / u_neutral), 0.); // WB, camera -> linear ProPhoto; above 1 = rebuilt highlights, for Highlights to pull back
  if (u_hasHsm) c = hsm(c);
  c *= u_expo;
  const vec3 PP_Y = vec3(.2880, .7119, .0001);
  float l = log2(max(dot(c, PP_Y), 1e-6));
  if (u_mode == 4) { o = vec4(l); return; } // base layer for shadows / highlights
  if (u_sh != 0. || u_hl != 0.) {
    // Local tone: adjust by the *neighbourhood* brightness so detail survives. Where a pixel differs strongly from
    // its blurred surroundings (sky/land edges) fall back to its own value, which avoids halos.
    float lb = texture(u_base, vec2(fx / u_res.x, row / u_res.y)).r;
    lb = mix(l, lb, exp(-.5 * (l - lb) * (l - lb)));
    float ev = lb - log2(.18); // stops relative to mid grey
    c *= exp2(u_sh * 1.8 * (1. - smoothstep(-5., -.5, ev)) + u_hl * 1.5 * smoothstep(-1., 2.5, ev));
  }
  c = vec3(tone(c.r), tone(c.g), tone(c.b));
  c = oetf(clamp(u_out * c, 0., 1.));
  // Purple fringe (bright violet-magenta halos around sun glitter, backlit edges): a plain color adjustment on each
  // pixel's own hue (centred on 305°) and brightness, like an HSL slider; no edge search. 0 = off.
  if (u_defringe > 0.) {
    float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b)), d = mx - mn;
    if (d > 1e-4) {
      float h = 60. * (mx == c.r ? mod((c.g - c.b) / d, 6.) : mx == c.g ? (c.b - c.r) / d + 2. : (c.r - c.g) / d + 4.);
      float k = u_defringe * (1. - smoothstep(20., 45., abs(h - 305.))) * smoothstep(.45, .85, mx);
      c = mix(c, vec3(dot(c, vec3(.2126, .7152, .0722))), k);
    }
  }
  float bp = -.06 * u_bk, wp = 1. - .12 * u_wh; // blacks / whites: move the end points
  c = clamp((c - bp) / (wp - bp), 0., 1.);
  float k = exp2(u_contrast);
  c = mix(.5 * pow(2. * c, vec3(k)), 1. - .5 * pow(2. - 2. * c, vec3(k)), step(.5, c));
  float Y = dot(c, vec3(.2126, .7152, .0722)), mx = max(c.r, max(c.g, c.b)), sat = mx > 0. ? (mx - min(c.r, min(c.g, c.b))) / mx : 0.;
  c = mix(vec3(Y), c, (1. + u_sat) * (1. + u_vib * (1. - sat)));
  // color mixer: eight hue bands centred like Lightroom's HSL panel, linear in between. Hue turns the color (same
  // HSV saturation and value), saturation mixes with grey, luminance scales by up to a stop, in proportion to how
  // colorful the pixel is (greys stay put).
  float hx = max(c.r, max(c.g, c.b)), hd = hx - min(c.r, min(c.g, c.b));
  if (hd > 1e-4) {
    float h = 60. * (hx == c.r ? mod((c.g - c.b) / hd, 6.) : hx == c.g ? (c.b - c.r) / hd + 2. : (c.r - c.g) / hd + 4.), hs = hd / hx;
    const float HUE[9] = float[9](0., 30., 60., 120., 180., 240., 270., 300., 360.);
    int i = 0;
    for (int k = 1; k < 8; k++) if (h >= HUE[k]) i = k;
    int j = (i + 1) % 8; float t = (h - HUE[i]) / (HUE[i + 1] - HUE[i]);
    float dh = mix(u_hslH[i], u_hslH[j], t), ds = mix(u_hslS[i], u_hslS[j], t), dl = mix(u_hslL[i], u_hslL[j], t);
    if (dh != 0.) c = hsv2rgb(mod((h + dh) / 60., 6.), hs, hx);
    c = mix(vec3(dot(c, vec3(.2126, .7152, .0722))), c, 1. + ds) * exp2(dl * hs);
  }
  if (u_grid && u_proj != 7) {
    float hy = (u_look * d).y;
    if (abs(hy) < fwidth(hy) * 1.5) c = mix(c, vec3(1, .8, 0), .8);
    if (abs(th1 - th0) < fwidth(th1 - th0) * .75) c = mix(c, vec3(1, 0, .3), .5);
  }
  o = vec4(clamp(c, 0., 1.), 1);
}`;

// Gradient NCC partial sums over 8x8 blocks: (Σab, Σaa, Σbb, n) of log-luminance gradients.
// Many candidates are scored per GPU round trip: candidate k lives at rows +k·stride of the a and/or b textures and
// writes its block sums at rows +u_rowOff of the result. a: luminance in .r, validity in .g (stitch mode 5).
// b: same layout, or an sRGB texture (camera JPG) sampled at a's pixel centers.
export const NCC = `#version 300 es
precision highp float;
uniform highp sampler2D u_a, u_b; uniform ivec2 u_size, u_aOff, u_bOff; uniform int u_rowOff; uniform bool u_jpg; uniform float u_lodB;
out vec4 o;
float A(ivec2 p) { return log(texelFetch(u_a, p + u_aOff, 0).r + 1e-4); }
float B(ivec2 p) {
  if (u_jpg) return log(dot(textureLod(u_b, (vec2(p) + .5) / vec2(u_size), u_lodB).rgb, vec3(.2126, .7152, .0722)) + 1e-3);
  return log(texelFetch(u_b, p + u_bOff, 0).r + 1e-4);
}
bool ok(ivec2 p) { return texelFetch(u_a, p + u_aOff, 0).g > .5; }
void main() {
  ivec2 b = (ivec2(gl_FragCoord.xy) - ivec2(0, u_rowOff)) * 8; vec4 s = vec4(0);
  for (int y = 0; y < 8; y++) for (int x = 0; x < 8; x++) {
    ivec2 p = b + ivec2(x, y), px = p + ivec2(1, 0), py = p + ivec2(0, 1);
    if (p.x >= u_size.x - 1 || p.y >= u_size.y - 1 || !ok(p) || !ok(px) || !ok(py)) continue;
    float a0 = A(p), b0 = B(p), ax = A(px) - a0, ay = A(py) - a0, bx = B(px) - b0, by = B(py) - b0;
    s += vec4(ax * bx + ay * by, ax * ax + ay * ay, bx * bx + by * by, 1);
  }
  o = s;
}`;

// Seam flow measurement: for azimuth bin x and vertical shift y - u_R, gradient-NCC sums between lens 0's band (u_a,
// validity in .g) and lens 1's band (u_b) shifted down by the shift. One output texel per (bin, shift).
export const FLOW = `#version 300 es
precision highp float;
uniform highp sampler2D u_a, u_b; uniform ivec2 u_size; uniform int u_bins, u_R;
out vec4 o;
float A(ivec2 p) { return log(texelFetch(u_a, p, 0).r + 1e-4); }
float B(ivec2 p) { return log(texelFetch(u_b, p, 0).r + 1e-4); }
bool ok(ivec2 p) { return texelFetch(u_a, p, 0).g > .5; }
void main() {
  int bin = int(gl_FragCoord.x), s = int(gl_FragCoord.y) - u_R, bw = u_size.x / u_bins;
  vec4 acc = vec4(0);
  for (int x = bin * bw; x < (bin + 1) * bw; x++) for (int y = u_R + 1; y < u_size.y - u_R - 2; y++) {
    ivec2 p = ivec2(x, y), q = ivec2(x, y + s), dx = ivec2(x + 1 < u_size.x ? 1 : 0, 0), dy = ivec2(0, 1);
    if (!ok(p) || !ok(p + dy) || !ok(q) || !ok(q + dy)) continue;
    float a0 = A(p), ax = A(p + dx) - a0, ay = A(p + dy) - a0, b0 = B(q), bx = B(q + dx) - b0, by = B(q + dy) - b0;
    acc += vec4(ax * bx + ay * by, ax * ax + ay * ay, bx * bx + by * by, 1);
  }
  o = acc;
}`;
