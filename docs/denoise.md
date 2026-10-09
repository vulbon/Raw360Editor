# Noise reduction: comparison and device tiers

All denoising runs in the raw Bayer domain before demosaicing, on the GPU (`develop.js`, `NR_*` shaders):
generalized Anscombe transform → orthonormal luma/chroma rotation of the four CFA planes → denoise → exact-unbiased
inverse transform → demosaic.

## Method

`tools/nr-bench.html` (open it from the dev server) runs the real GPU code path.

- **Clean reference**: ISO 200 sample `0011`, each output CFA site is the mean of 16 same-color sites in an 8×8 block
  (noise ÷ 4, Bayer layout kept), 960×960, brightened to a mean of 0.12.
- **Noise**: synthetic Poisson–Gaussian, variance = S·x + O, written into the DNG `NoiseProfile` the code reads.
- **Score**: PSNR against the clean mosaic after a 1/2.2 gamma (errors in shadows count like the eye sees them).
- **Speed**: full 3840² lens, median of 3, timed to a 1-pixel readback (`gl.finish()` does not block on ANGLE/D3D11,
  it reported 0 ms).

## Results (Intel Iris Xe, Chrome 152, ANGLE D3D11)

| Method | ≈ISO 1600 (S=1e-4) | ≈ISO 6400 (S=4e-4) | ms / lens |
|---|---:|---:|---:|
| off | 43.39 dB | 38.29 dB | 17 |
| color only (wavelet) | 47.51 | 42.27 | 132 * |
| wavelet, luma 50 | 49.73 | 45.02 | 131 * |
| wavelet, luma 75 (best) | 49.71 | **45.41** | 134 * |
| NLM R3, h 0.7 | 51.30 | 47.71 | 185 * |
| **NLM R3, h 1.0 (best)** | **51.42** | **48.04** | 231 * |
| NLM R5, h 1.0 | 51.40 | 48.12 | 218 * |
| NLM R2, h 1.0 | 51.33 | 47.76 | 207 * |

\* includes the per-lens noise measurement (two 512² readbacks + a median), which the app does once per lens.

- NLM (luma) + wavelet (chroma) beats wavelets alone by **+1.7 dB** at moderate and **+2.6 dB** at heavy noise.
- Search radius 5 buys nothing over 3; radius 2 loses a little. **R3** it is.
- The NLM bandwidth peaks near **h = 1.0σ**; the luma slider maps 0–100 to h 0–1.3.
- The noise estimator returned ×1.07 and ×1.02 for a true ×1.00, so thresholds track the real noise even though
  DJI writes a nearly ISO-independent `NoiseProfile` (measured: real noise ≈ 0.45× the profile at ISO 1000).

## Device tiers

UA sniffing does not tell how fast a GPU is, so `dev.pickMethod()` measures: one NLM R3 pass on a 512² tile
(after a warm-up), extrapolated to a 1920² packed lens.

| Estimate per lens | Luma NR | Notes |
|---|---|---|
| < 400 ms | NLM R3 + wavelet chroma | desktops, laptops with an iGPU (Iris Xe picks NLM; the whole probe incl. warm-up took 31 ms) |
| ≥ 400 ms | wavelet | phones / old GPUs; ~2 dB less but bounded cost, 29 MB less scratch |

Color NR is always the wavelet path (cheap, and blotchy chroma needs the coarse scales NLM cannot reach).

## Not adopted (yet)

- **ML denoisers** (see the research notes in the conversation log): best candidate is YOND/SNR-Net (MIT, raw domain,
  noise-level input, trained for unseen cameras; ~1–4 s per lens on WebGPU, estimated). Needs ONNX export and
  onnxruntime-web (WebGPU with WASM fallback) — a ~2 MB+ dependency, so it would be an optional “max quality” tier
  loaded on demand, gated on `navigator.gpu`. PMRID (Apache-2.0) is the fallback candidate.
- **GALOSH** (Apache-2.0, Walsh–Hadamard block shrinkage): reported faster than NLM on desktop GPUs; worth a bench run
  against NLM R3 before considering it.
- **Avoid**: DualDn, LED (CC BY-NC), BM3D (non-commercial), diffusion denoisers (too slow, hallucinate detail).
