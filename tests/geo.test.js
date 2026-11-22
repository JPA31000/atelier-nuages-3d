import test from 'node:test';
import assert from 'node:assert/strict';
import { KDTree } from '../src/geo/kdtree.js';
import { hornTransform, quatToRot } from '../src/geo/rigid.js';
import { icp } from '../src/geo/icp.js';
import { statisticalOutlierRemoval, radiusOutlierRemoval, clipBox, voxelDownsample } from '../src/geo/filters.js';
import { rng } from './helpers/synth.js';

const IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function randomCloud(n, seed = 3, size = 10) {
  const r = rng(seed);
  const p = new Float32Array(n * 3);
  for (let i = 0; i < n * 3; i++) p[i] = (r() - 0.5) * size;
  return p;
}

/** Pièce 10×6×3 échantillonnée sur ses 6 faces, centrée sur l'origine (coordonnées locales). */
function room(n, seed = 5) {
  const r = rng(seed);
  const p = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const f = Math.floor(r() * 6);
    let a = r() * 10 - 5, b = r() * 6 - 3, c = r() * 3 - 1.5;
    if (f === 0) c = -1.5; else if (f === 1) c = 1.5; else if (f === 2) a = -5; else if (f === 3) a = 5; else if (f === 4) b = -3; else b = 3;
    p[i * 3] = a; p[i * 3 + 1] = b; p[i * 3 + 2] = c;
  }
  return p;
}

test('KDTree : plus proche voisin, kNN et comptage = force brute', () => {
  const p = randomCloud(3000);
  const tree = new KDTree(p);
  const q = randomCloud(60, 99);
  const d2 = new Float64Array(5);
  for (let i = 0; i < 60; i++) {
    const x = q[i * 3], y = q[i * 3 + 1], z = q[i * 3 + 2];
    const all = [];
    for (let j = 0; j < 3000; j++) all.push([(p[j * 3] - x) ** 2 + (p[j * 3 + 1] - y) ** 2 + (p[j * 3 + 2] - z) ** 2, j]);
    all.sort((a, b) => a[0] - b[0]);
    const j = tree.nearest(x, y, z);
    assert.equal(j, all[0][1]);
    assert.ok(Math.abs(tree.bestD2 - all[0][0]) < 1e-9);
    const m = tree.knn(x, y, z, 5, d2);
    assert.equal(m, 5);
    for (let k = 0; k < 5; k++) assert.ok(Math.abs(d2[k] - all[k][0]) < 1e-9, `knn ${k}`);
    const r2 = 1.2;
    assert.equal(tree.countWithin(x, y, z, r2), all.filter((a) => a[0] <= r2).length);
  }
});

test('Horn : retrouve rotation + translation exactes', () => {
  const P = randomCloud(200, 4);
  const q = [0.9, 0.2, -0.3, 0.1];
  const nq = Math.hypot(...q);
  const R = quatToRot(q.map((v) => v / nq));
  const t = [3.5, -2.25, 0.75];
  const Q = new Float64Array(600);
  for (let i = 0; i < 200; i++) {
    const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
    Q[i * 3] = R[0] * x + R[1] * y + R[2] * z + t[0];
    Q[i * 3 + 1] = R[3] * x + R[4] * y + R[5] * z + t[1];
    Q[i * 3 + 2] = R[6] * x + R[7] * y + R[8] * z + t[2];
  }
  const res = hornTransform(P, Q, 200);
  for (let i = 0; i < 9; i++) assert.ok(Math.abs(res.R[i] - R[i]) < 1e-6, `R[${i}]`);
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(res.t[i] - t[i]) < 1e-5, `t[${i}]`);
});

test('ICP : recale deux scans de la même pièce (décalage 0,15 m + 3°) avec RMSE final proche du bruit', () => {
  const target = room(60000, 5);
  // bruit de 2 mm sur la cible
  const r = rng(77);
  for (let i = 0; i < target.length; i++) target[i] += (r() - 0.5) * 0.004;
  const source = room(15000, 6); // autre échantillonnage des mêmes surfaces
  const ang = (3 * Math.PI) / 180;
  const c = Math.cos(ang), s = Math.sin(ang);
  const t0 = [0.15, -0.1, 0.05];
  // source_déplacée = Rz(ang)·source + t0  : l'ICP doit retrouver l'inverse
  const moved = new Float32Array(source.length);
  for (let i = 0; i < source.length / 3; i++) {
    const x = source[i * 3], y = source[i * 3 + 1], z = source[i * 3 + 2];
    moved[i * 3] = c * x - s * y + t0[0]; moved[i * 3 + 1] = s * x + c * y + t0[1]; moved[i * 3 + 2] = z + t0[2];
  }
  const res = icp(moved, target, { maxIter: 60, tolerance: 1e-7, maxDist: 1.0, overlap: 0.9 });
  // deux échantillonnages indépendants (~6 cm entre points) : le RMSE ne peut pas descendre sous la
  // résolution du nuage (~3 cm), c'est la justesse de la transformation retrouvée qui est contrôlée
  assert.ok(res.rmse < 0.035, `RMSE final ${res.rmse}`);
  assert.ok(res.history[0] > res.rmse * 2, `le RMSE doit baisser nettement (${res.history[0]} → ${res.rmse})`);
  // la transformation trouvée doit ≈ inverser le déplacement : appliquée à `moved` on retombe sur `source`
  const R = res.R, t = res.t;
  let worst = 0;
  for (let i = 0; i < 300; i++) {
    const x = moved[i * 3], y = moved[i * 3 + 1], z = moved[i * 3 + 2];
    const X = R[0] * x + R[1] * y + R[2] * z + t[0], Y = R[3] * x + R[4] * y + R[5] * z + t[1], Z = R[6] * x + R[7] * y + R[8] * z + t[2];
    worst = Math.max(worst, Math.hypot(X - source[i * 3], Y - source[i * 3 + 1], Z - source[i * 3 + 2]));
  }
  assert.ok(worst < 0.01, `écart max de recalage ${worst} m`);
});

function toCloud(p) {
  const n = p.length / 3;
  return { positions: p, colors: new Uint8Array(n * 3).fill(100), intensity: new Float32Array(n).fill(0.5), count: n };
}

test('Voxel : un point par cellule, centroïde exact, couleurs conservées', () => {
  // 2 amas de points dans 2 cellules de 1 m
  const p = new Float32Array([0.1, 0.1, 0.1, 0.3, 0.3, 0.3, 0.2, 0.2, 0.2, 5.4, 5.4, 5.4, 5.6, 5.6, 5.6]);
  const res = voxelDownsample(toCloud(p), { size: 1, mode: 'centroid' });
  assert.equal(res.cloud.count, 2);
  assert.equal(res.removed, 3);
  const a = [...res.cloud.positions.slice(0, 3)].map((v) => +v.toFixed(5));
  assert.deepEqual(a, [0.2, 0.2, 0.2]);
  assert.equal(res.cloud.colors[0], 100);
  const first = voxelDownsample(toCloud(p), { size: 1, mode: 'first' });
  assert.equal(first.cloud.positions[0], Math.fround(0.1));
});

test('Voxel : réduit fortement un nuage dense', () => {
  const res = voxelDownsample(toCloud(room(50000)), { size: 0.25 });
  assert.ok(res.cloud.count < 8000 && res.cloud.count > 500, `count=${res.cloud.count}`);
});

test('Filtre statistique et filtre rayon : retirent les points isolés', () => {
  const base = room(8000, 9);
  const n = 8000 + 40;
  const p = new Float32Array(n * 3);
  p.set(base);
  const r = rng(5);
  for (let i = 8000; i < n; i++) { p[i * 3] = (r() - 0.5) * 40; p[i * 3 + 1] = (r() - 0.5) * 40; p[i * 3 + 2] = 20 + r() * 20; } // flottants
  const sor = statisticalOutlierRemoval(toCloud(p), { k: 8, stdRatio: 1.5 });
  assert.ok(sor.removed >= 38, `SOR a retiré ${sor.removed}`);
  const ror = radiusOutlierRemoval(toCloud(p), { radius: 0.5, minNeighbors: 4 });
  assert.ok(ror.removed >= 38 && ror.removed < 400, `ROR a retiré ${ror.removed}`);
});

test('Boîte de découpe : dedans / dehors, avec matrice de scène', () => {
  const p = new Float32Array([0, 0, 0, 1, 1, 1, 5, 5, 5]);
  const inside = clipBox(toCloud(p), IDENT, [-0.5, -0.5, -0.5], [1.5, 1.5, 1.5], { keep: 'inside' });
  assert.equal(inside.cloud.count, 2);
  const outside = clipBox(toCloud(p), IDENT, [-0.5, -0.5, -0.5], [1.5, 1.5, 1.5], { keep: 'outside' });
  assert.equal(outside.cloud.count, 1);
  // translation de scène de +10 en x : la boîte ne contient plus rien
  const M = [...IDENT]; M[12] = 10;
  assert.equal(clipBox(toCloud(p), M, [-0.5, -0.5, -0.5], [1.5, 1.5, 1.5]).cloud.count, 0);
});
