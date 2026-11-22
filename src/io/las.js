// Lecteur LAS (1.0 → 1.4) et LAZ (décompression par laz-perf, compilé en WebAssembly).

import { PointCollector } from './collector.js';

const RGB_OFFSET = { 2: 20, 3: 28, 5: 28, 7: 30, 8: 30, 10: 30 };

export function parseLasHeader(buf) {
  const dv = new DataView(buf);
  const sig = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (sig !== 'LASF') throw new Error("Signature « LASF » absente : ce n'est pas un fichier LAS/LAZ.");
  const versionMajor = dv.getUint8(24);
  const versionMinor = dv.getUint8(25);
  const headerSize = dv.getUint16(94, true);
  const pointOffset = dv.getUint32(96, true);
  const numVlr = dv.getUint32(100, true);
  const formatByte = dv.getUint8(104);
  const recordLength = dv.getUint16(105, true);
  let count = dv.getUint32(107, true);
  if (versionMajor === 1 && versionMinor >= 4 && headerSize >= 375 && buf.byteLength >= 375) {
    const big = Number(dv.getBigUint64(247, true));
    if (count === 0 || big > 0) count = big;
  }
  const scale = [dv.getFloat64(131, true), dv.getFloat64(139, true), dv.getFloat64(147, true)];
  const offset = [dv.getFloat64(155, true), dv.getFloat64(163, true), dv.getFloat64(171, true)];
  const bounds = {
    max: [dv.getFloat64(179, true), dv.getFloat64(195, true), dv.getFloat64(211, true)],
    min: [dv.getFloat64(187, true), dv.getFloat64(203, true), dv.getFloat64(219, true)],
  };
  // VLR : détection de la compression LAZ et du système de coordonnées
  let compressed = (formatByte & 0x80) !== 0;
  let epsg = null;
  let wkt = null;
  let p = headerSize;
  for (let k = 0; k < numVlr && p + 54 <= buf.byteLength; k++) {
    const user = String.fromCharCode(...new Uint8Array(buf, p + 2, 16)).replace(/\0.*$/, '');
    const id = dv.getUint16(p + 18, true);
    const len = dv.getUint16(p + 20, true);
    const body = p + 54;
    if (user === 'laszip encoded' && id === 22204) compressed = true;
    if (user === 'LASF_Projection' && body + len <= buf.byteLength) {
      if (id === 34735) {
        const nKeys = dv.getUint16(body + 6, true);
        for (let j = 0; j < nKeys; j++) {
          const q = body + 8 + j * 8;
          if (q + 8 > body + len) break;
          const key = dv.getUint16(q, true), loc = dv.getUint16(q + 2, true), val = dv.getUint16(q + 6, true);
          if (loc === 0 && (key === 3072 || key === 2048)) epsg = val;
        }
      } else if (id === 2112) {
        wkt = new TextDecoder().decode(new Uint8Array(buf, body, len)).replace(/\0+$/, '');
      }
    }
    p = body + len;
  }
  return {
    versionMajor, versionMinor, headerSize, pointOffset, numVlr,
    format: formatByte & 0x3f, recordLength, count, scale, offset, bounds, compressed, epsg, wkt,
    hasColor: (formatByte & 0x3f) in RGB_OFFSET,
  };
}

export async function readLas(file, opts = {}, onProgress = () => {}) {
  const budget = opts.budget ?? Infinity;
  const hbuf = await file.slice(0, Math.min(file.size, 64 * 1024)).arrayBuffer();
  const h = parseLasHeader(hbuf);
  if (h.format > 10) throw new Error(`Format de points LAS ${h.format} non pris en charge.`);
  const rgbOff = RGB_OFFSET[h.format] ?? -1;
  const [sx, sy, sz] = h.scale;
  const [ox, oy, oz] = h.offset;
  const hint = [(h.bounds.min[0] + h.bounds.max[0]) / 2, (h.bounds.min[1] + h.bounds.max[1]) / 2, (h.bounds.min[2] + h.bounds.max[2]) / 2];
  const col = new PointCollector({
    expected: h.count, budget, offsetHint: hint.every(Number.isFinite) ? hint : null, hasColor: rgbOff >= 0, hasIntensity: true,
  });
  const readRecord = (dv, o) => {
    if (!col.accept()) return;
    col.add(
      dv.getInt32(o, true) * sx + ox, dv.getInt32(o + 4, true) * sy + oy, dv.getInt32(o + 8, true) * sz + oz,
      rgbOff >= 0 ? dv.getUint16(o + rgbOff, true) : 0,
      rgbOff >= 0 ? dv.getUint16(o + rgbOff + 2, true) : 0,
      rgbOff >= 0 ? dv.getUint16(o + rgbOff + 4, true) : 0,
      dv.getUint16(o + 12, true),
    );
  };

  if (!h.compressed) {
    const rl = h.recordLength;
    const per = Math.max(1, Math.floor((16 * 1024 * 1024) / rl));
    for (let start = 0; start < h.count; start += per) {
      const n = Math.min(per, h.count - start);
      const buf = await file.slice(h.pointOffset + start * rl, h.pointOffset + (start + n) * rl).arrayBuffer();
      const dv = new DataView(buf);
      const real = Math.min(n, Math.floor(buf.byteLength / rl));
      for (let i = 0; i < real; i++) readRecord(dv, i * rl);
      onProgress((start + n) / h.count, 'Lecture du LAS…');
    }
  } else {
    if (!opts.getLazPerf) throw new Error('Décompresseur LAZ indisponible dans ce contexte.');
    if (file.size > 1.6 * 1024 ** 3) throw new Error('Fichier LAZ trop volumineux pour la mémoire du navigateur (> 1,6 Go).');
    onProgress(0.02, 'Chargement du LAZ en mémoire…');
    const lp = await opts.getLazPerf();
    const data = new Uint8Array(await file.arrayBuffer());
    const filePtr = lp._malloc(data.byteLength);
    lp.HEAPU8.set(data, filePtr);
    const laz = new lp.LASZip();
    try {
      laz.open(filePtr, data.byteLength);
      const count = laz.getCount();
      const plen = laz.getPointLength();
      const ptPtr = lp._malloc(plen);
      let heap = lp.HEAPU8.buffer;
      let dv = new DataView(heap);
      for (let i = 0; i < count; i++) {
        laz.getPoint(ptPtr);
        if (lp.HEAPU8.buffer !== heap) { heap = lp.HEAPU8.buffer; dv = new DataView(heap); }
        readRecord(dv, ptPtr);
        if ((i & 0x3ffff) === 0) onProgress(0.05 + 0.95 * (i / count), 'Décompression du LAZ…');
      }
      lp._free(ptPtr);
    } finally {
      laz.delete();
      lp._free(filePtr);
    }
  }
  const out = col.finish({ colorMax: null });
  return {
    format: h.compressed ? 'LAZ' : 'LAS',
    structure: null,
    info: {
      version: `${h.versionMajor}.${h.versionMinor}`,
      formatPoints: h.format,
      pointsSource: h.count,
      echelle: h.scale.join(' / '),
      epsg: h.epsg ? `EPSG:${h.epsg}` : h.wkt ? 'WKT présent' : 'non renseigné',
    },
    clouds: [{ name: file.name.replace(/\.[^.]+$/, ''), ...out, station: null }],
    images: [],
    warnings: [],
  };
}
