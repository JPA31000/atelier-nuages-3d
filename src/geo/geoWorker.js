// Web Worker de calcul : ICP, filtres de nettoyage, exports (LAS / LAZ / PLY / XYZ / paquet RCP).
import { icp } from './icp.js';
import { hornTransform, toMatrix4 } from './rigid.js';
import { statisticalOutlierRemoval, radiusOutlierRemoval, clipBox, voxelDownsample } from './filters.js';
import { makeExportSource } from '../io/exportSource.js';
import { writeLas, writePly, writeXyz } from '../io/writers.js';
import { writeLaz } from '../io/lazWriter.js';
import { buildRcpPackage } from '../io/rcp.js';
import { buildDemo } from '../demo/demoScene.js';

const handlers = {
  demo(params) {
    const d = buildDemo(params);
    const transfer = [];
    for (const c of d.clouds) transfer.push(c.positions.buffer, c.colors.buffer, c.intensity.buffer);
    for (const im of d.images) transfer.push(im.rgba.buffer);
    return { result: d, transfer };
  },

  icp({ src, tgt, params }, progress) {
    const res = icp(src, tgt, params, (it, rmse, pairs) => progress(it / (params.maxIter || 50), `Itération ${it} — RMSE ${(rmse * 1000).toFixed(2)} mm (${pairs} paires)`));
    return { result: res };
  },

  pairs({ P, Q }) {
    const n = P.length / 3;
    const h = hornTransform(P, Q, n);
    let s = 0;
    for (let i = 0; i < n; i++) {
      const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
      const X = h.R[0] * x + h.R[1] * y + h.R[2] * z + h.t[0] - Q[i * 3];
      const Y = h.R[3] * x + h.R[4] * y + h.R[5] * z + h.t[1] - Q[i * 3 + 1];
      const Z = h.R[6] * x + h.R[7] * y + h.R[8] * z + h.t[2] - Q[i * 3 + 2];
      s += X * X + Y * Y + Z * Z;
    }
    return { result: { matrix: toMatrix4(h.R, h.t), rmse: Math.sqrt(s / n), pairs: n } };
  },

  filter({ kind, cloud, params, matrix }, progress) {
    let r;
    if (kind === 'voxel') r = voxelDownsample(cloud, params, progress);
    else if (kind === 'sor') r = statisticalOutlierRemoval(cloud, params, progress);
    else if (kind === 'ror') r = radiusOutlierRemoval(cloud, params, progress);
    else if (kind === 'clip') r = clipBox(cloud, matrix, params.min, params.max, params);
    else throw new Error(`Filtre inconnu : ${kind}`);
    const c = r.cloud;
    const transfer = [c.positions.buffer];
    if (c.colors) transfer.push(c.colors.buffer);
    if (c.intensity) transfer.push(c.intensity.buffer);
    return { result: { cloud: c, removed: r.removed, info: r.info }, transfer };
  },

  export({ format, clouds, sceneOrigin, options, rcp }, progress) {
    let parts, name, type = 'application/octet-stream';
    if (format === 'rcp') {
      const r = buildRcpPackage({ ...rcp, clouds, sceneOrigin, options }, progress);
      parts = r.parts; name = r.fileName; type = 'application/zip';
    } else {
      const source = makeExportSource(clouds, sceneOrigin);
      if (format === 'las') parts = writeLas(source, options, progress);
      else if (format === 'laz') parts = writeLaz(source, options, progress);
      else if (format === 'ply') parts = writePly(source, options, progress);
      else if (format === 'xyz') parts = writeXyz(source, options, progress);
      else throw new Error(`Format d'export inconnu : ${format}`);
      name = null;
    }
    return { result: { blob: new Blob(parts, { type }), fileName: name } };
  },
};

self.onmessage = (e) => {
  const { id, op, payload } = e.data;
  try {
    const out = handlers[op](payload, (fraction, label) => self.postMessage({ type: 'progress', id, fraction, label }));
    self.postMessage({ type: 'done', id, result: out.result }, out.transfer || []);
  } catch (err) {
    self.postMessage({ type: 'error', id, message: err?.message ?? String(err) });
  }
};
