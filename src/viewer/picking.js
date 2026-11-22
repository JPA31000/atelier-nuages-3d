// Sélection de points dans le nuage (côté CPU, sans dépendance au GPU) :
//   - pickScreen : point le plus proche de la caméra sous le pointeur (vue 3D) ;
//   - pickRay    : point le plus proche de l'origine le long d'un rayon, dans un cône (vue panoramique).
// Les coordonnées renvoyées sont celles du point RÉEL du nuage (pas une interpolation), repère scène.

import * as THREE from 'three';

const _m = new THREE.Matrix4();
const _inv = new THREE.Matrix4();

/**
 * @param {Array<Cloud>} clouds nuages à tester (visibles)
 * @param {THREE.PerspectiveCamera} camera caméra dont matrixWorldInverse / projectionMatrix sont à jour
 * @param {number} px,py position du pointeur en pixels dans la vue
 * @param {number} w,h taille de la vue en pixels
 * @param {number} radiusPx rayon de tolérance en pixels
 */
export function pickScreen(clouds, camera, px, py, w, h, radiusPx = 8) {
  let best = Infinity, bi = -1, bc = null;
  const rx = (radiusPx / w) * 2, ry = (radiusPx / h) * 2;
  const cxp = (px / w) * 2 - 1, cyp = 1 - (py / h) * 2;
  for (const c of clouds) {
    _m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(c.matrix);
    const m = _m.elements;
    const p = c.positions;
    const n = c.count;
    const m0 = m[0], m1 = m[1], m3 = m[3], m4 = m[4], m5 = m[5], m7 = m[7], m8 = m[8], m9 = m[9], m11 = m[11], m12 = m[12], m13 = m[13], m15 = m[15];
    for (let i = 0; i < n; i++) {
      const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
      const cw = m3 * x + m7 * y + m11 * z + m15;
      if (cw <= 0 || cw >= best) continue;
      const cx = (m0 * x + m4 * y + m8 * z + m12) / cw - cxp;
      if (cx > rx || cx < -rx) continue;
      const cy = (m1 * x + m5 * y + m9 * z + m13) / cw - cyp;
      if (cy > ry || cy < -ry) continue;
      if ((cx / rx) ** 2 + (cy / ry) ** 2 > 1) continue;
      best = cw; bi = i; bc = c;
    }
  }
  if (!bc) return null;
  const v = new THREE.Vector3(bc.positions[bi * 3], bc.positions[bi * 3 + 1], bc.positions[bi * 3 + 2]).applyMatrix4(bc.matrix);
  return { cloud: bc, index: bi, point: v, depth: best };
}

/**
 * @param {THREE.Vector3} origin origine du rayon (scène)
 * @param {THREE.Vector3} dir direction unitaire (scène)
 * @param {number} angTol demi-angle du cône (radians)
 */
export function pickRay(clouds, origin, dir, angTol, { minRange = 0.15 } = {}) {
  const tanTol2 = Math.tan(angTol) ** 2;
  const cands = [];
  for (const c of clouds) {
    _inv.copy(c.matrix).invert();
    const o = origin.clone().applyMatrix4(_inv);
    const d = dir.clone().transformDirection(_inv);
    const p = c.positions;
    const n = c.count;
    const ox = o.x, oy = o.y, oz = o.z, dx = d.x, dy = d.y, dz = d.z;
    for (let i = 0; i < n; i++) {
      const vx = p[i * 3] - ox, vy = p[i * 3 + 1] - oy, vz = p[i * 3 + 2] - oz;
      const t = vx * dx + vy * dy + vz * dz;
      if (t < minRange) continue;
      const perp2 = vx * vx + vy * vy + vz * vz - t * t;
      if (perp2 > t * t * tanTol2) continue;
      cands.push({ t, c, i });
      if (cands.length > 40000) break;
    }
  }
  if (!cands.length) return null;
  cands.sort((a, b) => a.t - b.t);
  // premier groupe de points « épais » : on ignore les points isolés devant la vraie surface
  let pick = cands[0];
  for (let k = 0; k < cands.length; k++) {
    const t0 = cands[k].t;
    const win = Math.max(0.05, 0.02 * t0);
    let cnt = 0;
    for (let j = k; j < cands.length && cands[j].t - t0 <= win; j++) cnt++;
    if (cnt >= Math.min(3, cands.length - k)) { pick = cands[k]; break; }
  }
  const { c, i } = pick;
  const v = new THREE.Vector3(c.positions[i * 3], c.positions[i * 3 + 1], c.positions[i * 3 + 2]).applyMatrix4(c.matrix);
  return { cloud: c, index: i, point: v, range: pick.t };
}
