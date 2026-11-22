// Consolidation (fusion) et exportation : LAS, LAZ, PLY, XYZ et paquet « .rcp ».

import * as THREE from 'three';
import { Cloud } from '../core/model.js';
import { geo } from '../core/workers.js';
import { $, fmtBytes, fmtInt, safeName, saveBlob, stamp, toast } from './dom.js';

export function initExport(app) {
  const { store, viewer } = app;

  const scope = () => {
    const sel = $('#exp-scope').value;
    if (sel === 'selected') return [app.selectedCloud()].filter(Boolean);
    return store.clouds.filter((c) => c.visible);
  };

  function summary() {
    const list = scope();
    const n = list.reduce((a, c) => a + c.count, 0);
    const fmtSel = $('#exp-format').value;
    ['las', 'ply', 'xyz'].forEach((k) => { $(`#exp-opt-${k}`).hidden = !((k === 'las' && (fmtSel === 'las' || fmtSel === 'laz' || fmtSel === 'rcp')) || (k === fmtSel)); });
    const color = list.some((c) => c.colors);
    const bytes = { las: n * (color ? 26 : 20), laz: n * (color ? 26 : 20) * 0.35, ply: n * (24 + (color ? 3 : 0) + (list.some((c) => c.intensity) ? 4 : 0)), xyz: n * 40, rcp: n * (color ? 26 : 20) }[fmtSel] || 0;
    $('#exp-summary').textContent = n ? `${fmtInt(n)} points de ${list.length} nuage(s) · taille estimée ≈ ${fmtBytes(bytes)}` : 'Aucun point à exporter (rien de visible ou de sélectionné).';
  }
  app.onCloudsChanged(summary);
  $('#exp-format').addEventListener('change', summary);
  $('#exp-scope').addEventListener('change', summary);

  // ---------------------------------------------------------------- fusion
  $('#btn-merge').addEventListener('click', () => {
    const list = store.clouds.filter((c) => c.visible);
    if (list.length < 2) return toast('Il faut au moins deux nuages visibles à fusionner.', 'warn');
    const total = list.reduce((a, c) => a + c.count, 0);
    const box = new THREE.Box3();
    list.forEach((c) => box.union(c.boundsScene()));
    const ctr = box.getCenter(new THREE.Vector3());
    const hasColor = list.some((c) => c.colors), hasInt = list.some((c) => c.intensity);
    const pos = new Float32Array(total * 3);
    const col = hasColor ? new Uint8Array(total * 3).fill(200) : null;
    const inten = hasInt ? new Float32Array(total) : null;
    let o = 0;
    for (const c of list) {
      const m = c.matrix.elements, p = c.positions;
      for (let i = 0; i < c.count; i++, o++) {
        const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
        pos[o * 3] = m[0] * x + m[4] * y + m[8] * z + m[12] - ctr.x;
        pos[o * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13] - ctr.y;
        pos[o * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14] - ctr.z;
        if (c.colors) { col[o * 3] = c.colors[i * 3]; col[o * 3 + 1] = c.colors[i * 3 + 1]; col[o * 3 + 2] = c.colors[i * 3 + 2]; }
        if (c.intensity) inten[o] = c.intensity[i];
      }
    }
    // mélange pour que tout préfixe reste un échantillon uniforme (affichage progressif, ICP)
    let s = 1234567;
    const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
    for (let i = total - 1; i > 0; i--) {
      const j = (rnd() * (i + 1)) | 0;
      if (j === i) continue;
      for (let k = 0; k < 3; k++) { const t = pos[i * 3 + k]; pos[i * 3 + k] = pos[j * 3 + k]; pos[j * 3 + k] = t; if (col) { const u = col[i * 3 + k]; col[i * 3 + k] = col[j * 3 + k]; col[j * 3 + k] = u; } }
      if (inten) { const t = inten[i]; inten[i] = inten[j]; inten[j] = t; }
    }
    const origin = store.origin;
    const merged = new Cloud({
      name: `Fusion (${list.length} nuages)`, fileName: 'fusion', format: 'FUSION', count: total, positions: pos, colors: col, intensity: inten,
      offset: [origin[0] + ctr.x, origin[1] + ctr.y, origin[2] + ctr.z], boundsLocal: [0, 0, 0, 0, 0, 0],
    });
    merged.recomputeBounds();
    if ($('#merge-hide').checked) list.forEach((c) => { c.visible = false; });
    store.addCloud(merged);
    app.selectedCloudId = merged.id;
    viewer.matricesChanged();
    app._cloudsChanged();
    toast(`Nuage final créé : ${fmtInt(total)} points.`, 'ok', 6000);
  });

  // ---------------------------------------------------------------- export
  $('#btn-export').addEventListener('click', async () => {
    const list = scope();
    if (!list.length) return toast('Rien à exporter : affichez au moins un nuage.', 'warn');
    const format = $('#exp-format').value;
    const name = safeName($('#exp-name').value || 'nuage');
    const options = {};
    if (['las', 'laz', 'rcp'].includes(format)) options.scale = parseFloat($('#exp-scale').value);
    if (format === 'ply') options.ascii = $('#exp-ascii').checked;
    if (format === 'xyz') options.decimals = Math.max(0, Math.min(8, parseInt($('#exp-decimals').value, 10) || 3));
    const clouds = list.map((c) => ({ name: c.name, positions: c.positions, colors: c.colors, intensity: c.intensity, count: c.count, matrix: Array.from(c.matrix.elements) }));
    let rcp;
    if (format === 'rcp') {
      const stations = store.stations.map((s) => {
        const p = store.pano(s.panoId);
        const w = store.stationWorldQuaternion(s);
        return { name: s.name, position: store.toRaw(store.stationWorld(s)), quaternion: [w.x, w.y, w.z, w.w], panoName: p ? p.fileName || `${safeName(p.name)}.${p.mime === 'image/png' ? 'png' : 'jpg'}` : null };
      });
      const panoramas = store.panos.map((p) => ({ fileName: p.fileName || `${safeName(p.name)}.${p.mime === 'image/png' ? 'png' : 'jpg'}`, bytes: p.bytes }));
      rcp = { projectName: $('#exp-name').value || 'Projet', stations, panoramas };
    }
    try {
      const r = await app.busy(`Export ${format.toUpperCase()}`, geo, (p) => geo.run({ op: 'export', payload: { format, clouds, sceneOrigin: store.origin, options, rcp } }, [], p));
      const file = r.fileName ?? `${name}-${stamp()}.${format}`;
      saveBlob(r.blob, file);
      toast(`« ${file} » enregistré (${fmtBytes(r.blob.size)}).`, 'ok', 7000);
    } catch (e) {
      if (!/annul/i.test(e.message)) toast(`Export impossible : ${e.message}`, 'err', 9000);
    }
  });

  summary();
  return { summary };
}
