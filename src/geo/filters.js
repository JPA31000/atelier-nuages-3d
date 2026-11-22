// Filtres de nettoyage : valeurs aberrantes (statistique / rayon), découpe par boîte, voxels.
// Un « nuage » est ici { positions:Float32Array xyz, colors:Uint8Array|null, intensity:Float32Array|null, count }.
// Les fonctions renvoient un NOUVEAU nuage (l'original n'est jamais modifié).

import { KDTree } from './kdtree.js';

/** Garde les points dont mask[i] ≠ 0, dans le même ordre. */
export function compact(cloud, mask) {
  const { positions, colors, intensity, count } = cloud;
  let n = 0;
  for (let i = 0; i < count; i++) if (mask[i]) n++;
  const p = new Float32Array(n * 3);
  const c = colors ? new Uint8Array(n * 3) : null;
  const it = intensity ? new Float32Array(n) : null;
  let o = 0;
  for (let i = 0; i < count; i++) {
    if (!mask[i]) continue;
    p[o * 3] = positions[i * 3]; p[o * 3 + 1] = positions[i * 3 + 1]; p[o * 3 + 2] = positions[i * 3 + 2];
    if (c) { c[o * 3] = colors[i * 3]; c[o * 3 + 1] = colors[i * 3 + 1]; c[o * 3 + 2] = colors[i * 3 + 2]; }
    if (it) it[o] = intensity[i];
    o++;
  }
  return { positions: p, colors: c, intensity: it, count: n };
}

/**
 * Filtre statistique : pour chaque point, distance moyenne à ses k voisins ; on retire ceux dont la
 * distance dépasse  moyenne_globale + stdRatio × écart-type.
 */
export function statisticalOutlierRemoval(cloud, { k = 12, stdRatio = 2 } = {}, onProgress = () => {}) {
  const n = cloud.count;
  if (n <= k + 1) return { cloud, removed: 0, info: 'Nuage trop petit pour ce filtre.' };
  const tree = new KDTree(cloud.positions, n);
  const d2 = new Float64Array(k + 1);
  const mean = new Float32Array(n);
  let sum = 0, sum2 = 0;
  const p = cloud.positions;
  for (let i = 0; i < n; i++) {
    const m = tree.knn(p[i * 3], p[i * 3 + 1], p[i * 3 + 2], k + 1, d2);
    let s = 0;
    for (let j = 1; j < m; j++) s += Math.sqrt(d2[j]);
    const md = s / Math.max(1, m - 1);
    mean[i] = md;
    sum += md; sum2 += md * md;
    if ((i & 0x7fff) === 0) onProgress(i / n, 'Distances aux voisins…');
  }
  const mu = sum / n;
  const sigma = Math.sqrt(Math.max(0, sum2 / n - mu * mu));
  const thr = mu + stdRatio * sigma;
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) mask[i] = mean[i] <= thr ? 1 : 0;
  const out = compact(cloud, mask);
  return { cloud: out, removed: n - out.count, info: `Distance moyenne ${mu.toFixed(4)} m, σ = ${sigma.toFixed(4)} m, seuil ${thr.toFixed(4)} m` };
}

/** Filtre par rayon : retire les points ayant moins de `minNeighbors` voisins dans `radius`. */
export function radiusOutlierRemoval(cloud, { radius = 0.1, minNeighbors = 5 } = {}, onProgress = () => {}) {
  const n = cloud.count;
  const tree = new KDTree(cloud.positions, n);
  const mask = new Uint8Array(n);
  const p = cloud.positions;
  const r2 = radius * radius;
  for (let i = 0; i < n; i++) {
    // le point lui-même est compté : il faut minNeighbors + 1
    mask[i] = tree.countWithin(p[i * 3], p[i * 3 + 1], p[i * 3 + 2], r2, minNeighbors + 1) > minNeighbors ? 1 : 0;
    if ((i & 0x7fff) === 0) onProgress(i / n, 'Comptage des voisins…');
  }
  const out = compact(cloud, mask);
  return { cloud: out, removed: n - out.count, info: `Rayon ${radius} m, minimum ${minNeighbors} voisins` };
}

/**
 * Découpe par boîte dans le repère SCÈNE : un point est « dedans » si min ≤ M·p ≤ max.
 * @param {ArrayLike<number>} matrix matrice 4×4 colonne-major local → scène
 */
export function clipBox(cloud, matrix, min, max, { keep = 'inside' } = {}) {
  const n = cloud.count;
  const p = cloud.positions;
  const m = matrix;
  const mask = new Uint8Array(n);
  const inside = keep === 'inside';
  for (let i = 0; i < n; i++) {
    const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
    const X = m[0] * x + m[4] * y + m[8] * z + m[12];
    const Y = m[1] * x + m[5] * y + m[9] * z + m[13];
    const Z = m[2] * x + m[6] * y + m[10] * z + m[14];
    const dedans = X >= min[0] && X <= max[0] && Y >= min[1] && Y <= max[1] && Z >= min[2] && Z <= max[2];
    mask[i] = dedans === inside ? 1 : 0;
  }
  const out = compact(cloud, mask);
  return { cloud: out, removed: n - out.count, info: inside ? 'Points conservés dans la boîte' : 'Points conservés hors de la boîte' };
}

/** Sous-échantillonnage par grille de voxels : un point par voxel (centroïde ou premier point). */
export function voxelDownsample(cloud, { size = 0.05, mode = 'centroid' } = {}, onProgress = () => {}) {
  const n = cloud.count;
  const p = cloud.positions;
  if (!(size > 0)) throw new Error('La taille de voxel doit être > 0.');
  let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
    if (x < mnx) mnx = x; if (x > mxx) mxx = x;
    if (y < mny) mny = y; if (y > mxy) mxy = y;
    if (z < mnz) mnz = z; if (z > mxz) mxz = z;
  }
  const nx = Math.floor((mxx - mnx) / size) + 1, ny = Math.floor((mxy - mny) / size) + 1, nz = Math.floor((mxz - mnz) / size) + 1;
  if (nx * ny * nz > 9e15) throw new Error('Taille de voxel trop petite pour cette étendue.');
  const centroid = mode === 'centroid';
  const slot = new Map();
  let cap = Math.min(n, 1 << 20);
  let sx = new Float64Array(cap * 3), cnt = new Uint32Array(cap);
  let sc = cloud.colors ? new Float64Array(cap * 3) : null;
  let si = cloud.intensity ? new Float64Array(cap) : null;
  let m = 0;
  const inv = 1 / size;
  for (let i = 0; i < n; i++) {
    const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
    const key = Math.floor((x - mnx) * inv) + nx * (Math.floor((y - mny) * inv) + ny * Math.floor((z - mnz) * inv));
    let s = slot.get(key);
    if (s === undefined) {
      if (m >= cap) {
        cap *= 2;
        const a = new Float64Array(cap * 3); a.set(sx); sx = a;
        const c = new Uint32Array(cap); c.set(cnt); cnt = c;
        if (sc) { const b = new Float64Array(cap * 3); b.set(sc); sc = b; }
        if (si) { const b = new Float64Array(cap); b.set(si); si = b; }
      }
      s = m++;
      slot.set(key, s);
      sx[s * 3] = x; sx[s * 3 + 1] = y; sx[s * 3 + 2] = z;
      cnt[s] = 1;
      if (sc) { sc[s * 3] = cloud.colors[i * 3]; sc[s * 3 + 1] = cloud.colors[i * 3 + 1]; sc[s * 3 + 2] = cloud.colors[i * 3 + 2]; }
      if (si) si[s] = cloud.intensity[i];
    } else if (centroid) {
      sx[s * 3] += x; sx[s * 3 + 1] += y; sx[s * 3 + 2] += z;
      cnt[s]++;
      if (sc) { sc[s * 3] += cloud.colors[i * 3]; sc[s * 3 + 1] += cloud.colors[i * 3 + 1]; sc[s * 3 + 2] += cloud.colors[i * 3 + 2]; }
      if (si) si[s] += cloud.intensity[i];
    }
    if ((i & 0xfffff) === 0) onProgress(i / n, 'Remplissage des voxels…');
  }
  const pos = new Float32Array(m * 3);
  const col = sc ? new Uint8Array(m * 3) : null;
  const inten = si ? new Float32Array(m) : null;
  for (let s = 0; s < m; s++) {
    const c = centroid ? cnt[s] : 1;
    pos[s * 3] = sx[s * 3] / c; pos[s * 3 + 1] = sx[s * 3 + 1] / c; pos[s * 3 + 2] = sx[s * 3 + 2] / c;
    if (col) { col[s * 3] = Math.round(sc[s * 3] / c); col[s * 3 + 1] = Math.round(sc[s * 3 + 1] / c); col[s * 3 + 2] = Math.round(sc[s * 3 + 2] / c); }
    if (inten) inten[s] = si[s] / c;
  }
  return {
    cloud: { positions: pos, colors: col, intensity: inten, count: m },
    removed: n - m,
    info: `Voxel ${size} m : ${n.toLocaleString('fr-FR')} → ${m.toLocaleString('fr-FR')} points`,
  };
}
