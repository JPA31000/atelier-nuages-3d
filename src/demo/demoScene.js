// Jeu de données de démonstration (généré dans le navigateur, aucun fichier à télécharger) :
// une salle 9 × 6 × 3 m avec mobilier, « scannée » depuis deux stations par lancer de rayons, avec
//   - deux nuages en coordonnées globales type Lambert-93 (démonstration du centrage / de la précision) ;
//   - un panoramique équirectangulaire 2048 × 1024 par station, rendu avec la même géométrie ;
//   - un défaut de recalage VOLONTAIRE sur la station 2 (≈ 14 cm et 2,5°) à corriger avec l'ICP.
// Fonction pure (aucun accès au DOM) : utilisée aussi par les tests.

import { PointCollector } from '../io/collector.js';

const ROOM = { min: [0, 0, 0], max: [9, 6, 3] };
const BOXES = [
  { min: [2.4, 2.6, 0], max: [3.6, 3.4, 0.75], color: [150, 100, 60] }, // table
  { min: [6.3, 1.3, 0], max: [6.7, 1.7, 3], color: [150, 150, 155] }, // poteau
  { min: [1, 5.5, 0], max: [3, 6, 2], color: [60, 100, 170] }, // armoire
  { min: [7.5, 4.8, 0], max: [8.5, 5.8, 0.5], color: [190, 150, 70] }, // caisse
];
const LIGHT = (() => { const v = [0.3, 0.2, 0.93]; const n = Math.hypot(...v); return v.map((c) => c / n); })();

function castRay(o, d) {
  let tRoom = Infinity, rAxis = 0, rSign = 1;
  for (let a = 0; a < 3; a++) {
    if (d[a] === 0) continue;
    const t = d[a] > 0 ? (ROOM.max[a] - o[a]) / d[a] : (ROOM.min[a] - o[a]) / d[a];
    if (t > 1e-9 && t < tRoom) { tRoom = t; rAxis = a; rSign = d[a] > 0 ? 1 : -1; }
  }
  let best = tRoom, box = null, bAxis = 0;
  for (const b of BOXES) {
    let t0 = -Infinity, t1 = Infinity, ax0 = 0;
    let ok = true;
    for (let a = 0; a < 3 && ok; a++) {
      if (d[a] === 0) { if (o[a] < b.min[a] || o[a] > b.max[a]) ok = false; continue; }
      let ta = (b.min[a] - o[a]) / d[a], tb = (b.max[a] - o[a]) / d[a];
      if (ta > tb) { const s = ta; ta = tb; tb = s; }
      if (ta > t0) { t0 = ta; ax0 = a; }
      if (tb < t1) t1 = tb;
      if (t0 > t1) ok = false;
    }
    if (ok && t0 > 1e-6 && t0 < best) { best = t0; box = b; bAxis = ax0; }
  }
  const p = [o[0] + d[0] * best, o[1] + d[1] * best, o[2] + d[2] * best];
  const n = [0, 0, 0];
  let color;
  if (box) {
    n[bAxis] = -Math.sign(d[bAxis]); // normale de la face touchée, orientée vers le scanner
    color = box.color;
    if (bAxis === 2 && n[2] > 0) color = color.map((c) => Math.min(255, c * 1.15));
  } else {
    n[rAxis] = -rSign; // normale intérieure de la pièce
    const [x, y, z] = p;
    if (rAxis === 2 && rSign < 0) { const k = (Math.floor(x / 0.5) + Math.floor(y / 0.5)) & 1; color = k ? [172, 160, 140] : [120, 112, 100]; }
    else if (rAxis === 2) color = Math.abs(x - 4.5) < 1 && Math.abs(y - 3) < 0.6 ? [255, 255, 240] : [235, 235, 230];
    else if (z < 0.12) color = [70, 60, 55];
    else if (rAxis === 0 && rSign < 0) color = [236, 214, 140]; // mur ouest
    else if (rAxis === 0) color = y > 2.5 && y < 3.5 && z > 1 && z < 2 ? [210, 40, 40] : [150, 190, 230]; // mur est (carré rouge)
    else if (rAxis === 1 && rSign < 0) color = [150, 215, 160]; // mur sud
    else color = x > 5 && x < 7 && z > 1.2 && z < 2.1 ? [250, 210, 40] : [235, 170, 190]; // mur nord (rectangle jaune)
  }
  const lam = Math.max(0, n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2]);
  return { t: best, point: p, normal: n, color, shade: 0.62 + 0.38 * lam };
}

const rotZ = (v, a) => [v[0] * Math.cos(a) - v[1] * Math.sin(a), v[0] * Math.sin(a) + v[1] * Math.cos(a), v[2]];

/** Direction dans le repère du scanner pour (azimut, élévation) en radians. */
const dirOf = (az, el) => [Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el)];

export const DEMO_ORIGIN = [651200.0, 6862300.0, 45.0];

/**
 * @param {{azStep?:number, elStep?:number, panoWidth?:number, seed?:number}} [opt] pas angulaires en degrés
 */
export function buildDemo({ azStep = 0.5, elStep = 0.6, panoWidth = 2048, seed = 12345 } = {}) {
  const stations = [
    { name: 'Station 1', pos: [2.0, 1.5, 1.3], yaw: 20 * (Math.PI / 180), err: { d: [0, 0, 0], yaw: 0 } },
    { name: 'Station 2', pos: [6.4, 4.2, 1.3], yaw: -35 * (Math.PI / 180), err: { d: [0.12, -0.08, 0.03], yaw: 2.5 * (Math.PI / 180) } },
  ];
  let s = seed >>> 0 || 1;
  const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  const gauss = () => (rnd() + rnd() + rnd() + rnd() - 2) * 1.7;

  const clouds = [];
  const images = [];
  stations.forEach((st, si) => {
    // Pose appliquée au fichier (avec défaut de recalage) ; la géométrie réelle utilise st.pos / st.yaw.
    const wrongPos = st.pos.map((v, i) => v + st.err.d[i]);
    const wrongYaw = st.yaw + st.err.yaw;
    const raw = (p) => rotZ(p, wrongYaw).map((v, i) => v + wrongPos[i] + DEMO_ORIGIN[i]);
    const col = new PointCollector({ expected: 0, offsetHint: raw([0, 0, 0]), hasColor: true, hasIntensity: true, seed: 99 + si });
    for (let el = -62; el <= 90; el += elStep) {
      for (let az = -180; az < 180; az += azStep) {
        const dl = dirOf(az * (Math.PI / 180), el * (Math.PI / 180));
        const dw = rotZ(dl, st.yaw);
        const hit = castRay(st.pos, dw);
        if (!(hit.t > 0.3)) continue;
        const range = hit.t + gauss() * 0.002;
        const p = raw([dl[0] * range, dl[1] * range, dl[2] * range]);
        const k = hit.shade;
        col.add(p[0], p[1], p[2], hit.color[0] * k, hit.color[1] * k, hit.color[2] * k, Math.max(0, Math.min(1, k * (0.8 + 0.2 * rnd()))));
      }
    }
    const out = col.finish({ colorMax: 255 });
    clouds.push({
      name: st.name,
      ...out,
      station: { name: st.name, position: raw([0, 0, 0]), quaternion: [0, 0, Math.sin(wrongYaw / 2), Math.cos(wrongYaw / 2)] },
      meta: { source: 'démonstration', decalage: si ? 'recalage volontairement imparfait (≈ 14 cm, 2,5°)' : 'référence' },
    });

    // panoramique équirectangulaire
    const W = panoWidth, H = panoWidth / 2;
    const rgba = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) {
      const el = Math.PI / 2 - ((y + 0.5) / H) * Math.PI;
      for (let x = 0; x < W; x++) {
        const az = Math.PI - ((x + 0.5) / W) * 2 * Math.PI;
        const hit = castRay(st.pos, rotZ(dirOf(az, el), st.yaw));
        const k = hit.shade * Math.max(0.55, 1 - hit.t * 0.03);
        const o = (y * W + x) * 4;
        rgba[o] = hit.color[0] * k; rgba[o + 1] = hit.color[1] * k; rgba[o + 2] = hit.color[2] * k; rgba[o + 3] = 255;
      }
    }
    images.push({ name: `${st.name} (panoramique)`, rgba, width: W, height: H, stationIndex: si });
  });
  return { clouds, images };
}

/** Longueurs réelles connues de la salle (pour vérifier les mesures dans les tests et dans le guide). */
export const DEMO_TRUTH = { largeur: 9, profondeur: 6, hauteur: 3, tableHauteur: 0.75 };
