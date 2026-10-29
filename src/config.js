// Static configuration: camera profiles, projections, UI tables, defaults and algorithm constants.
const RAD = Math.PI / 180;

// ---------- camera profiles: fisheye model r = f·θ(1 + k1θ² + k2θ⁴), R = world→lens ----------
// Fitted against the camera's own stitched JPG. World: x right, y down, z forward. `mount` (yaw, pitch, roll in degrees)
// relates the drone body to that world, least-squares fitted over 17 shots' JPG leveling (0.72° rms), so any shot can be
// leveled from its flight roll/pitch.
// `ca`: lateral chromatic aberration left after the camera's own DNG warp, extra r² and r⁴ radial scale of red and blue
// vs green. A fixed lens property, measured once offline (mean of per-shot fits over the sample shots: 17 Avata 360,
// 11 X4), so nothing is estimated from the user's image.
export const PROFILES = [
  { match: /FCA188|Avata ?360/i, name: 'DJI Avata 360', mount: [-1.10, 0.52, 17.29],
    // deblur: lens blur sigma in pixels at the centre and at the image circle (Richardson-Lucy, see DEBLUR); by eye
    deblur: { s0: 0.5, s1: 1.4 },
    // lens 2 seam correction, mean of per-shot auto-align on textured shots; starting point + prior for new shots
    l2: { ryaw: 0.156, rpitch: 0.235, rroll: 0.241, f2: 0.9897, cx2: -5.14, cy2: 3.81 }, lenses: {
    UP: { f: 1143.811, cx: 1931.778, cy: 1922.828, k1: -0.0016576, k2: -0.00089411, rmax: 1870, ca: { R: [0, 0.00023], B: [-0.00009, -0.00047] },
      R: [[0.96132109, 0.27541871, 0.00250993], [-0.00464392, 0.00709633, 0.99996404], [0.27539100, -0.96129817, 0.00810088]] },
    DOWN: { f: 1045.327, cx: 1906.643, cy: 1921.074, k1: 0.0816073, k2: -0.0175507, rmax: 1870, ca: { R: [0.00003, 0.00008], B: [-0.00018, -0.00003] },
      R: [[-0.96558136, -0.25978924, -0.01273536], [-0.01287472, -0.00116523, 0.99991644], [-0.25978237, 0.96566464, -0.00221959]] },
  } },
];
// Unknown camera: ideal back-to-back equidistant lenses, ~190° each. Tune with the lens sliders.
export const generic = w => ({ name: 'Dual fisheye', mount: [0, 0, 0], deblur: { s0: 0.5, s1: 1.2 }, lenses: {
  0: { f: w / 2 / 1.66, cx: w / 2, cy: w / 2, k1: 0, k2: 0, rmax: w * 0.487, R: [[1, 0, 0], [0, 0, 1], [0, -1, 0]] },
  1: { f: w / 2 / 1.66, cx: w / 2, cy: w / 2, k1: 0, k2: 0, rmax: w * 0.487, R: [[-1, 0, 0], [0, 0, 1], [0, 1, 0]] },
} });

// Insta360 (one DNG, lenses side by side): the camera's own per-shot calibration (unified/Mei model, see
// instaCalibration in dng.js), moved from its calibW×calibH frame into each square half. Each half is the central
// square of its lens's (calibW/2)×calibH area. Lens 1 faces backwards.
// ponytail: INSTA_SCALE is measured, not derived: the seam aligns best at 1.04-1.045 x the calibW/calibH-to-DNG scale on
// three X4 shots (115, 129, 133); revisit if another Insta360 model or firmware disagrees.
const INSTA_SCALE = 1.04;
const X4_CA = [{ R: [0.00007, 0.00035], B: [0.00085, -0.00087] }, { R: [0.00005, 0.00035], B: [0.00044, 0.0002] }];
export function instaProfile(src) {
  const S = src.height, R0 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]], R1 = [[-1, 0, 0], [0, 1, 0], [0, 0, -1]];
  const lens = (c, i) => {
    const s = INSTA_SCALE * S / c.calibH, rmax = 0.97 * S / 2;
    // centre: the calibrated offset from the lens area's middle, scaled (the crop is centred on it)
    const g = { model: 1, f: c.fx * s, fy: c.fy * s, cx: S / 2 + (c.cx - (i + 0.5) * c.calibW / 2) * s, cy: S / 2 + (c.cy - c.calibH / 2) * s, xi: c.xi, k1: c.k1, k2: c.k2, k3: c.k3, p1: c.p1, p2: c.p2, rmax, R: i ? R1 : R0, ca: /X4/.test(src.model) ? X4_CA[i] : null };
    // the projection folds back past its widest angle: stop at the first angle that reaches the image circle or stops growing
    let th = 0, prev = 0;
    for (let a = 0.01; a < 2.6; a += 0.005) {
      const m = Math.sin(a) / (Math.cos(a) + g.xi), q = m * m, r = g.f * m * (1 + q * (g.k1 + q * (g.k2 + q * g.k3)));
      if (r >= rmax || r <= prev) break;
      th = a; prev = r;
    }
    return { ...g, thmax: th };
  };
  // imu: accelerometer axes -> lens 1 axes (x right, y down, z forward). Found by leveling shots held pitched 46 deg (129),
  // rolled 62 deg (133) and dipped at a pool window (117) from the trailer's gravity alone: all three come out level.
  return { name: src.model || 'Insta360', mount: [0, 0, 0], deblur: { s0: 0.5, s1: 1.2 }, imu: [[0, 0, 1], [-1, 0, 0], [0, 1, 0]],
    lenses: Object.fromEntries(src.insta.map((c, i) => [i, lens(c, i)])) };
}

export const PROJ = {
  equirect: { id: 0, fov: 360, aspect: '2:1' }, planet: { id: 4, fov: 300, max: 350, pitch: -90, aspect: '1:1' },
  tunnel: { id: 4, fov: 300, max: 350, pitch: 90, aspect: '1:1' }, rectilinear: { id: 3, fov: 100, max: 170, aspect: 'free' },
  pannini: { id: 6, fov: 150, max: 300, aspect: 'free' }, stereographic: { id: 4, fov: 220, max: 350, aspect: 'free' },
  fisheye: { id: 5, fov: 200, aspect: '1:1' }, cylindrical: { id: 1, fov: 360, aspect: 'free' },
  mercator: { id: 2, fov: 360, aspect: 'free' }, dual: { id: 7, fov: 360, aspect: '2:1' },
};
export const ASPECTS = { free: 0, '2:1': 2, '16:9': 16 / 9, '3:2': 1.5, '4:3': 4 / 3, '1:1': 1, '4:5': 0.8, '9:16': 9 / 16 };
// Lightroom-style color mixer: eight hue bands (centres in degrees), each with hue / saturation / luminance sliders
// (keys hueR, satR, lumR, ... by the band's initial).
export const HSL_BANDS = ['Red', 'Orange', 'Yellow', 'Green', 'Aqua', 'Blue', 'Purple', 'Magenta'];
export const HSL_HUES = [0, 30, 60, 120, 180, 240, 270, 300];
const hslSliders = p => HSL_BANDS.map(b => [p + b[0], -100, 100, 1]);
export const SLIDERS = {
  view: [['fov', 10, 360, 1], ['stretch', 0.5, 2, 0.01], ['pd', 0, 2, 0.01], ['yaw', -180, 180, 0.1], ['pitch', -90, 90, 0.1]],
  level: [['lroll', -45, 45, 0.05], ['lpitch', -45, 45, 0.05], ['lyaw', -180, 180, 0.1]],
  wb: [['temp', 2000, 15000, 10], ['tint', -150, 150, 1]],
  tone: [['ev', -5, 5, 0.01], ['contrast', -100, 100, 1], ['hl', -100, 100, 1], ['sh', -100, 100, 1], ['wh', -100, 100, 1], ['bk', -100, 100, 1]],
  presence: [['texture', -100, 100, 1], ['clarity', -100, 100, 1], ['dehaze', 0, 100, 1], ['vib', -100, 100, 1], ['sat', -100, 100, 1]],
  hslH: hslSliders('hue'), hslS: hslSliders('sat'), hslL: hslSliders('lum'),
  noise: [['deblur', 0, 100, 1], ['sharp', 0, 100, 1], ['nr', 0, 100, 1], ['nrc', 0, 100, 1]],
  lens: [['seam', 0.1, 5, 0.1], ['vig', 0, 0.15, 0.001], ['defringe', 0, 100, 1]],
};

export const DEFAULTS = {
  proj: 'equirect', aspect: '2:1', fov: 360, yaw: 0, pitch: 0, stretch: 1, pd: 1,
  lyaw: 0, lpitch: 0, lroll: 0, grid: false, guide: 'none',
  temp: 5500, tint: 0, ev: 0, contrast: 0, hl: 0, sh: 0, wh: 0, bk: 0, sat: 0, vib: 0, texture: 0, clarity: 0, dehaze: 0, sharp: 25, deblur: 50, nr: 0, nrc: 30,
  seam: 4, flow: true, vig: 0, defringe: 0, ca: true, safe: false, autoAlign: true, fscale: 1, ryaw: 0, rpitch: 0, rroll: 0, f2: 1, cx2: 0, cy2: 0,
  ...Object.fromEntries(['hue', 'sat', 'lum'].flatMap(p => hslSliders(p).map(([k]) => [k, 0]))),
};

// Unrolled projections pan vertically instead of tilting the sphere (tilting bends the horizon into a wave).
export const PAN_PROJ = ['equirect', 'cylindrical', 'mercator', 'pannini'];

// Refined per shot by the seam alignment: lens 2 relative to lens 1, and a focal scale shared by both.
export const ALIGN_KEYS = ['ryaw', 'rpitch', 'rroll', 'f2', 'cx2', 'cy2', 'fscale'];

// Seam band: the overlap ring rendered as a strip ±BAND_DEG/2 around lens 0's 90° circle.
export const BAND_DEG = 7;
// Seam flow (parallax): measured at FLOW_W band width, FLOW_BINS azimuth bins, ±FLOW_R px search, faded over FLOW_FADE.
export const FLOW_W = 4096, FLOW_BINS = 128, FLOW_R = 10, FLOW_FADE = 10 * RAD;
// Seam gain (local exposure/color match): GAIN_BINS sectors, faded over GAIN_FADE.
export const GAIN_BINS = 64, GAIN_FADE = 25 * RAD;
