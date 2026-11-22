// Recalage : pré-alignement manuel (gizmo + valeurs), points homologues, ICP.

import * as THREE from 'three';
import { geo } from '../core/workers.js';
import { $, esc, fmt, fmtInt, toast } from './dom.js';

const DEG = Math.PI / 180;

export function initRegistration(app) {
  const { store, viewer } = app;
  const selSrc = $('#reg-source'), selTgt = $('#reg-target');
  const pairs = []; // {a: Vector3 (source), b: Vector3 (cible)}
  let pairStep = null; // null | 'src' | 'tgt'
  let pendingA = null;

  const src = () => store.cloud(selSrc.value);
  const tgt = () => store.cloud(selTgt.value);

  function fillSelects() {
    const keepS = selSrc.value, keepT = selTgt.value;
    const opts = store.clouds.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
    selSrc.innerHTML = opts; selTgt.innerHTML = opts;
    const ids = store.clouds.map((c) => c.id);
    let s = ids.includes(keepS) ? keepS : null, t = ids.includes(keepT) ? keepT : null;
    if (!s || !t || s === t) { s = ids[ids.length - 1] ?? ''; t = ids[0] ?? ''; } // par défaut : dernier nuage → premier
    selSrc.value = s; selTgt.value = t;
    if ($('#gizmo-on').checked) toggleGizmo();
  }
  app.onCloudsChanged(fillSelects);
  selSrc.addEventListener('change', () => { if ($('#gizmo-on').checked) toggleGizmo(); clearPairs(); });
  selTgt.addEventListener('change', clearPairs);

  // ---------------------------------------------------------------- manuel
  function toggleGizmo() {
    if (viewer.stationId && $('#gizmo-on').checked) viewer.leaveStation();
    const c = $('#gizmo-on').checked ? src() : null;
    viewer.attachGizmo(c, $('input[name="gmode"]:checked').value);
  }
  $('#gizmo-on').addEventListener('change', toggleGizmo);
  document.querySelectorAll('input[name="gmode"]').forEach((r) => r.addEventListener('change', () => viewer.setGizmoMode(r.value)));
  viewer.on('gizmo-end', () => { app.renderClouds(); });

  function applyDelta(c, delta) {
    c.prevMatrix = c.matrix.clone();
    c.matrix.premultiply(delta);
    viewer.matricesChanged(c);
    if ($('#gizmo-on').checked) toggleGizmo();
  }

  $('#btn-move-apply').addEventListener('click', () => {
    const c = src();
    if (!c) return toast('Aucun nuage source.', 'warn');
    const v = (id) => parseFloat($(id).value) || 0;
    const ctr = c.boundsScene().getCenter(new THREE.Vector3());
    const rot = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(v('#mv-rx') * DEG, v('#mv-ry') * DEG, v('#mv-rz') * DEG, 'XYZ'));
    const delta = new THREE.Matrix4().makeTranslation(ctr.x + v('#mv-dx'), ctr.y + v('#mv-dy'), ctr.z + v('#mv-dz'))
      .multiply(rot).multiply(new THREE.Matrix4().makeTranslation(-ctr.x, -ctr.y, -ctr.z));
    applyDelta(c, delta);
    ['#mv-dx', '#mv-dy', '#mv-dz', '#mv-rx', '#mv-ry', '#mv-rz'].forEach((i) => { $(i).value = 0; });
    toast('Décalage appliqué (rotation autour du centre du nuage).', 'ok');
  });
  $('#btn-move-undo').addEventListener('click', () => {
    const c = src();
    if (!c?.prevMatrix) return toast('Rien à annuler.', 'warn');
    c.matrix.copy(c.prevMatrix); c.prevMatrix = null;
    viewer.matricesChanged(c);
    if ($('#gizmo-on').checked) toggleGizmo();
  });
  $('#btn-move-reset').addEventListener('click', () => {
    const c = src();
    if (!c) return;
    c.prevMatrix = c.matrix.clone();
    c.matrix.copy(c.initialMatrix);
    viewer.matricesChanged(c);
    if ($('#gizmo-on').checked) toggleGizmo();
  });

  // ---------------------------------------------------------------- points homologues
  function renderPairs() {
    $('#pair-info').textContent = pairStep === 'src' ? `${pairs.length} paire(s) — cliquez le point sur la SOURCE (« ${src()?.name} »)`
      : pairStep === 'tgt' ? `${pairs.length} paire(s) — cliquez le MÊME point sur la CIBLE (« ${tgt()?.name} »)`
        : `${pairs.length} paire(s)${pairs.length < 3 ? ' — il en faut au moins 3.' : ' — prêt à calculer.'}`;
    viewer.setMarks('pairA', pairs.map((p) => p.a).concat(pendingA ? [pendingA] : []), 0x4fc3ff);
    viewer.setMarks('pairB', pairs.map((p) => p.b), 0xff8a4f);
  }
  function clearPairs() { pairs.length = 0; pendingA = null; stopPicking(); renderPairs(); }
  function stopPicking() {
    if (pairStep) { pairStep = null; pendingA = null; viewer.setPicker(null); app.setBanner(''); renderPairs(); }
  }
  function nextPick() {
    const s = pairStep === 'src' ? src() : tgt();
    viewer.setPicker((hit) => {
      if (pairStep === 'src') { pendingA = hit.point.clone(); pairStep = 'tgt'; }
      else { pairs.push({ a: pendingA, b: hit.point.clone() }); pendingA = null; pairStep = 'src'; }
      app.setBanner(pairStep === 'src' ? 'Paire : point sur la SOURCE (Échap pour finir)' : 'Paire : même point sur la CIBLE');
      renderPairs();
      nextPick();
    });
    viewer.picker.only = s;
    viewer.picker.noDrag = false;
  }
  $('#btn-pair-add').addEventListener('click', () => {
    if (!src() || !tgt() || src() === tgt()) return toast('Choisissez deux nuages différents (source et cible).', 'warn');
    app.cancelTools();
    if (viewer.stationId) viewer.leaveStation();
    pairStep = 'src';
    app.setBanner('Paire : point sur la SOURCE (Échap pour finir)');
    renderPairs();
    nextPick();
  });
  $('#btn-pair-clear').addEventListener('click', clearPairs);
  $('#btn-pair-solve').addEventListener('click', async () => {
    if (pairs.length < 3) return toast('Il faut au moins 3 paires de points.', 'warn');
    const c = src();
    stopPicking();
    const P = new Float64Array(pairs.length * 3), Q = new Float64Array(pairs.length * 3);
    pairs.forEach((p, i) => { p.a.toArray(P, i * 3); p.b.toArray(Q, i * 3); });
    const r = await geo.run({ op: 'pairs', payload: { P, Q } });
    applyDelta(c, new THREE.Matrix4().fromArray(r.matrix));
    pairs.length = 0; renderPairs();
    toast(`Recalage par points homologues : écart quadratique des paires ${fmt(r.rmse * 1000, 1)} mm.`, 'ok', 7000);
  });

  // ---------------------------------------------------------------- ICP
  $('#icp-n').addEventListener('input', (e) => { $('#icp-n-val').textContent = fmtInt(+e.target.value); });

  function sample(c, n, origin) {
    const out = new Float32Array(n * 3);
    const m = c.matrix.elements, p = c.positions;
    for (let i = 0; i < n; i++) {
      const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
      out[i * 3] = m[0] * x + m[4] * y + m[8] * z + m[12] - origin.x;
      out[i * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13] - origin.y;
      out[i * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14] - origin.z;
    }
    return out;
  }

  function drawChart(hist) {
    const cv = $('#icp-chart');
    const g = cv.getContext('2d');
    g.clearRect(0, 0, cv.width, cv.height);
    if (hist.length < 2) return;
    const mx = Math.max(...hist), mn = Math.min(...hist);
    g.strokeStyle = '#3fa7ff'; g.lineWidth = 2; g.beginPath();
    hist.forEach((v, i) => {
      const x = (i / (hist.length - 1)) * (cv.width - 8) + 4;
      const y = cv.height - 6 - ((v - mn) / Math.max(1e-12, mx - mn)) * (cv.height - 12);
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    });
    g.stroke();
    g.fillStyle = '#8b97a8'; g.font = '10px sans-serif';
    g.fillText(`${(mx * 1000).toFixed(1)} mm`, 6, 11);
    g.fillText(`${(mn * 1000).toFixed(1)} mm`, 6, cv.height - 8);
  }

  $('#btn-icp').addEventListener('click', async () => {
    const s = src(), t = tgt();
    if (!s || !t || s === t) return toast('Choisissez deux nuages différents (source et cible).', 'warn');
    const origin = t.boundsScene().getCenter(new THREE.Vector3());
    const srcArr = sample(s, Math.min(s.count, +$('#icp-n').value), origin);
    const tgtArr = sample(t, Math.min(t.count, 300000), origin);
    const maxIter = Math.max(1, +$('#icp-iter').value || 50);
    const params = { maxIter, tolerance: 1e-5, maxDist: Math.max(0.01, +$('#icp-dist').value || 1), overlap: Math.min(1, Math.max(0.1, (+$('#icp-overlap').value || 80) / 100)) };
    try {
      const r = await app.busy('Recalage ICP', geo, (p) => geo.run({ op: 'icp', payload: { src: srcArr, tgt: tgtArr, params } }, [srcArr.buffer, tgtArr.buffer], p));
      const rel = new THREE.Matrix4().fromArray(r.matrix);
      const delta = new THREE.Matrix4().makeTranslation(origin.x, origin.y, origin.z).multiply(rel).multiply(new THREE.Matrix4().makeTranslation(-origin.x, -origin.y, -origin.z));
      applyDelta(s, delta);
      const ang = Math.acos(Math.min(1, Math.max(-1, (r.R[0] + r.R[4] + r.R[8] - 1) / 2))) / DEG;
      $('#icp-result').hidden = false;
      $('#icp-rmse').textContent = `${fmt(r.rmse * 1000, 2)} mm`;
      $('#icp-detail').textContent = `${r.iterations} itérations · ${fmtInt(r.pairs)} paires · rotation ${fmt(ang, 2)}° · translation ${fmt(Math.hypot(...r.t), 3)} m · ${r.converged ? 'convergé' : 'arrêt au maximum d\'itérations'}`;
      drawChart(r.history);
      toast(`ICP terminé : RMSE ${fmt(r.rmse * 1000, 1)} mm (début ${fmt(r.history[0] * 1000, 1)} mm).`, 'ok', 7000);
    } catch (e) {
      if (!/annul/i.test(e.message)) toast(`ICP : ${e.message}`, 'err', 8000);
    }
  });

  renderPairs();
  return { stopPicking, clearPairs };
}
