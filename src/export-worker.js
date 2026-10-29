// Export pool worker: lossless-JPEG encodes one band (row of 256x256 tiles), or one baseline-JPEG strip, at a time.
import { encodeTileRow, encodeJpegStrip } from './export.js';

onmessage = ({ data: d }) => {
  try {
    const chunks = d.rgba ? [encodeJpegStrip(d.rgba, d.width, d.rows, d.quality)] : encodeTileRow(d.band, d.width, d.rows, d.spp);
    postMessage({ id: d.id, chunks }, chunks.map(c => c.buffer));
  } catch (err) {
    postMessage({ id: d.id, error: err.message });
  }
};
