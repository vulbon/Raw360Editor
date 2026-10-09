// Shared mutable state. ES modules are singletons, so every module importing these sees the same objects.
import { DEFAULTS } from './config.js';

// User settings (sliders, toggles, view)
export const S = { ...DEFAULTS };

// The loaded shot and everything derived from it
export const session = {
  lenses: [], profile: null,
  neutral: [1, 1, 1], M: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], // white balance: camera neutral, camera → ProPhoto
  toneTex: null, hsmTex: null, hsmDims: [1, 1, 1],          // DJI profile tone curve / hue-sat map
  flowTex: null, flowStats: null, seamGainTex: null, gainLens: 1,          // seam corrections
};
