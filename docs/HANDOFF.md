# Hand-off: 360 RAW stitcher (image-quality review)

Browser-only (WebGL2, no dependencies) stitcher for dual-fisheye RAW: DJI Avata 360 (`_UP`/`_DOWN` DNG pair, 3840² or
7680² per lens) and Insta360 X4 (one DNG, both lenses side by side; 2944² or 5952² per lens). Develops the raw on
the GPU, stitches, exports JPEG (own 4:4:4 encoder) / 16-bit TIFF / linear DNG / Bayer DNG. zh/en UI.

The owner uses it personally (desktop + iPad A16) and **wants image quality first**. The goal of the next session:
find where the output can look better — closer to a good interchangeable-lens camera rendering: clear, saturated,
rich color — without breaking what is measured below.

## Ground rules

- Measure before and after every change (tools below). Report numbers, not impressions; show crops for visual claims.
- Discuss bigger changes with the owner before making them.
- Keep the no-dependency, single-page design. `src/` is the source; `node tools/build.mjs` bundles it into the root
  `index.html` (commit both). Workers may import exactly one module (dng.js / export.js), and modules must stay acyclic.
- iPad Safari has roughly 1.5 GB per tab: watch GPU memory (see the proxy below).
- `NOTICE.md` lists algorithms and patent notes; patent-safe mode (`S.safe`) must keep working.
- i18n strings live in `src/i18n.js` (both languages, same keys). An apostrophe inside a `'...'` string breaks the file.
- Commits: never use the company email. Ask the owner which name/email to use.

## Run and measure

- Dev server: `.claude/launch.json` (`tools/serve.py`, port 8765, no cache). Open
  `src/index.html?load=../ref/<files>` — `?load=` also exposes `window.__dbg` (state `S`, `load`, `autoTone`,
  `toneStats`, `timing`, `alignNCC`, `lenses`, ...).
- `node test/check.mjs`: encoder/decoder round trips, Bayer proxy, `decodeLenses` on the real samples (~1 min).
- `test/regress.js` (browser): `const R = await import('/test/regress.js')`, then
  - `R.shot(...paths)` loads like a drop; returns load time, alignment NCC, status line.
  - `R.exportBlob(fmt, width)` exports through the dialog; `R.pixels(blobOrUrl, W, H)` decodes.
  - `R.stats(px)` = L* 10/50/90/99th percentiles, mean Lab chroma, mean |Laplacian| of green ("detail"),
    cos-latitude weighted for equirect.
  - `R.geomMatch(ours, dji)` = best-yaw correlation of our equirect with the camera's own stitched JPG (`_D.JPG`).
  - `R.set(k, v)`, `R.proj(p)`.
- Compare against the previous build: `git show HEAD:index.html > _old.html`, open `/_old.html?load=...`, run the same
  loop, delete `_old.html` after.
- Benches: `tools/demosaic-bench.html` (RCD vs references, `?f=`), `tools/nr-bench.html` (wavelet vs NLM).

## Samples (`ref/`, gitignored)

| | Files | Notes |
|---|---|---|
| Avata 360 3840² | `ref/avata 360/DJI_2026*` (17 shots before 2026-11) | each with DJI's own `_D.JPG` |
| Avata 360 7680² | `DJI_20261112130051_0019` … `_0022` | new high-res mode, ISO 100–400, `_D.JPG` too |
| X4 2944² | `ref/X4/IMG_*` (incl. sun shots 026/027) | no camera JPG |
| X4 5952² (72 MP) | `ref/X4/IMG_20261112_*_069/_070` | gain-map DNG, white 29342.2, clipped = 65535 marker |
| Night / lights | `DJI_20261004175341_0047` (ISO 1000) | point lights, dehaze stress |

## Pipeline (where to look)

Decode (worker): `src/dng.js` `parseDNG` (LJ92, gain maps → clipped pixels become 65535 and `white` drops; noise
profile or estimate) → `decodeLenses` (split X4, half-size Bayer **proxy** `bayerHalf` when a lens > 5000²).

Development, per lens, `src/develop.js` `develop()` (shaders in `src/shaders.js`):
1. `NORM` (clipped → 1.0) or raw denoise `NR_PACK` → `NR_ATROUS`/`NR_NLM` → `NR_UNPACK` (variance-stabilized,
   luma/chroma planes; `measureNoise` calibrates the profile per source).
2. RCD demosaic: `RCD_DIR`, `RCD_LPF`, `RCD_GREEN`; lateral CA on the mosaic `CA_CFA` (profile CA + DNG WarpRectilinear);
   `RCD_RB1`, `RCD_RB2` (clip flags in alpha).
3. `CHROMA_MED` ×2 (false color), highlight reconstruction `HL_GUIDE` + `HL_RECON`.
4. Lens deblur: Richardson–Lucy, 6 iterations, radial Gaussian PSF `profile.deblur {s0, s1}` (set **by eye**), on luma.
5. RGBA16F texture + mipmaps.

Rendering, per output pixel, `STITCH` (`src/shaders.js`, `src/render.js` `draw()`): projection → lens model (DJI:
equidistant + k1/k2; X4: Mei/unified) → seam blend (+ optical-flow parallax, per-azimuth seam gain on the darker
lens) → clipped → neutral → sharpening + texture (mip bands, "Sharpening and texture" comment) → WB, camera→ProPhoto,
HueSatMap → exposure → dehaze (dark channel, light above white passes) → local tone: shadows/highlights/clarity from
the blurred base layer (`renderBase`, 512 px, weighted) → luminance-preserving gamut map above white → tone curve LUT
(DNG ProfileToneCurve, else a DJI-like base curve) → sRGB → defringe → whites/blacks/contrast → saturation/vibrance →
HSL mixer. Export uses `hq` sampling (clamped Catmull-Rom near 1:1, mips when shrinking).

Auto tone (`src/app.js` `autoTone`, runs on every open): median luma .48, 90th .79 (Highlights to −100), 2nd ≥ .05,
99th non-white ≤ .95; vibrance to 1.15 × the scene's own Lab chroma (fitted on 17 DJI shots vs their JPGs).
Proxy: edits on the half-size mosaic; export develops the full raw (`useFull`) unless the output is ≤ 1/8 native width.

## Baseline (2026-11-12, commit 3e7d0c5; equirect JPEG 2048 wide, measured at 1024×512)

| Shot | geom vs DJI | L* 10/50/90/99 | chroma | detail | DJI JPG L* 10/50/90/99, chroma, detail |
|---|---|---|---|---|---|
| 3840 0025 day | .83 | 18/53/82/100 | 29.2 | 21.2 | 19/55/76/95, 28.0, 27.8 |
| 3840 0047 night | .98 | 17/54/77/100 | 20.7 | 8.7 | 10/45/71/93, 18.1, 6.4 |
| 3840 0011 | .98 | 12/52/80/96 | 12.8 | 3.4 | 18/63/83/94, 12.3, 3.8 |
| 7680 0019 | .94 | 27/53/81/91 | 15.2 | 8.7 | 35/61/81/88, 17.1, 10.0 |
| 7680 0020 | .95 | 16/53/81/89 | 12.3 | 11.8 | 20/62/82/90, 12.6, 14.1 |
| 7680 0021 | .94 | 24/53/81/91 | 13.7 | 9.9 | 33/61/81/88, 15.9, 12.6 |
| 7680 0022 | .94 | 19/53/81/91 | 11.5 | 10.5 | 31/62/81/88, 14.4, 13.9 |
| X4 026 (sun) | – | 26/51/80/98 | 18.4 | 15.0 | – |
| X4 069 72 MP | – | 19/51/81/92 | 6.5 | 10.5 | – |

## Where quality likely can improve (hypotheses — verify first)

1. **Detail / micro-contrast**: DJI's JPGs measure 15–30 % more "detail" on most shots. Candidates: default
   sharpening (25) and texture (0), the deblur PSF (set by eye; 7680² values are just the 3840² ones ×2 — measure on
   edges), RCD vs a stronger demosaic, sharpening radius on 7680² (twice the pixels per degree).
2. **Mid-tones and shadows**: on daylight 7680² shots DJI sits at median L* ~61 and lifts shadows (L10 31–35) while
   we hold median ~53. The .48 target came from the 17 older shots; a scene-adaptive target may fit better.
3. **Night**: DJI keeps night darker (0047 median 45 vs our 54) — auto tone brightens it, raising noise.
4. **Color**: chroma 10–20 % below DJI on the 7680² shots.
5. **Purple fringing** on backlit edges (X4 026 balustrade): defringe defaults to 0; residual lateral CA.
6. **Highlight reconstruction** around the sun (X4 026): check transitions at the clip edge.
7. **Seam**: 0025's geometry correlation is .83 (others .94–.98); check whether that is leveling/yaw or a real seam error.
8. **Proxy preview** is softer at high zoom (edit-only; exports use the full raw).

## Review of 2026-11-12 (after the baseline above; uncommitted at the time of writing)

Done, each measured on shot 0025 (equirect JPEG):
- **360° wrap line**: the local-tone base blur clamped at the left/right edges, so the ±180° meridian got two different
  bases: up to 7.7 levels (8-bit) across it in the sky with auto tone (hl −66), 0 with hl = sh = 0. `BLUR` now wraps
  when the picture spans 360° (`u_wrap`, base texture `REPEAT`): 0. Check: `R.wrapSeam()`.
- **Saturation past white**: after saturation/vibrance a color is pulled toward its luminance until it fits, instead
  of clipping a channel. Small effect on this shot (mean hue shift of the affected pixels 0.85° → 0.68°); it matters
  at high Saturation.
- **7680² blue CA**: `scaleProfile` drops the blue residual for other frame sizes (see its comment).

Edges ("not clean", the owner's words; asked for backlit and 7680² shots) — what was measured:
- Not the development: on the developed lens texture the normalized R/G/B edge profiles agree within ~1 % of the edge
  contrast beyond 3 px, with or without median, deblur, sharpening. What is left is lateral CA of a few tenths of a
  pixel and a blue skirt on the outward dark side (~2-4 % of contrast over 3-8 px at 7680²). On a 10:1 edge 2 % of
  the bright side is 20 % of the dark side, and the camera→sRGB matrix about doubles it: that is the tint.
- Lateral CA by `R.caResidual()` (shift vs green in px of the frame, + = outward, rim zone, shots pooled):

  | | DNG warp only | + profile `ca` (before) | red residual only |
  |---|---|---|---|
  | 7680² UP (4 shots) | R +.22, B −.03 | R +.12, B +.22 | R +.12, B −.03 |
  | 7680² DOWN | R +.08, B +.03 | R +.02, B +.19 | R +.02, B +.03 |
  | 3840² UP (6 shots: 0011 0022 0025 0028 0034 0041) | R −.09, B +.11 | R −.13, B +.24 | – |
  | 3840² DOWN | R −.30, B +.27 | R −.32, B +.34 | – |

  So at 3840² the shipped residual does not help by this measure either, and the DOWN lens keeps red and blue ~0.6 px
  apart at the rim. **Not changed** (3840² is the tuned default): a least-squares fit of the DNG-only shifts gives the
  residual that would cancel them, [r², r⁴]: UP R [.00061, −.00208], B [−.00015, .00093]; DOWN R [.00042, −.00252],
  B [.00017, .00081]. Unverified: apply via `R.caResidual([{R, B}, {R, B}])`, pool the same shots, iterate, then
  compare exports. The earlier offline fit used another measure; find out why the two disagree before replacing it.
- DJI's JPG shows flat color differences across the same edges (it low-passes chroma). The plain false-color median
  reaches ±2 px whatever the frame: at 7680² that is half the angle. Scaling its step with `profile.k / bin` is allowed
  (no edge detection: NOTICE.md, US 8,582,878) and untested.
- Per-channel sharpness: deblur works on luminance and keeps the channel ratios, so a color with a wider PSF keeps its
  skirt. A per-channel PSF (or blurring the sharper channel to match) would address it; memory is the limit (5 R16F
  scratch planes per lens today).

Other hypotheses from the review, unverified: no default luma NR although auto tone brightens night shots (0047:
detail 8.7 vs DJI 6.4 is likely noise); sharpening against the 2×2 box mip has a phase-dependent kernel (edge strength
alternates per pixel); the seam is a plain ±4° feather (two-band blend from the mips would keep detail); RL deblur has
no noise damping; 8-bit JPEG without dither; tone LUT is linear in x (coarse in the shadows); JPEG export has no EXIF
date/model (TIFF and DNG do). Ruled out: no ForwardMatrix / ProfileLookTable in the DJI or X4 DNGs.

Verified 2026-11-12 (Opus): `wrapSeam` 7.73 → 0 levels; the 9-shot regression matches the baseline (7680² within
±0.4 detail / ±0.2 chroma from the blue-CA change). Export dialog now has size presets 1:1 / half each way (the
owner finds half "denser"; the fraction is remembered per viewer).

Edge follow-up (Opus, 2026-11-12), measured with `R.fringe` (edge false color on ½-size equirect exports; the
horizon band ±30° is where the Avata lens rims land):
- **Median reach scaled to the frame** (`medStep` = profile.k / proxy bin, so 7680² uses step 2 = the 3840² angle):
  7680² fringe 2.60 → 2.36 (0019), 2.52 → 2.36 (0022), detail −1 %. Kept.
- **New 3840² CA residual (the caResidual fit above): rejected.** It moves the measured rim shifts to ~0 but the
  exports get 3–8 % *more* fringe on all of 0025/0011/0028/0041 (band 6.41→6.62, 5.08→5.50, 6.32→6.59,
  2.54→2.64). The shipped residual measures the same as no residual (6.42/4.91/6.40/2.50). Lateral CA is not what
  makes these edges dirty; the per-channel PSF (blue skirt) remains the lead.
- More median passes (3): no change (≤0.3 %). A median twice as wide (step 2 at 3840², 4 at 7680²): fringe −5…−23 %,
  but it erases small saturated details (a 2–3 px red sign in 0011 lost its color). Not kept; would need to be an
  option, if ever.

Measuring tips: `tabs` hidden = throttled timers (minutes instead of seconds); the JS tool times out at 45 s, so start
long loops without awaiting them and poll.

## Gotchas

- Clipped pixels: DJI clip = white (62400); gain-map DNGs (X4) mark clipped as 65535 with `clip` 65535 and
  `white` lowered. NORM/NR_PACK map clipped to 1.0; RB2 flags from the raw.
- Proxy vs full must look the same: the mip LOD comes from `textureSize`, geometry stays in full-raw pixels
  (`L.full` size), deblur scales by `d.bin`, `profile.k` scales DJI pixel quantities for 7680².
- Shader-only looks (sharpening, texture, clarity, dehaze, HSL) travel to DNG as Lightroom `crs:` XMP, not pixels.
- `isBusy()` (a JS flag) blocks input and `render()` during loads/exports; `idle()` repaints.
- `nativeWidth()` uses f/(1+xi) for the Mei model.
