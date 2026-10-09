# Notices

Status checked 2026-10-08/09 against patent records and license texts (summaries, not legal advice).

## Third-party code

None. All code in this repository is original; there are no runtime dependencies, CDN scripts or bundled fonts.
`test/check.mjs` uses only Node.js built-ins.

## Adobe DNG

This product includes DNG technology under license by Adobe.

Reading and writing DNG relies on Adobe's royalty-free DNG Specification Patent License, which covers reading and
writing DNG-compliant files and asks for the sentence above in the source code and documentation (it is also shown on
the app's start screen and at the top of `src/dng.js` / `src/export.js`). The license can be revoked for a party that sues
Adobe over DNG patents. XMP metadata is covered by Adobe's royalty-free XMP Specification Public Patent License.

## Algorithms (implemented from published descriptions, no code copied)

| Algorithm | Reference | Patent status |
|---|---|---|
| Lossless JPEG (Huffman process) | ITU-T T.81 (1992) | Annex L lists only arithmetic-coding patents; not used here |
| Demosaic: RCD (ratio-corrected directional green, color-difference R/B; replaced Hamilton–Adams 2026-10-09, +0.8-3 dB in `tools/demosaic-bench.html`) | L. Sanz Rodríguez, RCD (2017), implemented from its description, no code copied | none known, not formally screened (Hamilton–Adams' US 5,629,734 expired 2015) |
| Generalized Anscombe transform, closed-form unbiased inverse | Mäkitalo & Foi, IEEE TIP 2011/2013 | none found (the authors' *code* is non-commercial; not used) |
| À-trous wavelet shrinkage | standard | none found in force |
| Non-local means | Buades, Coll, Morel, CVPR 2005 | US 8,253,825 / 8,427,559 lapsed (fees), EP withdrawn |
| Planckian locus, Bradford adaptation | Krystek 1985; Lam 1985 | public formulas, none known |
| Seam alignment: NCC of gradients, compass / pattern search | Lewis 1995; Hooke & Jeeves 1961 | textbook methods; **see Stitching below** |
| Lens gain matching and per-sector RGB seam gain, both applied to the darker lens only | Brown & Lowe, IJCV 2007 (gain compensation) | **see Stitching below** |
| Seam flow: 1-D block matching per azimuth bin, smoothed, each lens shifted half the offset | standard block matching | **see Stitching below** |
| Leveling: Insta360 accelerometer gravity, DJI flight attitude + fixed mount, match to the camera's own JPG (gradient NCC), two tapped horizon points | standard | **see Leveling below** |
| Lateral CA: fixed per-lens radial r²/r⁴ scale of R/B vs G on top of the camera's DNG warp, measured once offline from sample shots and shipped as constants (like a lens profile); applied to the mosaic before red/blue are demosaiced (green + color difference) | Boult & Wolberg 1992; Kang, CVPR 2007 | **see below** |
| Unified (sphere) camera model + radial-tangential distortion, for Insta360 lenses | Geyer & Daniilidis 2000; Mei & Rives 2007 | academic model, none known |
| Purple fringe: each pixel's own hue (violet-magenta) and brightness lower its saturation, like an HSL slider | standard color editing | deliberately **no** edge or highlight-proximity detection: US 8,582,878 (CSR/Qualcomm, to 2032) claims scoring fringe pixels by proximity to high-contrast edges |
| Highlight reconstruction: per-color clip flags from the raw; a clipped color is raised to what the surviving colors and the mean color of the nearest unclipped surroundings (masked mip pyramid) imply; only fully clipped areas shown neutral. DNG export keeps one stop above white (BaselineExposure +1) | dcraw-style clipping/blend; color-propagation ideas as in darktable/RawTherapee, implemented from the idea | not screened (personal-use build) |
| Noise profile estimate without a NoiseProfile tag: read noise from the dark corners outside the image circle, shot-noise slope from the quietest blocks per brightness (MAD of same-color differences) | noise level function estimation (e.g. Foi et al. 2008), implemented from the idea | none known |
| Sharpening: unsharp mask on log green against the next mip level | darkroom technique, digital since the 1970s | none in force known |
| False-color suppression: separable 5-tap median of log R/G, log B/G (white-balanced) | Freeman (Polaroid), US 4,724,395 | expired (filed 1985) |

### Lateral chromatic aberration (checked 2026-10-08)

- US 8,089,555 (Zoran → Qualcomm, active to 2029-12-08): every independent claim requires the estimation to run on an
  **on-camera image processor**; this app runs on a separate computer/phone after capture. Its continuation
  US 8,654,240 has lapsed (fees).
- **DE 11 2010 005 743 B4 (Robert Bosch GmbH, Germany only, active to ~2030-07-17).** Claim 1: a radial shift function
  with a free parameter whose optimum is determined from the image being corrected, then the correction applied. The
  app does **not** do this (changed 2026-10-09): it applies fixed per-lens constants, the precalculated lens tables the
  patent itself names as prior art. The constants were measured once, outside Germany, on the developer's sample shots;
  the per-shot estimator was removed from the app (it remains in git history before that date, not deployed). Its WO/PCT
  application ceased, so no other country.

### Stitching and leveling (screened 2026-10-09)

A screen of about 55 patent families (Google Patents; statuses and expiry dates are Google's estimates, not register
checks; EP/JP/CN claim versions mostly not read; no TW family members seen). Not legal advice. Patents are
territorial and private, non-commercial use is exempt in Taiwan (Patent Act art. 59(1)(i)), Germany (PatG §11 no. 1),
Japan and China; the US has no such exemption. **Current choice: the full method is kept** (personal use / free
publication). Before selling, get a professional opinion on the first two items and consider the listed design-arounds.

**Patent-safe mode** (checkbox under Lens & seam, off by default) applies the design-arounds: per-sector seam
correction in brightness only (EP 3,356,887), no parallax warp (GoPro alignment family), and no leveling from a tilt
sensor or flight attitude (US 11,049,215): the camera's own JPG is matched when present, otherwise the user levels.

Stitching:
- **EP 3,356,887 B1 (ArcSoft; DE and GB in force, to ~2037-07).** Claim 1: lens parameters, vignetting compensation,
  sphere projection unrolled to 2-D, overlap registered as a whole then per section with interpolated pixel shifts,
  per-section brightness *and hue* adjustment, fusion. The app appears to meet every step (DNG GainMaps count as
  vignetting compensation). **Likely read in DE/GB.** Design-around: per-sector seam gain luminance-only (measured
  per-sector color residual is 5-10% on Avata 360 and up to ~28% on X4, so this costs visible seam color), or seam gain /
  flow off for EU users. Its US member US 10,136,055 also needs light-box calibration plates: no read.
- **GoPro image alignment, US 9,792,709 / 9,973,696 / 10,498,958 / 10,972,661 (US only, to ~2035-11).** A disparity
  measured in the overlap, overlap pixels displaced to reduce it ('958/'661: "determined using a discrete refinement",
  described as a regularized shortest circular path; '709 includes the capture device). Seam flow is close. **Possible
  read.** Design-around: choose the blend position per azimuth instead of displacing pixels; never turn the per-bin
  search into a path/graph optimization.
- **GoPro US 11,363,214 (US, to ~2039-02).** One image gets a gain above 1 and the other a gain below 1 (non-saturated
  pixels). **Avoided (2026-10-09):** only the darker lens is corrected, globally and in the seam residual; the other
  keeps gain 1, and gains do not depend on saturation.
- Low: GoPro stitch-zone family (US 11,983,839, 12,205,236, 11,756,152; EP 3,523,955 B1): the measurement band frame is
  lens 0's own frame, not reoriented to a determined seam; keep it so. Ricoh joint-position family (US 9,609,212 etc.,
  to ~2034-08): confidence comes from the match curve only; never select or order matching by template edge/variance.
- Likely no read (key element missing; keep it missing): intermediate rectangle/polar projections (GoPro US 10,043,237
  family), M×N block matrix with region expansion (Insta360 US 12,205,240), Lab color matching (Insta360 US 11,948,228),
  correction-needed decision and reference image (Ricoh US 10,554,880), grid-point moving (Samsung EP 3,635,678), 3-D
  mesh texture mapping (Qualcomm US 10,102,610 etc.), video-only claims (Kandao, Intel, Insta360 US 11,388,339).

Leveling:
- **Ricoh US 11,049,215 B2 (US, to ~2033-03; family EP/CN/JP).** Conversion data for multi-lens images corrected by the
  device's tilt to gravity, including a rotation matrix. Touches the Insta360 accelerometer and DJI attitude paths; the
  app keeps lens data fixed and applies the level as a separate view rotation, which may or may not be held equivalent.
  **Possible read.** Design-around: write the level as XMP pose (GPano:PosePitchDegrees/PoseRollDegrees) instead of
  rotating pixels, or rotate in a separate equirect-to-equirect pass.
- **Insta360 CN 106,934,772 B (CN, to ~2037-03).** Leveling matrix applied while UV-mapping the circles onto a sphere
  mesh (vertex -> matrix -> lat/long -> UV). The app has no mesh (per-pixel inverse mapping). **Possible read in CN**
  by equivalence; never move to a sphere-mesh renderer.
- Likely no read: Insta360 EP 3,591,609 B1 / US 11,388,336 (gravity -> quaternion -> 4×4 matrix, swipe deltas;
  the app uses Rodrigues/Euler and a two-point or twist gesture), Ricoh CN 108,876,714 B (stored remap LUT; keep none),
  Ricoh US 11,348,200 (automatically detected vertical segment; the two horizon points stay user-tapped), Ricoh
  US 11,102,403 (one sensor correction for many images; each shot is leveled on its own), and video/HMD/ML claims
  (GoPro, Apple, Google, Samsung, JVCKenwood). Matching to the camera's JPG: no claim found.

**Not used:** Malvar–He–Cutler demosaicing. It is covered by Microsoft's US 7,502,505 (in force until about
2027-01-25 per Google Patents); it was replaced by Hamilton–Adams (now RCD) at equal measured quality
(`tools/demosaic-bench.html`).

## Trademarks

DJI, Avata and Osmo are trademarks of SZ DJI Technology Co., Ltd. Insta360 is a trademark of Arashi Vision Inc. Adobe, Lightroom and Photoshop are either registered
trademarks or trademarks of Adobe in the United States and/or other countries. They are used only to describe file
compatibility (e.g. "for use with Adobe Photoshop Lightroom"); this project is not affiliated with or endorsed by
DJI, Arashi Vision or Adobe. Do not use these names in the product name or domain, and do not use their logos.

## Metadata

Insta360 DNGs are read for interoperability: the per-shot lens calibration the camera writes into EXIF
(UserComment/MakerNote) and the accelerometer record of the file's trailer (for leveling). Nothing is written back.


Exported files keep the source XMP (including GPS position and flight attitude) so other tools can use it. Users who
publish images should be aware the location travels with the file.
