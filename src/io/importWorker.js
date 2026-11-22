// Web Worker d'import : lecture/décodage de tous les formats hors du fil principal de l'interface.
import { importFile } from './importFile.js';
import { createLazPerf } from 'laz-perf';
import lazWasmUrl from 'laz-perf/lib/web/laz-perf.wasm?url';

let lazPromise = null;
const getLazPerf = () => (lazPromise ??= createLazPerf({ locateFile: (f) => (f.endsWith('.wasm') ? lazWasmUrl : f) }));

self.onmessage = async (e) => {
  const { id, file, opts } = e.data;
  try {
    const res = await importFile(file, { ...opts, getLazPerf }, (fraction, label) => {
      self.postMessage({ type: 'progress', id, fraction, label });
    });
    const transfer = [];
    for (const c of res.clouds) {
      transfer.push(c.positions.buffer);
      if (c.colors) transfer.push(c.colors.buffer);
      if (c.intensity) transfer.push(c.intensity.buffer);
    }
    for (const im of res.images) transfer.push(im.bytes.buffer);
    self.postMessage({ type: 'done', id, result: res }, transfer);
  } catch (err) {
    self.postMessage({ type: 'error', id, message: err?.message ?? String(err) });
  }
};
