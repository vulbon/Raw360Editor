import { decodeLenses } from './dng.js';

onmessage = e => {
  try {
    const r = decodeLenses(e.data);
    postMessage(r, r.lenses.flatMap(l => [l.full.raw.buffer, ...(l.proxy ? [l.proxy.raw.buffer] : [])]));
  } catch (err) {
    postMessage({ error: err.message });
  }
};
