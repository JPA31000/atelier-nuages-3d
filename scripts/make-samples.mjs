// Génère les jeux d'essai téléchargeables depuis la page d'accueil (dossier public/exemples/) :
//   salle-demo-structure.e57   E57 structuré : 2 stations (poses) + 2 panoramiques 360° PNG intégrés
//   salle-demo-nuage.laz       les deux scans fusionnés en un seul nuage LAZ (sans station) : test d'import LAZ
// Lancé automatiquement avant `npm run dev` et `npm run build` ; les fichiers ne sont pas versionnés.

import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildDemo } from '../src/demo/demoScene.js';
import { buildE57 } from '../src/io/e57Writer.js';
import { makeExportSource } from '../src/io/exportSource.js';
import { writeLaz } from '../src/io/lazWriter.js';
import { concatParts } from '../src/io/writers.js';

const OUT = process.env.SAMPLES_OUT
  ? pathToFileURL(resolve(process.env.SAMPLES_OUT) + sep) // dossier de sortie imposé (tests)
  : new URL('../public/exemples/', import.meta.url);
mkdirSync(OUT, { recursive: true });

// ---- PNG minimal (RVB 8 bits) ----
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function png(rgba, w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4, d = y * (w * 3 + 1) + 1 + x * 3;
      raw[d] = rgba[s]; raw[d + 1] = rgba[s + 1]; raw[d + 2] = rgba[s + 2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const demo = buildDemo({ azStep: 0.8, elStep: 0.9, panoWidth: 1024 });

// ---- E57 structuré ----
const scans = demo.clouds.map((c, i) => {
  const [qx, qy, qz, qw] = c.station.quaternion;
  const t = c.station.position;
  const R = [1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw), 2 * (qx * qz + qy * qw), 2 * (qx * qy + qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw), 2 * (qx * qz - qy * qw), 2 * (qy * qz + qx * qw), 1 - 2 * (qx * qx + qy * qy)];
  const n = c.count;
  const x = new Float64Array(n), y = new Float64Array(n), z = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    // repère scanner = Rᵀ (global − t)
    const dx = c.positions[k * 3] + c.offset[0] - t[0], dy = c.positions[k * 3 + 1] + c.offset[1] - t[1], dz = c.positions[k * 3 + 2] + c.offset[2] - t[2];
    x[k] = R[0] * dx + R[3] * dy + R[6] * dz;
    y[k] = R[1] * dx + R[4] * dy + R[7] * dz;
    z[k] = R[2] * dx + R[5] * dy + R[8] * dz;
  }
  const r = new Uint8Array(n), g = new Uint8Array(n), b = new Uint8Array(n);
  for (let k = 0; k < n; k++) { r[k] = c.colors[k * 3]; g[k] = c.colors[k * 3 + 1]; b[k] = c.colors[k * 3 + 2]; }
  return {
    name: c.name, guid: `{demo-scan-${i + 1}}`, encoding: 'scaled', recordsPerPacket: 1500,
    pose: { q: [qw, qx, qy, qz], t }, points: { x, y, z, r, g, b, intensity: c.intensity },
  };
});
const images = demo.images.map((im) => ({
  name: im.name, scanGuid: `{demo-scan-${im.stationIndex + 1}}`, type: 'png', width: im.width, height: im.height,
  bytes: new Uint8Array(png(im.rgba, im.width, im.height)),
}));
const e57 = buildE57({ scans, images });
writeFileSync(new URL('salle-demo-structure.e57', OUT), e57);

// ---- LAZ fusionné ----
const origin = demo.clouds[0].offset;
const clouds = demo.clouds.map((c) => ({
  positions: c.positions, colors: c.colors, intensity: c.intensity, count: c.count,
  matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, c.offset[0] - origin[0], c.offset[1] - origin[1], c.offset[2] - origin[2], 1],
}));
const laz = concatParts(writeLaz(makeExportSource(clouds, origin), { scale: 0.001 }));
writeFileSync(new URL('salle-demo-nuage.laz', OUT), laz);

console.log(`exemples : E57 ${(e57.length / 1024 ** 2).toFixed(1)} Mo, LAZ ${(laz.length / 1024 ** 2).toFixed(1)} Mo -> public/exemples/`);
