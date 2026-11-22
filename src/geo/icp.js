// ICP point-à-point (Iterative Closest Point) avec rejet des appariements aberrants.
//
// À chaque itération :
//   1. on transforme les points sources avec la transformation courante ;
//   2. pour chacun, on cherche le plus proche voisin dans le nuage cible (KD-tree) ;
//   3. on ne garde que les paires à distance ≤ maxDist et parmi elles les `overlap` meilleures
//      (recouvrement partiel entre deux scans) ;
//   4. la transformation rigide optimale de ces paires est calculée (Horn) puis composée ;
//   5. on s'arrête quand le RMSE ne bouge plus (tolérance) ou au nombre d'itérations maximal.

import { KDTree } from './kdtree.js';
import { hornTransform, toMatrix4 } from './rigid.js';

const mul3 = (A, B) => [
  A[0] * B[0] + A[1] * B[3] + A[2] * B[6], A[0] * B[1] + A[1] * B[4] + A[2] * B[7], A[0] * B[2] + A[1] * B[5] + A[2] * B[8],
  A[3] * B[0] + A[4] * B[3] + A[5] * B[6], A[3] * B[1] + A[4] * B[4] + A[5] * B[7], A[3] * B[2] + A[4] * B[5] + A[5] * B[8],
  A[6] * B[0] + A[7] * B[3] + A[8] * B[6], A[6] * B[1] + A[7] * B[4] + A[8] * B[7], A[6] * B[2] + A[7] * B[5] + A[8] * B[8],
];

/**
 * @param {Float32Array|Float64Array} src points sources xyz (repère commun, valeurs petites)
 * @param {Float32Array|Float64Array} tgt points cibles xyz (même repère)
 * @param {{maxIter?:number, tolerance?:number, maxDist?:number, overlap?:number, maxSrc?:number}} opts
 * @param {(it:number, rmse:number, pairs:number)=>void} [onIter]
 * @returns {{R:number[], t:number[], matrix:number[], rmse:number, history:number[], iterations:number, pairs:number, converged:boolean}}
 */
export function icp(src, tgt, opts = {}, onIter = () => {}) {
  const maxIter = opts.maxIter ?? 50;
  const tol = opts.tolerance ?? 1e-6;
  const overlap = Math.min(1, Math.max(0.05, opts.overlap ?? 0.85));
  const maxDist = opts.maxDist ?? Infinity;
  const nS = Math.min(Math.floor(src.length / 3), opts.maxSrc ?? Infinity);
  const nT = Math.floor(tgt.length / 3);
  if (nS < 3 || nT < 3) throw new Error('ICP : pas assez de points.');
  const tree = new KDTree(tgt, nT);

  let R = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  let t = [0, 0, 0];
  const cur = new Float64Array(nS * 3);
  const match = new Float64Array(nS * 3);
  const pcur = new Float64Array(nS * 3);
  const d2s = new Float64Array(nS);
  const ok = new Uint8Array(nS);
  const history = [];
  let prev = Infinity;
  let used = 0;
  let converged = false;
  let it = 0;

  const evaluate = () => {
    // applique (R,t), apparie, sélectionne ; renvoie rmse sur les paires retenues
    for (let i = 0; i < nS; i++) {
      const x = src[i * 3], y = src[i * 3 + 1], z = src[i * 3 + 2];
      const cx = R[0] * x + R[1] * y + R[2] * z + t[0];
      const cy = R[3] * x + R[4] * y + R[5] * z + t[1];
      const cz = R[6] * x + R[7] * y + R[8] * z + t[2];
      cur[i * 3] = cx; cur[i * 3 + 1] = cy; cur[i * 3 + 2] = cz;
      const j = tree.nearest(cx, cy, cz, maxDist * maxDist);
      if (j < 0) { ok[i] = 0; d2s[i] = Infinity; continue; }
      ok[i] = 1;
      d2s[i] = tree.bestD2;
      match[i * 3] = tgt[j * 3]; match[i * 3 + 1] = tgt[j * 3 + 1]; match[i * 3 + 2] = tgt[j * 3 + 2];
    }
    // seuil de recouvrement : quantile des distances valides
    const valid = [];
    for (let i = 0; i < nS; i++) if (ok[i]) valid.push(d2s[i]);
    if (valid.length < 3) throw new Error('ICP : aucun appariement sous la distance maximale (augmentez-la).');
    valid.sort((a, b) => a - b);
    const thr = valid[Math.min(valid.length - 1, Math.floor(valid.length * overlap))];
    let n = 0, sum = 0;
    for (let i = 0; i < nS; i++) {
      if (!ok[i] || d2s[i] > thr) continue;
      pcur[n * 3] = cur[i * 3]; pcur[n * 3 + 1] = cur[i * 3 + 1]; pcur[n * 3 + 2] = cur[i * 3 + 2];
      match[n * 3] = match[i * 3]; match[n * 3 + 1] = match[i * 3 + 1]; match[n * 3 + 2] = match[i * 3 + 2];
      sum += d2s[i];
      n++;
    }
    used = n;
    return Math.sqrt(sum / Math.max(1, n));
  };

  let rmse = Infinity;
  for (it = 1; it <= maxIter; it++) {
    rmse = evaluate();
    history.push(rmse);
    onIter(it, rmse, used);
    if (Math.abs(prev - rmse) < tol) { converged = true; break; }
    prev = rmse;
    const d = hornTransform(pcur, match, used);
    R = mul3(d.R, R);
    t = [
      d.R[0] * t[0] + d.R[1] * t[1] + d.R[2] * t[2] + d.t[0],
      d.R[3] * t[0] + d.R[4] * t[1] + d.R[5] * t[2] + d.t[1],
      d.R[6] * t[0] + d.R[7] * t[1] + d.R[8] * t[2] + d.t[2],
    ];
  }
  // RMSE final après la dernière mise à jour
  rmse = evaluate();
  history.push(rmse);
  return { R, t, matrix: toMatrix4(R, t), rmse, history, iterations: Math.min(it, maxIter), pairs: used, converged };
}
