// Outil de mesure : distance 3D, écarts dX/dY/dZ entre deux points, en vue 3D OU dans le panoramique 360°.
// Les points sont de VRAIS points du nuage (repère scène) ; les coordonnées affichées sont les coordonnées brutes.

import { newId } from '../core/model.js';
import { $, esc, fmt, toast } from './dom.js';

export function initMeasure(app) {
  const { store, viewer } = app;
  const btn = $('#btn-measure');
  let active = false;
  let pending = null;

  function onPick(hit, kind) {
    if (!pending) {
      pending = { id: newId('m'), a: hit.point.clone(), b: null, kind, visible: true, label: '' };
      store.measures.push(pending);
      viewer.syncMeasures();
      app.setBanner('Mesure : cliquez le 2ᵉ point');
    } else {
      const m = pending;
      pending = null;
      m.b = hit.point.clone();
      const d = m.b.clone().sub(m.a);
      m.dx = d.x; m.dy = d.y; m.dz = d.z;
      m.d3 = d.length();
      m.dh = Math.hypot(d.x, d.y);
      m.ca = store.toRaw(m.a); m.cb = store.toRaw(m.b);
      m.label = `${fmt(m.d3, 3)} m`;
      m.via = m.kind === 'pano' || kind === 'pano' ? 'panoramique' : '3D';
      viewer.syncMeasures();
      render();
      app.setBanner('Mesure : cliquez le 1er point (Échap pour terminer)');
    }
  }

  function start() {
    app.cancelTools();
    if (!store.clouds.length) { toast('Importez un nuage de points (ou lancez la démonstration) avant de mesurer.', 'warn'); return; }
    active = true;
    btn.textContent = 'Mesure en cours… (Échap pour terminer)';
    viewer.setPicker(onPick);
    app.setBanner('Mesure : cliquez le 1er point');
    app.showTab('measure');
  }

  function stop() {
    if (pending) { store.measures = store.measures.filter((m) => m !== pending); pending = null; viewer.syncMeasures(); }
    active = false;
    btn.textContent = 'Mesurer deux points';
  }

  function render() {
    const box = $('#measure-list');
    const done = store.measures.filter((m) => m.b);
    if (!done.length) { box.innerHTML = '<p class="empty">Aucune mesure.</p>'; return; }
    box.innerHTML = done.map((m, i) => `<div class="card measure-card" data-id="${m.id}">
      <div class="t"><span class="grow">Mesure ${i + 1} <small>(${m.via})</small></span>
        <button class="icon-btn ${m.visible ? 'on' : ''}" data-act="vis" title="Afficher / masquer">${m.visible ? '👁' : '⊘'}</button>
        <button class="icon-btn" data-act="del" title="Supprimer">✕</button></div>
      <div class="big">${fmt(m.d3, 3)} m</div>
      <div class="meta">Horizontale <b>${fmt(m.dh, 3)}</b> m · ΔX <b>${fmt(m.dx, 3)}</b> · ΔY <b>${fmt(m.dy, 3)}</b> · ΔZ <b>${fmt(m.dz, 3)}</b></div>
      <details><summary>Coordonnées des deux points</summary><table>
        <tr><td>A</td><td>X ${fmt(m.ca[0], 3)}<br>Y ${fmt(m.ca[1], 3)}<br>Z ${fmt(m.ca[2], 3)}</td></tr>
        <tr><td>B</td><td>X ${fmt(m.cb[0], 3)}<br>Y ${fmt(m.cb[1], 3)}<br>Z ${fmt(m.cb[2], 3)}</td></tr></table></details></div>`).join('');
  }

  $('#measure-list').addEventListener('click', (e) => {
    const card = e.target.closest('.card');
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!card || !act) return;
    const m = store.measures.find((x) => x.id === card.dataset.id);
    if (act === 'vis') { m.visible = !m.visible; viewer.syncMeasures(); render(); }
    else if (act === 'del') { store.measures = store.measures.filter((x) => x !== m); viewer.syncMeasures(); render(); }
  });
  btn.addEventListener('click', () => (active ? app.cancelTools() : start()));
  $('#btn-measure-clear').addEventListener('click', () => { store.measures = []; pending = null; viewer.syncMeasures(); render(); });
  $('#btn-measure-csv').addEventListener('click', async () => {
    const done = store.measures.filter((m) => m.b);
    if (!done.length) { toast('Aucune mesure à copier.', 'warn'); return; }
    const f = (v) => v.toFixed(3).replace('.', ',');
    const csv = ['n;A_X;A_Y;A_Z;B_X;B_Y;B_Z;dX;dY;dZ;distance_3D;distance_horizontale',
      ...done.map((m, i) => [i + 1, ...m.ca.map(f), ...m.cb.map(f), f(m.dx), f(m.dy), f(m.dz), f(m.d3), f(m.dh)].join(';'))].join('\n');
    try { await navigator.clipboard.writeText(csv); toast('Mesures copiées (séparateur « ; », prêtes à coller dans Excel).', 'ok'); }
    catch { window.prompt('Copiez le texte ci-dessous :', csv); }
  });
  viewer.on('pick-miss', () => { if (active) toast('Aucun point du nuage ici : visez une zone couverte de points.', 'warn', 3500); });

  return { toggle: () => (active ? app.cancelTools() : start()), stop, render, get active() { return active; }, esc };
}
