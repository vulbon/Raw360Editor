import { parseDNG } from './dng.js';

onmessage = e => {
  try {
    const d = parseDNG(e.data);
    postMessage(d, [d.raw.buffer]);
  } catch (err) {
    postMessage({ error: err.message });
  }
};
