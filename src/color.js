// 3x3 matrix helpers, rotations, and DNG color math (white balance ↔ temperature/tint, camera → ProPhoto).

export const mm = (A, B) => A.map(r => [0, 1, 2].map(j => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]));
const mv = (A, v) => A.map(r => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
export const tr = A => A[0].map((_, j) => A.map(r => r[j]));
const m9 = a => [a.slice(0, 3), a.slice(3, 6), a.slice(6, 9)];
function inv([[a, b, c], [d, e, f], [g, h, i]]) {
  const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g, det = a * A + b * B + c * C;
  return [[A, c * h - b * i, b * f - c * e], [B, a * i - c * g, c * d - a * f], [C, b * g - a * h, a * e - b * d]].map(r => r.map(x => x / det));
}
export const RAD = Math.PI / 180;
export const rx = a => [[1, 0, 0], [0, Math.cos(a), -Math.sin(a)], [0, Math.sin(a), Math.cos(a)]];
export const ry = a => [[Math.cos(a), 0, Math.sin(a)], [0, 1, 0], [-Math.sin(a), 0, Math.cos(a)]];
export const rz = a => [[Math.cos(a), -Math.sin(a), 0], [Math.sin(a), Math.cos(a), 0], [0, 0, 1]];
// L = ry(yaw)·rx(pitch)·rz(roll)  →  [yaw, pitch, roll] in degrees
export const eulerYXZ = L => [Math.atan2(L[0][2], L[2][2]), Math.asin(-L[1][2]), Math.atan2(L[1][0], L[1][1])].map(a => a / RAD);
// Rotation taking unit vector a onto unit vector b (Rodrigues). Opposite vectors (a camera hanging upside down) have no
// unique axis: turn half way round x, which is perpendicular to "down".
export function fromTo(a, b) {
  const c = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  if (c < -1 + 1e-12) return [[1, 0, 0], [0, -1, 0], [0, 0, -1]];
  const v = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]], k = 1 / (1 + c);
  const V = [[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]], V2 = mm(V, V);
  return [0, 1, 2].map(i => [0, 1, 2].map(j => (i === j ? 1 : 0) + V[i][j] + V2[i][j] * k));
}

const XYZ_PP = [[1.3459433, -0.2556075, -0.0511118], [-0.5445989, 1.5081673, 0.0205351], [0, 0, 1.2118128]];
const XYZ50_SRGB = [[3.1338561, -1.6168667, -0.4906146], [-0.9787684, 1.9161415, 0.0334540], [0.0719453, -0.2289914, 1.4052427]];
export const PP_SRGB = mm(XYZ50_SRGB, inv(XYZ_PP));
const BRADFORD = [[0.8951, 0.2664, -0.1614], [-0.7502, 1.7135, 0.0367], [0.0389, -0.0685, 1.0296]];
const D50 = [0.96422, 1, 0.82521];
const ILLUM_K = { 1: 5500, 2: 4150, 3: 2856, 4: 5500, 10: 6500, 11: 7500, 12: 6400, 13: 5000, 14: 4200, 15: 3450, 17: 2856, 18: 4874, 19: 6774, 20: 5503, 21: 6504, 22: 7504, 23: 5003, 24: 3200 };

function adapt(src, dst) {
  const s = mv(BRADFORD, src), d = mv(BRADFORD, dst);
  return mm(inv(BRADFORD), mm([[d[0] / s[0], 0, 0], [0, d[1] / s[1], 0], [0, 0, d[2] / s[2]]], BRADFORD));
}
// Planckian locus in CIE 1960 uv (Krystek); tint uses the DNG SDK scale (1/3000 uv per unit, + = magenta)
const planck = T => [(0.860117757 + 1.54118254e-4 * T + 1.28641212e-7 * T * T) / (1 + 8.42420235e-4 * T + 7.08145163e-7 * T * T),
  (0.317398726 + 4.22806245e-5 * T + 4.20481691e-8 * T * T) / (1 - 2.89741816e-5 * T + 1.61456053e-7 * T * T)];
function normal(T) { const a = planck(T * 0.99), b = planck(T * 1.01), du = b[0] - a[0], dv = b[1] - a[1], l = Math.hypot(du, dv); return [dv / l, -du / l]; }
export function xyFromTempTint(T, tint) {
  const p = planck(T), n = normal(T), o = -tint / 3000, u = p[0] + n[0] * o, v = p[1] + n[1] * o, d = 2 * u - 8 * v + 4;
  return [3 * u / d, 2 * v / d];
}
export function tempTintFromXY([x, y]) {
  const d = -2 * x + 12 * y + 3, u = 4 * x / d, v = 6 * y / d;
  const err = m => { const p = planck(1e6 / m); return (u - p[0]) ** 2 + (v - p[1]) ** 2; };
  let a = 20, b = 700;
  for (let i = 0; i < 60; i++) { const m1 = b - (b - a) * 0.618, m2 = a + (b - a) * 0.618; if (err(m1) < err(m2)) b = m2; else a = m1; }
  const T = 2e6 / (a + b), p = planck(T), n = normal(T);
  return [T, -3000 * ((u - p[0]) * n[0] + (v - p[1]) * n[1])];
}
// weight of illuminant 1 at temperature T (inverse-CCT interpolation, per DNG spec)
export function illumWeight(src, T) {
  if (!src.cm2) return 1;
  const t1 = ILLUM_K[src.illum1] || 2856, t2 = ILLUM_K[src.illum2] || 6504;
  return Math.min(1, Math.max(0, (1 / T - 1 / t2) / (1 / t1 - 1 / t2)));
}
function cmAt(src, T) {
  const g = illumWeight(src, T), a = m9(src.cm1), b = src.cm2 ? m9(src.cm2) : a;
  return a.map((r, i) => r.map((x, j) => g * x + (1 - g) * b[i][j]));
}
export function xyOfNeutral(src, n) {
  let xy = [0.3457, 0.3585];
  for (let i = 0; i < 5; i++) { const X = mv(inv(cmAt(src, tempTintFromXY(xy)[0])), n), s = X[0] + X[1] + X[2]; xy = [X[0] / s, X[1] / s]; }
  return xy;
}
export function neutralOfXY(src, xy) {
  const n = mv(cmAt(src, tempTintFromXY(xy)[0]), [xy[0] / xy[1], 1, (1 - xy[0] - xy[1]) / xy[1]]);
  return n.map(v => v / n[1]);
}
// white-balanced camera RGB (cam / neutral) -> linear ProPhoto (D50)
export function camToPP(src, n) {
  const ci = inv(cmAt(src, tempTintFromXY(xyOfNeutral(src, n))[0]));
  return mm(XYZ_PP, mm(adapt(mv(ci, n), D50), ci)).map(r => r.map((x, j) => x * n[j]));
}
