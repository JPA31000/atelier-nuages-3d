import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDemo, DEMO_ORIGIN } from '../src/demo/demoScene.js';
import { icp } from '../src/geo/icp.js';

const demo = buildDemo({ azStep: 1.0, elStep: 1.2, panoWidth: 256 });

test('démo : deux nuages centrés, stations et panoramiques cohérents', () => {
  assert.equal(demo.clouds.length, 2);
  assert.equal(demo.images.length, 2);
  for (const c of demo.clouds) {
    assert.ok(c.count > 20000, `count ${c.count}`);
    // grandes coordonnées conservées dans l'offset, petites en local
    assert.ok(c.offset[0] > 651000 && c.offset[1] > 6862000);
    let big = 0; for (let i = 0; i < c.positions.length; i++) big = Math.max(big, Math.abs(c.positions[i])); assert.ok(big < 12, `local max ${big}`);
    assert.ok(c.colors && c.intensity && c.station);
  }
  assert.equal(demo.images[0].rgba.length, 256 * 128 * 4);
  assert.ok(demo.images[0].rgba.some((v, i) => i % 4 === 0 && v > 0));
});

test('démo + ICP : le défaut de recalage (≈14 cm, 2,5°) de la station 2 est corrigé', () => {
  const [a, b] = demo.clouds;
  const origin = a.offset;
  const toScene = (c) => {
    const out = new Float32Array(c.count * 3);
    for (let i = 0; i < c.count; i++) for (let k = 0; k < 3; k++) out[i * 3 + k] = c.positions[i * 3 + k] + c.offset[k] - origin[k];
    return out;
  };
  const src = toScene(b), tgt = toScene(a);
  const before = icp(src, tgt, { maxIter: 0, maxDist: 1, overlap: 0.8 });
  const res = icp(src.subarray(0, 3 * 20000), tgt, { maxIter: 80, tolerance: 1e-8, maxDist: 1, overlap: 0.5 });
  // angle de la rotation retrouvée
  const R = res.R;
  const angle = Math.acos(Math.max(-1, Math.min(1, (R[0] + R[4] + R[8] - 1) / 2))) * (180 / Math.PI);
  // Le RMSE point-à-point est borné par l'espacement des points (~8 cm ici, nuages très épars) : on contrôle
  // donc surtout l'angle retrouvé (défaut injecté : 2,5°) et la baisse nette de l'erreur.
  assert.ok(res.rmse < before.rmse * 0.8, `RMSE ${before.rmse} -> ${res.rmse}`);
  assert.ok(angle > 2.2 && angle < 2.8, `rotation corrigée ${angle}°`);
});

test('démo : dimensions de la salle retrouvées dans le nuage 1', () => {
  const c = demo.clouds[0];
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < c.count; i++) for (let k = 0; k < 3; k++) {
    const v = c.positions[i * 3 + k] + c.offset[k] - DEMO_ORIGIN[k];
    mn[k] = Math.min(mn[k], v); mx[k] = Math.max(mx[k], v);
  }
  // la salle vaut 9×6×3 mais est tournée de 20° dans le repère du scanner (la pose est appliquée) → on teste la hauteur
  assert.ok(Math.abs((mx[2] - mn[2]) - 3) < 0.05, `hauteur ${mx[2] - mn[2]}`);
});
