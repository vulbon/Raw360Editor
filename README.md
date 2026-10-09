# 360 RAW Stitcher

Stitches 360° RAW photos in the browser and exports DNG, TIFF or JPEG. The DNG keeps its flexibility for Lightroom.
It supports dual-fisheye DNGs from the DJI Avata 360 and Osmo 360 (`_UP` + `_DOWN`) and the Insta360 X4.
Everything runs locally on the GPU (WebGL2), and photos are never uploaded.

## Use

- **Simplest:** double-click `index.html` (Chrome / Edge / Safari), then drop the DNGs in.
- **Faster, iPad on the same Wi-Fi:** run `python tools/serve.py`, then open `http://localhost:8765` (iPad: the computer's IP).

Adding the camera's `_D.JPG` too gives the same leveling as the camera itself.

## Develop

| Path | Contents |
|---|---|
| `src/` | Source code (ES modules, no dependencies). While developing, open `/src/index.html`. |
| `node tools/build.mjs` | Packs `src/` into a single-file `index.html` at the root. |
| `node test/check.mjs` | Tests for the decoder, encoder and color math. |
| `tools/*-bench.html` | Demosaic and noise-reduction benchmarks. They need sample photos in `ref/`, which isn't committed. |

Licenses, algorithm sources and patent notes are in [NOTICE.md](NOTICE.md).
