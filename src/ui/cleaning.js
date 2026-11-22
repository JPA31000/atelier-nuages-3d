// Nettoyage : valeurs aberrantes (statistique / rayon), découpe par boîte, sous-échantillonnage par voxels.
// Chaque opération s'exécute dans un Web Worker sur une COPIE ; l'état précédent est gardé pour « Annuler ».

import { geo } from '../core/workers.js';
import { $, esc, fmt, fmtInt, toast } from './dom.js';

export function initCleaning(app) {
  const { store, viewer } = app;
  const sel = $('#clean-target');
  const ids = ['xmin', 'ymin', 'zmin', 'xmax', 'ymax', 'zmax'];
  const field = (k) => $(`#clip-${k}`);

  function fillSelect() {
    const keep = sel.value;
    sel.innerHTML = `<option value="all">Tous les nuages visibles</option>` + store.clouds.map((c) => `<option value="${c.id}">${esc(c.name)} (${fmtInt(c.count)})</option>`).join('');
    sel.value = [...sel.options].some((o) => o.value === keep) ? keep : (app.selectedCloud()?.id ?? 'all');
  }
  app.onCloudsChanged(fillSelect);

  const targets = () => (sel.value === 'all' ? store.clouds.filter((c) => c.visible) : [store.cloud(sel.value)].filter(Boolean));

  async function run(kind, params, label) {
    const list = targets();
    if (!list.length) return toast('Aucun nuage à traiter.', 'warn');
    let removed = 0, before = 0;
    const notes = [];
    try {
      for (const c of list) {
        const payload = { kind, params, matrix: Array.from(c.matrix.elements), cloud: { positions: c.positions, colors: c.colors, intensity: c.intensity, count: c.count } };
        const r = await app.busy(`${label} — ${c.name}`, geo, (p) => geo.run({ op: 'filter', payload }, [], p));
        before += c.count;
        c.undo = { positions: c.positions, colors: c.colors, intensity: c.intensity, count: c.count, boundsLocal: c.boundsLocal };
        c.positions = r.cloud.positions; c.colors = r.cloud.colors; c.intensity = r.cloud.intensity; c.count = r.cloud.count;
        c.recomputeBounds();
        viewer.refreshGeometry(c);
        removed += r.removed;
        if (r.info) notes.push(`${c.name} : ${r.info}`);
      }
      app._cloudsChanged();
      $('#clean-info').textContent = `${label} : ${fmtInt(removed)} point(s) retiré(s) sur ${fmtInt(before)}. ${notes.join(' · ')}`;
      toast(`${label} : ${fmtInt(removed)} point(s) retiré(s).`, 'ok', 6000);
    } catch (e) {
      if (!/annul/i.test(e.message)) toast(`${label} : ${e.message}`, 'err', 9000);
    }
  }

  $('#btn-sor').addEventListener('click', () => run('sor', { k: +$('#sor-k').value || 12, stdRatio: +$('#sor-std').value || 2 }, 'Filtre statistique'));
  $('#btn-ror').addEventListener('click', () => run('ror', { radius: +$('#ror-r').value || 0.1, minNeighbors: +$('#ror-n').value || 5 }, 'Filtre par rayon'));
  $('#btn-voxel').addEventListener('click', () => run('voxel', { size: (+$('#vox-size').value || 5) / 100, mode: $('#vox-mode').value }, 'Voxels'));

  // ---------------------------------------------------------------- boîte de découpe (coordonnées brutes)
  const origin = () => store.origin;
  function readBox() {
    const v = ids.map((k) => parseFloat(field(k).value));
    return v.every(Number.isFinite) ? v : null;
  }
  function preview() {
    const v = readBox();
    const o = origin();
    if (!v || !$('#tab-clean').classList.contains('active')) { viewer.showBox(null); return; }
    viewer.showBox([v[0] - o[0], v[1] - o[1], v[2] - o[2]], [v[3] - o[0], v[4] - o[1], v[5] - o[2]]);
  }
  function fillFromExtent() {
    const list = targets();
    if (!list.length) return;
    const box = store.sceneBounds(false);
    list.forEach((c) => box.union(c.boundsScene()));
    const o = origin();
    const vals = [box.min.x + o[0], box.min.y + o[1], box.min.z + o[2], box.max.x + o[0], box.max.y + o[1], box.max.z + o[2]];
    ids.forEach((k, i) => { field(k).value = vals[i].toFixed(3); });
    preview();
  }
  ids.forEach((k) => field(k).addEventListener('input', preview));
  $('#btn-clip-fill').addEventListener('click', fillFromExtent);
  $('#btn-clip-shrink').addEventListener('click', () => {
    const v = readBox();
    if (!v) return fillFromExtent();
    ['x', 'y', 'z'].forEach((a, i) => {
      const d = (v[i + 3] - v[i]) * 0.05;
      field(`${a}min`).value = (v[i] + d).toFixed(3);
      field(`${a}max`).value = (v[i + 3] - d).toFixed(3);
    });
    preview();
  });
  $('#btn-clip').addEventListener('click', () => {
    const v = readBox();
    if (!v) return toast('Renseignez la boîte (bouton « Étendue du nuage » pour commencer).', 'warn');
    const o = origin();
    run('clip', { min: [v[0] - o[0], v[1] - o[1], v[2] - o[2]], max: [v[3] - o[0], v[4] - o[1], v[5] - o[2]], keep: $('input[name="clipm"]:checked').value }, 'Découpe');
  });

  $('#btn-clean-undo').addEventListener('click', () => {
    let n = 0;
    for (const c of targets()) {
      if (!c.undo) continue;
      Object.assign(c, c.undo);
      c.undo = null;
      viewer.refreshGeometry(c);
      n++;
    }
    if (n) { app._cloudsChanged(); toast('Dernière opération annulée.', 'ok'); $('#clean-info').textContent = ''; }
    else toast('Rien à annuler pour ce nuage.', 'warn');
  });

  return {
    onTab(name) { if (name === 'clean') { if (!readBox()) fillFromExtent(); preview(); } else viewer.showBox(null); },
    fmt,
  };
}
