import test from 'node:test';
import assert from 'node:assert/strict';
import { parseXml, child, num } from '../src/io/xml.js';
import { parseNumbers } from '../src/io/textreader.js';
import { importFile } from '../src/io/importFile.js';
import { makeExportSource } from '../src/io/exportSource.js';
import { writeLas, writePly, writeXyz, concatParts } from '../src/io/writers.js';
import { buildE57 } from './helpers/e57Writer.js';
import { roomPoints } from './helpers/synth.js';

const mkFile = (bytes, name) => new File([bytes], name);
const IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Coordonnées globales d'un nuage lu (local + offset), sous forme de tableau [x,y,z,…]. */
function globalOf(c) {
  const out = new Float64Array(c.count * 3);
  for (let i = 0; i < c.count; i++) for (let k = 0; k < 3; k++) out[i * 3 + k] = c.positions[i * 3 + k] + c.offset[k];
  return out;
}
const key = (x, y, z, d = 3) => `${x.toFixed(d)}|${y.toFixed(d)}|${z.toFixed(d)}`;

/** Vérifie que le nuage lu contient les points d'origine (à `tol` près), dans le désordre :
 *  1) distributions triées identiques sur chaque axe ; 2) pour un échantillon de points lus, le point
 *  d'origine le plus proche (force brute) est à moins de 2·tol et porte la même couleur. */
function assertSamePoints(cloud, src, tol, { color = false, intensity = false } = {}) {
  const n = src.x.length;
  assert.equal(cloud.count, n);
  const g = globalOf(cloud);
  for (const [k, arr] of [[0, src.x], [1, src.y], [2, src.z]]) {
    const a = Float64Array.from({ length: n }, (_, i) => g[i * 3 + k]).sort();
    const b = Float64Array.from(arr).sort();
    let worst = 0;
    for (let i = 0; i < n; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]));
    assert.ok(worst <= tol, `axe ${k} : écart max ${worst} > ${tol}`);
  }
  const step = Math.max(1, Math.floor(n / 150));
  for (let i = 0; i < n; i += step) {
    let best = Infinity, bj = -1;
    for (let j = 0; j < n; j++) {
      const d = Math.hypot(g[i * 3] - src.x[j], g[i * 3 + 1] - src.y[j], g[i * 3 + 2] - src.z[j]);
      if (d < best) { best = d; bj = j; }
    }
    assert.ok(best <= tol * 2, `point ${i} : plus proche à ${best}`);
    if (color) {
      assert.equal(cloud.colors[i * 3], src.r[bj]);
      assert.equal(cloud.colors[i * 3 + 1], src.g[bj]);
      assert.equal(cloud.colors[i * 3 + 2], src.b[bj]);
    }
    if (intensity) assert.ok(Math.abs(cloud.intensity[i]) <= 1);
  }
}

test('xml : éléments, attributs, CDATA, entités', () => {
  const x = parseXml('<?xml version="1.0"?><e57Root type="Structure" xmlns="u"><a type="Float">1.5</a><s type="String"><![CDATA[x < y]]></s><t v="a&amp;b"/></e57Root>');
  const r = child(x, 'e57Root');
  assert.equal(r.attrs.type, 'Structure');
  assert.equal(num(r, 'a'), 1.5);
  assert.equal(child(r, 's').text, 'x < y');
  assert.equal(child(r, 't').attrs.v, 'a&b');
});

test('textreader : nombres décimaux, exposants, jetons invalides', () => {
  const out = new Float64Array(8);
  const b = (s) => new TextEncoder().encode(s);
  let t = b('651234.567 -2.5e1\t+3,.5');
  assert.equal(parseNumbers(t, 0, t.length, out), 4);
  assert.ok(Math.abs(out[0] - 651234.567) < 1e-9);
  assert.equal(out[1], -25);
  assert.equal(out[2], 3);
  assert.equal(out[3], 0.5);
  t = b('# commentaire');
  assert.equal(parseNumbers(t, 0, t.length, out), -1);
  t = b('1 2 abc');
  assert.equal(parseNumbers(t, 0, t.length, out), -1);
});

test('XYZ : X Y Z R G B, centrage sur le barycentre', async () => {
  const src = roomPoints(2000, { intensity: false });
  const lines = [];
  for (let i = 0; i < 2000; i++) lines.push(`${src.x[i].toFixed(3)} ${src.y[i].toFixed(3)} ${src.z[i].toFixed(3)} ${src.r[i]} ${src.g[i]} ${src.b[i]}`);
  const res = await importFile(mkFile(lines.join('\n') + '\n', 'salle.xyz'));
  const c = res.clouds[0];
  assert.equal(res.format, 'XYZ');
  assertSamePoints(c, src, 1e-3, { color: true });
  // barycentre : les coordonnées locales sont centrées et petites
  assert.ok(Math.abs(c.offset[0] - 651239.5) < 0.5 && Math.abs(c.offset[1] - 6862348.25) < 0.5, 'offset ≈ barycentre');
  assert.ok(Math.max(...c.positions.map(Math.abs)) < 10);
});

test('PTS : en-tête + X Y Z I R G B', async () => {
  const src = roomPoints(500);
  const lines = ['500'];
  for (let i = 0; i < 500; i++) lines.push(`${src.x[i].toFixed(3)} ${src.y[i].toFixed(3)} ${src.z[i].toFixed(3)} ${Math.round(src.intensity[i] * 1000)} ${src.r[i]} ${src.g[i]} ${src.b[i]}`);
  const res = await importFile(mkFile(lines.join('\r\n'), 'scan.pts'));
  assert.equal(res.format, 'PTS');
  assert.ok(res.info.colonnes.includes('X Y Z I R G B'));
  assertSamePoints(res.clouds[0], src, 1e-3, { color: true, intensity: true });
});

function plyBytes(src, format) {
  const n = src.x.length;
  const head = `ply\nformat ${format} 1.0\nelement vertex ${n}\nproperty double x\nproperty double y\nproperty double z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n`;
  if (format === 'ascii') {
    const l = [];
    for (let i = 0; i < n; i++) l.push(`${src.x[i].toFixed(4)} ${src.y[i].toFixed(4)} ${src.z[i].toFixed(4)} ${src.r[i]} ${src.g[i]} ${src.b[i]}`);
    return head + l.join('\n') + '\n';
  }
  const le = format === 'binary_little_endian';
  const body = new Uint8Array(n * 27);
  const dv = new DataView(body.buffer);
  for (let i = 0; i < n; i++) {
    dv.setFloat64(i * 27, src.x[i], le); dv.setFloat64(i * 27 + 8, src.y[i], le); dv.setFloat64(i * 27 + 16, src.z[i], le);
    body[i * 27 + 24] = src.r[i]; body[i * 27 + 25] = src.g[i]; body[i * 27 + 26] = src.b[i];
  }
  const h = new TextEncoder().encode(head);
  const all = new Uint8Array(h.length + body.length);
  all.set(h); all.set(body, h.length);
  return all;
}

for (const fmt of ['ascii', 'binary_little_endian', 'binary_big_endian']) {
  test(`PLY ${fmt}`, async () => {
    const src = roomPoints(1500);
    const res = await importFile(mkFile(plyBytes(src, fmt), 'nuage.ply'));
    assert.equal(res.format, 'PLY');
    assertSamePoints(res.clouds[0], src, 1e-3, { color: true });
  });
}

test('LAS : écriture puis relecture (format 2, RGB + intensité)', async () => {
  const src = roomPoints(3000);
  const cloud = { positions: new Float32Array(9000), colors: new Uint8Array(9000), intensity: new Float32Array(3000), count: 3000, matrix: IDENT };
  const origin = [651234, 6862345, 120];
  for (let i = 0; i < 3000; i++) {
    cloud.positions[i * 3] = src.x[i] - origin[0]; cloud.positions[i * 3 + 1] = src.y[i] - origin[1]; cloud.positions[i * 3 + 2] = src.z[i] - origin[2];
    cloud.colors[i * 3] = src.r[i]; cloud.colors[i * 3 + 1] = src.g[i]; cloud.colors[i * 3 + 2] = src.b[i];
    cloud.intensity[i] = src.intensity[i];
  }
  const parts = writeLas(makeExportSource([cloud], origin));
  const res = await importFile(mkFile(concatParts(parts), 'sortie.las'));
  assert.equal(res.format, 'LAS');
  assert.equal(res.info.formatPoints, 2);
  assertSamePoints(res.clouds[0], src, 6e-4, { color: true, intensity: true });
});

test('PLY et XYZ : export puis relecture', async () => {
  const src = roomPoints(800);
  const origin = [651234, 6862345, 120];
  const cloud = { positions: new Float32Array(2400), colors: new Uint8Array(2400), intensity: null, count: 800, matrix: IDENT };
  for (let i = 0; i < 800; i++) {
    cloud.positions[i * 3] = src.x[i] - origin[0]; cloud.positions[i * 3 + 1] = src.y[i] - origin[1]; cloud.positions[i * 3 + 2] = src.z[i] - origin[2];
    cloud.colors[i * 3] = src.r[i]; cloud.colors[i * 3 + 1] = src.g[i]; cloud.colors[i * 3 + 2] = src.b[i];
  }
  const s = makeExportSource([cloud], origin);
  const ply = await importFile(mkFile(concatParts(writePly(s)), 'a.ply'));
  assertSamePoints(ply.clouds[0], src, 1e-6, { color: true });
  const xyz = await importFile(mkFile(concatParts(writeXyz(s)), 'a.xyz'));
  assertSamePoints(xyz.clouds[0], src, 6e-4, { color: true });
});

test('budget : sous-échantillonnage uniforme ≈ budget', async () => {
  const src = roomPoints(20000, { intensity: false });
  const lines = [];
  for (let i = 0; i < 20000; i++) lines.push(`${src.x[i].toFixed(3)} ${src.y[i].toFixed(3)} ${src.z[i].toFixed(3)}`);
  const res = await importFile(mkFile(lines.join('\n') + '\n', 'gros.xyz'), { budget: 5000 });
  const n = res.clouds[0].count;
  assert.ok(n > 4300 && n < 5700, `count=${n}`);
});

// ---------------- E57 ----------------

function toLocal(src, pose) {
  // x_local = Rᵀ (x_global − t)
  const [w, x, y, z] = pose.q;
  const R = [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), 2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), 2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)];
  const n = src.x.length;
  const lx = new Float64Array(n), ly = new Float64Array(n), lz = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const dx = src.x[i] - pose.t[0], dy = src.y[i] - pose.t[1], dz = src.z[i] - pose.t[2];
    lx[i] = R[0] * dx + R[3] * dy + R[6] * dz;
    ly[i] = R[1] * dx + R[4] * dy + R[7] * dz;
    lz[i] = R[2] * dx + R[5] * dy + R[8] * dz;
  }
  return { ...src, x: lx, y: ly, z: lz };
}

test('E57 structuré : 2 scans, poses, couleurs, intensité, panoramique intégré, paquets à cheval', async () => {
  const a = roomPoints(1800, { seed: 11 });
  const b = roomPoints(1100, { seed: 12, origin: [651234.5 + 3, 6862345.25 + 1, 120] });
  const ang = Math.PI / 5;
  const poseA = { q: [Math.cos(ang / 2), 0, 0, Math.sin(ang / 2)], t: [651239.0, 6862348.0, 121.2] };
  const poseB = { q: [1, 0, 0, 0], t: [651242.0, 6862350.0, 121.2] };
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 0xff, 0xd9]);
  const file = buildE57({
    scans: [
      { name: 'Station 1', guid: '{A}', pose: poseA, points: toLocal(a, poseA), encoding: 'scaled', recordsPerPacket: 333, grid: [30, 60] },
      { name: 'Station 2', guid: '{B}', pose: poseB, points: toLocal(b, poseB), encoding: 'float', recordsPerPacket: 257 },
    ],
    images: [{ name: 'pano1', scanGuid: '{A}', bytes: jpeg, width: 4096, height: 2048 }],
  });
  const res = await importFile(mkFile(file, 'projet.e57'));
  assert.equal(res.format, 'E57');
  assert.equal(res.structure.type, 'structuré');
  assert.equal(res.clouds.length, 2);
  assert.equal(res.clouds[0].name, 'Station 1');
  assertSamePoints(res.clouds[0], a, 1.5e-3, { color: true, intensity: true });
  assertSamePoints(res.clouds[1], b, 2e-3, { color: true, intensity: true }); // float32 à ~1e-4 près à 10 m
  // station = translation de la pose
  assert.deepEqual(res.clouds[0].station.position, poseA.t);
  assert.ok(Math.abs(res.clouds[0].station.quaternion[3] - Math.cos(ang / 2)) < 1e-12);
  // panoramique intégré rattaché à la station 1
  assert.equal(res.images.length, 1);
  assert.equal(res.images[0].stationIndex, 0);
  assert.deepEqual(Array.from(res.images[0].bytes), Array.from(jpeg));
  assert.equal(res.images[0].mime, 'image/jpeg');
});

test('E57 coordonnées sphériques (grille) : conversion en cartésien', async () => {
  const a = roomPoints(900, { seed: 5, origin: [0, 0, 0], color: false, intensity: false });
  // centre la pièce autour de la station pour des angles sans ambiguïté
  for (let i = 0; i < a.x.length; i++) { a.x[i] -= 5; a.y[i] -= 3; a.z[i] -= 1.5; }
  const file = buildE57({ scans: [{ name: 'Sph', guid: '{S}', pose: { q: [1, 0, 0, 0], t: [0, 0, 0] }, points: a, spherical: true, recordsPerPacket: 100 }] });
  const res = await importFile(mkFile(file, 'sph.e57'));
  assertSamePoints(res.clouds[0], a, 1e-6);
  assert.ok(res.structure.reasons.some((r) => r.includes('sphériques')));
});

test('E57 non structuré : un seul scan sans pose ni image', async () => {
  const a = roomPoints(700, { seed: 21, color: false, intensity: false, origin: [1000, 2000, 30] });
  const file = buildE57({ scans: [{ name: 'Nuage', guid: '{N}', points: a, encoding: 'float' }] });
  const res = await importFile(mkFile(file, 'global.e57'));
  assert.equal(res.structure.type, 'non structuré');
  assert.equal(res.clouds[0].station, null);
  assertSamePoints(res.clouds[0], a, 2e-3);
});

test('E57 : rejette un fichier qui n’en est pas un', async () => {
  await assert.rejects(importFile(mkFile(new Uint8Array(2000), 'faux.e57')), /Format non reconnu|ASTF/);
});
