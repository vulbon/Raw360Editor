// Export pool worker: lossless-JPEG encodes one band (row of 256x256 tiles) at a time.
import { encodeTileRow } from './export.js';

onmessage = ({ data: d }) => {
  try {
    const chunks = encodeTileRow(d.band, d.width, d.rows, d.spp);
    postMessage({ id: d.id, chunks }, chunks.map(c => c.buffer));
  } catch (err) {
    postMessage({ id: d.id, error: err.message });
  }
};
