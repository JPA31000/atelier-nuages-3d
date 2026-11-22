import test from 'node:test';
import assert from 'node:assert/strict';
import { createLazPerf } from 'laz-perf';
import { importFile } from '../src/io/importFile.js';
import { makeExportSource } from '../src/io/exportSource.js';
import { writeLaz } from '../src/io/lazWriter.js';
import { writeLas, concatParts } from '../src/io/writers.js';
import { roomPoints } from './helpers/synth.js';

const IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
let lp = null;
const getLazPerf = async () => (lp ??= await createLazPerf());

function cloudFrom(src, origin, { color = true, intensity = true } = {}) {
  const n = src.x.length;
  const c = { positions: new Float32Array(n * 3), colors: color ? new Uint8Array(n * 3) : null, intensity: intensity ? new Float32Array(n) : null, count: n, matrix: IDENT };
  for (let i = 0; i < n; i++) {
    c.positions[i * 3] = src.x[i] - origin[0]; c.positions[i * 3 + 1] = src.y[i] - origin[1]; c.positions[i * 3 + 2] = src.z[i] - origin[2];
    if (color) { c.colors[i * 3] = src.r[i]; c.colors[i * 3 + 1] = src.g[i]; c.colors[i * 3 + 2] = src.b[i]; }
    if (intensity) c.intensity[i] = src.intensity[i];
  }
  return c;
}

/** Relit un LAZ et le compare, point à point, à la relecture du LAS équivalent (mêmes entiers, même ordre après tri). */
async function roundTrip(src, opts, { color = true, intensity = true } = {}) {
  const origin = [651234, 6862345, 120];
  const source = makeExportSource([cloudFrom(src, origin, { color, intensity })], origin);
  const laz = concatParts(writeLaz(source, opts));
  const las = concatParts(writeLas(source, opts));
  const a = await importFile(new File([laz], 'x.laz'), { getLazPerf });
  const b = await importFile(new File([las], 'x.las'), {});
  assert.equal(a.format, 'LAZ');
  assert.equal(a.clouds[0].count, b.clouds[0].count);
  return { laz, las, a: a.clouds[0], b: b.clouds[0] };
}

function sameCloud(a, b) {
  // même graine de mélange et mêmes points → mêmes tableaux (l'ordre source est identique)
  assert.equal(a.count, b.count);
  assert.deepEqual(a.offset.map((v) => +v.toFixed(6)), b.offset.map((v) => +v.toFixed(6)));
  for (let i = 0; i < a.positions.length; i++) assert.ok(Math.abs(a.positions[i] - b.positions[i]) < 1e-6, `pos ${i}`);
  if (a.colors) for (let i = 0; i < a.colors.length; i++) assert.equal(a.colors[i], b.colors[i], `col ${i}`);
  if (a.intensity) for (let i = 0; i < a.intensity.length; i++) assert.ok(Math.abs(a.intensity[i] - b.intensity[i]) < 1e-6, `int ${i}`);
}

test('LAZ format 2 (RGB) : ce que l’encodeur écrit, laz-perf le relit à l’identique (plusieurs blocs)', async () => {
  const src = roomPoints(5000, { seed: 31 });
  const { laz, las, a, b } = await roundTrip(src, { chunkSize: 1000 });
  sameCloud(a, b);
  assert.ok(laz.length < las.length, `LAZ (${laz.length}) doit être plus petit que LAS (${las.length})`);
});

test('LAZ format 0 (sans couleur), un seul bloc', async () => {
  const src = roomPoints(3000, { seed: 32, color: false });
  const { a, b } = await roundTrip(src, {}, { color: false });
  sameCloud(a, b);
});

test('LAZ : nuage plus gros, dernier bloc partiel, intensités variées', async () => {
  const src = roomPoints(33333, { seed: 33 });
  const { a, b } = await roundTrip(src, { chunkSize: 5000 });
  sameCloud(a, b);
});

test('LAZ : blocs de 50 000 points (régression : seuil de normalisation des modèles à 2^15)', async () => {
  // > 32 768 symboles par modèle dans un même bloc : la mise à l'échelle des compteurs est alors déclenchée
  const src = roomPoints(120000, { seed: 34 });
  const { a, b, laz, las } = await roundTrip(src, { chunkSize: 50000 });
  sameCloud(a, b);
  assert.ok(laz.length < las.length * 0.7);
});

test('LAZ : points identiques sur un très grand bloc (flux presque vide)', async () => {
  const n = 70000;
  const src = { x: new Float64Array(n).fill(651240), y: new Float64Array(n).fill(6862350), z: new Float64Array(n).fill(121), r: new Uint8Array(n).fill(90), g: new Uint8Array(n).fill(91), b: new Uint8Array(n).fill(92), intensity: new Float32Array(n).fill(0.5) };
  const { a, b } = await roundTrip(src, { chunkSize: n });
  assert.equal(a.count, n);
  sameCloud(a, b);
});
