// Écrivains LAS 1.2 / PLY / XYZ. Chaque écrivain renvoie un tableau de Uint8Array (« parts »)
// que l'appelant assemble en Blob (ou en fichier dans une archive ZIP).

import { sourceBounds } from './exportSource.js';

const enc = new TextEncoder();
const utf8 = (s) => enc.encode(s);

export const concatParts = (parts) => {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

// ---------------- LAS ----------------

export function lasHeaderAndLayout(source, { scale = 0.001 } = {}) {
  const b = sourceBounds(source);
  const format = source.hasColor ? 2 : 0;
  const recLen = format === 2 ? 26 : 20;
  const offset = b.min.map((v) => Math.floor(v));
  return { bounds: b, format, recLen, scale: [scale, scale, scale], offset };
}

export function buildLasHeader(total, lay) {
  const buf = new ArrayBuffer(227);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  u8.set(utf8('LASF'), 0);
  dv.setUint8(24, 1); dv.setUint8(25, 2);
  u8.set(utf8('Atelier Nuages 3D').subarray(0, 32), 26);
  u8.set(utf8('Atelier Nuages 3D (navigateur)').subarray(0, 32), 58);
  const now = new Date();
  const doy = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 86400000);
  dv.setUint16(90, doy, true); dv.setUint16(92, now.getFullYear(), true);
  dv.setUint16(94, 227, true);
  dv.setUint32(96, 227, true);
  dv.setUint32(100, 0, true);
  dv.setUint8(104, lay.format);
  dv.setUint16(105, lay.recLen, true);
  dv.setUint32(107, total, true);
  dv.setUint32(111, total, true); // nombre de points du 1er retour
  for (let i = 0; i < 3; i++) {
    dv.setFloat64(131 + i * 8, lay.scale[i], true);
    dv.setFloat64(155 + i * 8, lay.offset[i], true);
  }
  const { min, max } = lay.bounds;
  dv.setFloat64(179, max[0], true); dv.setFloat64(187, min[0], true);
  dv.setFloat64(195, max[1], true); dv.setFloat64(203, min[1], true);
  dv.setFloat64(211, max[2], true); dv.setFloat64(219, min[2], true);
  return u8;
}

/** Enregistrement(s) LAS (format 0 ou 2) d'un bloc de points. */
export function lasRecords(ch, lay) {
  const { recLen, format, scale, offset } = lay;
  const buf = new Uint8Array(ch.n * recLen);
  const dv = new DataView(buf.buffer);
  const sx = 1 / scale[0], sy = 1 / scale[1], sz = 1 / scale[2];
  for (let i = 0; i < ch.n; i++) {
    const o = i * recLen;
    dv.setInt32(o, Math.round((ch.x[i] - offset[0]) * sx), true);
    dv.setInt32(o + 4, Math.round((ch.y[i] - offset[1]) * sy), true);
    dv.setInt32(o + 8, Math.round((ch.z[i] - offset[2]) * sz), true);
    dv.setUint16(o + 12, ch.inten ? Math.round(ch.inten[i] * 65535) : 0, true);
    buf[o + 14] = 9; // retour 1 sur 1
    if (format === 2) {
      dv.setUint16(o + 20, ch.rgb[i * 3] * 257, true);
      dv.setUint16(o + 22, ch.rgb[i * 3 + 1] * 257, true);
      dv.setUint16(o + 24, ch.rgb[i * 3 + 2] * 257, true);
    }
  }
  return buf;
}

export function writeLas(source, opts = {}, onProgress = () => {}) {
  const lay = lasHeaderAndLayout(source, opts);
  const parts = [buildLasHeader(source.total, lay)];
  let done = 0;
  for (const ch of source.chunks()) {
    parts.push(lasRecords(ch, lay));
    done += ch.n;
    onProgress(done / Math.max(1, source.total));
  }
  return parts;
}

// ---------------- PLY ----------------

export function writePly(source, { ascii = false } = {}, onProgress = () => {}) {
  const props = ['property double x', 'property double y', 'property double z'];
  if (source.hasColor) props.push('property uchar red', 'property uchar green', 'property uchar blue');
  if (source.hasIntensity) props.push('property float intensity');
  const o = source.sceneOrigin;
  const header = [
    'ply', ascii ? 'format ascii 1.0' : 'format binary_little_endian 1.0',
    'comment Atelier Nuages 3D - coordonnées globales (Float64)',
    `element vertex ${source.total}`, ...props, 'end_header', '',
  ].join('\n');
  const parts = [utf8(header)];
  let done = 0;
  for (const ch of source.chunks()) {
    if (ascii) {
      const lines = [];
      for (let i = 0; i < ch.n; i++) {
        let l = `${ch.x[i].toFixed(4)} ${ch.y[i].toFixed(4)} ${ch.z[i].toFixed(4)}`;
        if (source.hasColor) l += ` ${ch.rgb[i * 3]} ${ch.rgb[i * 3 + 1]} ${ch.rgb[i * 3 + 2]}`;
        if (source.hasIntensity) l += ` ${ch.inten[i].toFixed(5)}`;
        lines.push(l);
      }
      parts.push(utf8(lines.join('\n') + '\n'));
    } else {
      const stride = 24 + (source.hasColor ? 3 : 0) + (source.hasIntensity ? 4 : 0);
      const buf = new Uint8Array(ch.n * stride);
      const dv = new DataView(buf.buffer);
      for (let i = 0; i < ch.n; i++) {
        let p = i * stride;
        dv.setFloat64(p, ch.x[i], true); dv.setFloat64(p + 8, ch.y[i], true); dv.setFloat64(p + 16, ch.z[i], true);
        p += 24;
        if (source.hasColor) { buf[p] = ch.rgb[i * 3]; buf[p + 1] = ch.rgb[i * 3 + 1]; buf[p + 2] = ch.rgb[i * 3 + 2]; p += 3; }
        if (source.hasIntensity) dv.setFloat32(p, ch.inten[i], true);
      }
      parts.push(buf);
    }
    done += ch.n;
    onProgress(done / Math.max(1, source.total));
  }
  void o;
  return parts;
}

// ---------------- XYZ ----------------

export function writeXyz(source, { decimals = 3 } = {}, onProgress = () => {}) {
  const parts = [];
  let done = 0;
  for (const ch of source.chunks()) {
    const lines = new Array(ch.n);
    for (let i = 0; i < ch.n; i++) {
      let l = `${ch.x[i].toFixed(decimals)} ${ch.y[i].toFixed(decimals)} ${ch.z[i].toFixed(decimals)}`;
      if (source.hasColor) l += ` ${ch.rgb[i * 3]} ${ch.rgb[i * 3 + 1]} ${ch.rgb[i * 3 + 2]}`;
      if (source.hasIntensity) l += ` ${Math.round(ch.inten[i] * 255)}`;
      lines[i] = l;
    }
    parts.push(utf8(lines.join('\n') + '\n'));
    done += ch.n;
    onProgress(done / Math.max(1, source.total));
  }
  return parts;
}
