// Application : assemble le modèle, le visualiseur, les workers et les panneaux.

import * as THREE from 'three';
import { Store, Cloud, Station, Panorama } from './core/model.js';
import { Viewer } from './viewer/viewer.js';
import { importer, geo } from './core/workers.js';
import { detectFormat } from './io/detect.js';
import { $, $$, esc, fmt, fmtInt, toast, progress, saveBlob, stamp } from './ui/dom.js';
import { initMeasure } from './ui/measure.js';
import { initRegistration } from './ui/registration.js';
import { initCleaning } from './ui/cleaning.js';
import { initExport } from './ui/exporter.js';

const DEG = Math.PI / 180;

export class App {
  constructor() {
    this.store = new Store();
    this.viewer = new Viewer(this.store, {
      canvas: $('#gl'), views: $('#views'), slot3d: $('#slot3d'), slotPano: $('#slotPano'),
      labels3d: $('#labels3d'), labelsPano: $('#labelsPano'), tooltip: $('#tooltip'),
    });
    this.selectedCloudId = null;
    this.cloudListeners = [];
    this.fileCards = [];
    this.pendingStationFor = null;

    this._bindShell();
    this._bindImport();
    this._bindLists();
    this._bindDisplay();
    this._bindStationBar();
    this.store.on('clouds', () => { this.viewer.syncClouds(); this._cloudsChanged(); });
    this.store.on('stations', () => { this.viewer.syncStations(); this.renderStations(); this.renderPanos(); });
    this.store.on('panos', () => { this.renderPanos(); this.renderStations(); this.viewer.syncStations(); });

    this.measure = initMeasure(this);
    this.registration = initRegistration(this);
    this.cleaning = initCleaning(this);
    this.exporter = initExport(this);
    this._cloudsChanged();
    this.renderAll();
  }

  // ------------------------------------------------------------------ utilitaires partagés

  selectedCloud() {
    return this.store.cloud(this.selectedCloudId) ?? this.store.clouds[0] ?? null;
  }

  onCloudsChanged(fn) { this.cloudListeners.push(fn); }

  _cloudsChanged() {
    if (!this.store.cloud(this.selectedCloudId)) this.selectedCloudId = this.store.clouds[0]?.id ?? null;
    this.renderClouds();
    $('#empty-hint').classList.toggle('gone', this.store.clouds.length > 0 || this.store.stations.length > 0);
    this.updateOriginInfo();
    this.cloudListeners.forEach((fn) => fn());
  }

  /** Exécute une tâche longue avec barre de progression et annulation. */
  async busy(label, worker, task) {
    progress.show(label, worker ? () => worker.cancel() : null);
    try {
      return await task((f, l) => progress.update(f, l ? `${label} — ${l}` : label));
    } finally {
      progress.hide();
    }
  }

  setBanner(text) {
    const b = $('#picker-banner');
    b.hidden = !text;
    b.textContent = text || '';
  }

  updateOriginInfo() {
    const o = this.store.sceneOrigin;
    $('#origin-info').innerHTML = o
      ? `Origine de la scène (coordonnées brutes) :<br><code>X ${fmt(o[0], 3)}  Y ${fmt(o[1], 3)}  Z ${fmt(o[2], 3)}</code><br>Les points sont stockés relativement à leur barycentre (Float32) ; l'origine exacte (Float64) est restituée à l'export.`
      : 'Origine de la scène : —';
  }

  // ------------------------------------------------------------------ coque (onglets, aide…)

  _bindShell() {
    $$('.rail-btn').forEach((b) => b.addEventListener('click', () => this.showTab(b.dataset.tab)));
    $('#btn-help').addEventListener('click', () => $('#help-dialog').showModal());
    $('#btn-capture').addEventListener('click', () => {
      const url = this.viewer.snapshot();
      fetch(url).then((r) => r.blob()).then((b) => saveBlob(b, `capture-${stamp()}.png`));
    });
    $('#btn-demo').addEventListener('click', () => this.loadDemo());
    $('#progress-cancel').addEventListener('click', () => {
      importer.cancel(); geo.cancel(); progress.hide();
      toast('Opération annulée.', 'warn');
    });
    window.addEventListener('keydown', (e) => {
      if (e.target.closest('input, select, textarea') || e.ctrlKey || e.metaKey) return;
      const k = e.key.toLowerCase();
      if (k === 'escape') { this.cancelTools(); if (this.viewer.stationId && !this.viewer.picker) this.viewer.leaveStation(); }
      else if (k === 'm') this.measure.toggle();
      else if (k === 'f') this.viewer.fitView();
      else if (k === 'g') { const c = $('#show-grid'); c.checked = !c.checked; this.viewer.setGridVisible(c.checked); }
      else if (['1', '2', '3'].includes(k) && this.viewer.stationId) this.viewer.setLayout(['3d', 'split', 'pano'][+k - 1]);
    });
  }

  showTab(name) {
    $$('.rail-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    $$('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${name}`));
    this.cleaning?.onTab(name);
  }

  cancelTools() {
    this.measure.stop();
    this.registration.stopPicking();
    this.viewer.setPicker(null);
    this.setBanner('');
    this.pendingStationFor = null;
  }

  // ------------------------------------------------------------------ import

  _bindImport() {
    const input = $('#file-input');
    const open = () => input.click();
    $('#btn-import').addEventListener('click', open);
    $('#dropzone').addEventListener('click', open);
    $('#dropzone').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    input.addEventListener('change', () => { if (input.files.length) this.importFiles([...input.files]); input.value = ''; });
    let depth = 0;
    const over = $('#drop-overlay');
    window.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types?.includes('Files')) { depth++; over.hidden = false; } });
    window.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; over.hidden = true; } });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      e.preventDefault(); depth = 0; over.hidden = true;
      if (e.dataTransfer?.files?.length) this.importFiles([...e.dataTransfer.files]);
    });
  }

  async importFiles(files) {
    const budget = +$('#import-budget').value;
    const first = !this.store.clouds.length;
    const data = [], images = [];
    for (const f of files) {
      const det = await detectFormat(f);
      if (det.kind === 'image') images.push(f);
      else if (det.kind === 'unknown') toast(`« ${f.name} » : format non reconnu (LAS, LAZ, E57, PLY, XYZ/PTS, JPG/PNG).`, 'warn', 7000);
      else data.push(f);
    }
    let ok = 0;
    for (const f of data) {
      try {
        const res = await this.busy(`Lecture de ${f.name}`, importer, (p) => importer.run({ file: f, opts: { budget } }, [], p));
        await this.addImportResult(f, res);
        ok++;
      } catch (e) {
        console.error(e);
        toast(`${f.name} : ${e.message}`, 'err', 9000);
      }
    }
    for (const f of images) {
      try { await this.addPanoramaFile(f); ok++; } catch (e) { toast(`${f.name} : ${e.message}`, 'err', 8000); }
    }
    if (images.length) this.autoAssociate();
    this.viewer.syncClouds();
    if (first && this.store.clouds.length) this.viewer.fitView();
    if (ok) toast(`${ok} fichier(s) importé(s).`, 'ok');
  }

  async addImportResult(file, res) {
    const clouds = [];
    for (const d of res.clouds) {
      const cloud = new Cloud({
        name: res.clouds.length > 1 || !d.name ? d.name || file.name : d.name,
        fileName: file.name, format: res.format, structure: res.structure, meta: d.meta,
        count: d.count, positions: d.positions, colors: d.colors, intensity: d.intensity,
        offset: d.offset, boundsLocal: d.boundsLocal, seen: d.seen,
      });
      this.store.addCloud(cloud);
      clouds.push(cloud);
      if (d.station) {
        this.store.addStation(new Station({
          name: d.station.name, cloudId: cloud.id,
          local: d.station.position.map((v, i) => v - d.offset[i]), quaternion: d.station.quaternion,
        }));
      }
    }
    for (const im of res.images) {
      const pano = await this.makePano(im.name, im.bytes, im.mime);
      this.store.addPano(pano);
      const cloud = im.stationIndex != null ? clouds[im.stationIndex] : null;
      const st = cloud ? this.store.stations.find((s) => s.cloudId === cloud.id) : null;
      if (st) {
        this.store.linkPano(pano.id, st.id);
        // si l'image a sa propre orientation, on en déduit le décalage de cap par rapport au scan
        const rel = st.quaternion.clone().invert().multiply(new THREE.Quaternion(...im.quaternion));
        if (Math.abs(rel.x) < 0.03 && Math.abs(rel.y) < 0.03) pano.yawDeg = Math.round(2 * Math.atan2(rel.z, rel.w) / DEG * 100) / 100;
      }
    }
    this._logFile(file, res, clouds);
  }

  _logFile(file, res, clouds) {
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (const c of clouds) {
      for (let k = 0; k < 3; k++) {
        mn[k] = Math.min(mn[k], c.boundsLocal[k] + c.offset[k]);
        mx[k] = Math.max(mx[k], c.boundsLocal[k + 3] + c.offset[k]);
      }
    }
    this.fileCards.unshift({
      name: file.name, size: file.size, format: res.format, structure: res.structure, info: res.info,
      warnings: res.warnings || [], clouds: clouds.length, stations: res.clouds.filter((c) => c.station).length,
      images: res.images.length, kept: clouds.reduce((a, c) => a + c.count, 0), seen: clouds.reduce((a, c) => a + (c.seen || c.count), 0),
      color: clouds.some((c) => c.colors), intensity: clouds.some((c) => c.intensity), min: mn, max: mx,
    });
    this.renderFiles();
  }

  async makePano(name, bytes, mime) {
    let bmp = await createImageBitmap(new Blob([bytes], { type: mime }));
    const max = Math.min(this.viewer.maxTexture, 8192);
    if (bmp.width > max) {
      const h = Math.round((bmp.height * max) / bmp.width);
      const small = await createImageBitmap(bmp, { resizeWidth: max, resizeHeight: h, resizeQuality: 'high' });
      bmp.close(); bmp = small;
      toast(`Panoramique « ${name} » réduit à ${max} px de large pour votre carte graphique.`, 'warn');
    }
    const ratio = bmp.width / bmp.height;
    if (Math.abs(ratio - 2) > 0.08) toast(`« ${name} » : rapport ${ratio.toFixed(2)}:1 — un panoramique équirectangulaire complet est 2:1.`, 'warn', 7000);
    return new Panorama({ name, bitmap: bmp, bytes, mime });
  }

  async addPanoramaFile(f) {
    const bytes = new Uint8Array(await f.arrayBuffer());
    const mime = f.type || (/\.png$/i.test(f.name) ? 'image/png' : 'image/jpeg');
    const pano = await this.makePano(f.name.replace(/\.[^.]+$/, ''), bytes, mime);
    pano.fileName = f.name;
    this.store.addPano(pano);
    return pano;
  }

  /** Associe automatiquement les panoramiques libres aux stations libres (nom, puis numéro, puis unique restant). */
  autoAssociate() {
    const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
    const num = (s) => { const m = String(s).match(/(\d+)(?!.*\d)/); return m ? parseInt(m[1], 10) : null; };
    let done = 0;
    for (const p of this.store.panos.filter((x) => !x.stationId)) {
      const free = this.store.stations.filter((s) => !s.panoId);
      let st = free.find((s) => norm(p.name).includes(norm(s.name)) || norm(s.name).includes(norm(p.name)));
      if (!st) { const n = num(p.name); if (n !== null) st = free.find((s) => num(s.name) === n); }
      if (!st && free.length === 1 && this.store.panos.filter((x) => !x.stationId).length === 1) st = free[0];
      if (st) { this.store.linkPano(p.id, st.id); done++; }
    }
    if (done) toast(`${done} panoramique(s) associé(s) automatiquement à une station.`, 'ok');
    else if (this.store.panos.some((p) => !p.stationId)) toast('Panoramique non associé : choisissez sa station dans la carte du panoramique (onglet Scène).', 'warn', 7000);
  }

  // ------------------------------------------------------------------ démonstration

  async loadDemo() {
    try {
      const first = !this.store.clouds.length;
      const d = await this.busy('Génération de la salle de démonstration', geo, (p) => geo.run({ op: 'demo', payload: {} }, [], p));
      const clouds = [];
      for (const c of d.clouds) {
        const cloud = new Cloud({ name: c.name, fileName: 'démonstration', format: 'DEMO', structure: { type: 'structuré', reasons: ['2 stations', 'poses de stations', '2 panoramiques 360°'] }, meta: c.meta, count: c.count, positions: c.positions, colors: c.colors, intensity: c.intensity, offset: c.offset, boundsLocal: c.boundsLocal, seen: c.seen });
        this.store.addCloud(cloud);
        clouds.push(cloud);
        this.store.addStation(new Station({ name: c.station.name, cloudId: cloud.id, local: c.station.position.map((v, i) => v - c.offset[i]), quaternion: c.station.quaternion }));
      }
      for (const im of d.images) {
        const cv = new OffscreenCanvas(im.width, im.height);
        cv.getContext('2d').putImageData(new ImageData(im.rgba, im.width, im.height), 0, 0);
        const blob = await cv.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const pano = await this.makePano(im.name, bytes, 'image/jpeg');
        pano.fileName = `${im.name.replace(/[^\w-]+/g, '_')}.jpg`;
        this.store.addPano(pano);
        const st = this.store.stations.find((s) => s.cloudId === clouds[im.stationIndex].id);
        this.store.linkPano(pano.id, st.id);
      }
      this._logFile({ name: 'Jeu de démonstration (salle 9 × 6 × 3 m)', size: 0 }, { format: 'DEMO', structure: { type: 'structuré', reasons: ['2 stations', 'poses', '2 panoramiques'] }, info: { origine: 'Lambert-93 fictif', consigne: 'recalez la station 2 sur la station 1 (défaut ≈ 14 cm, 2,5°)' }, warnings: [], clouds: d.clouds, images: d.images }, clouds);
      this.viewer.syncClouds();
      if (first) this.viewer.fitView();
      toast('Démonstration prête : cliquez une icône 360 pour voir le panoramique, mesurez la hauteur sous plafond (3 m), puis recalez la station 2.', 'ok', 9000);
    } catch (e) { console.error(e); toast(`Démonstration impossible : ${e.message}`, 'err', 8000); }
  }

  // ------------------------------------------------------------------ listes (Scène)

  renderAll() { this.renderFiles(); this.renderClouds(); this.renderStations(); this.renderPanos(); }

  renderFiles() {
    const box = $('#files-list');
    if (!this.fileCards.length) { box.innerHTML = '<p class="empty">Aucun fichier pour l\'instant.</p>'; return; }
    box.innerHTML = this.fileCards.map((f) => {
      const struct = f.structure ? `<span class="badge ${f.structure.type === 'structuré' ? 'good' : ''}">${esc(f.format)} ${esc(f.structure.type)}</span>` : `<span class="badge">${esc(f.format)}</span>`;
      const reasons = f.structure?.reasons?.length ? `<div class="meta">Pourquoi : ${esc(f.structure.reasons.join(', '))}</div>` : '';
      const sampled = f.seen > f.kept * 1.02 ? ` <span class="badge warn">échantillonné ${Math.round((f.kept / f.seen) * 100)} %</span>` : '';
      const info = Object.entries(f.info || {}).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('');
      return `<div class="card"><div class="t"><span class="grow" title="${esc(f.name)}">${esc(f.name)}</span>${struct}</div>${reasons}
        <div class="meta"><b>${fmtInt(f.kept)}</b> points affichés${f.seen ? ` sur ${fmtInt(f.seen)}` : ''}${sampled}<br>
        ${f.stations ? `<b>${f.stations}</b> station(s) · ` : ''}${f.images ? `<b>${f.images}</b> panoramique(s) · ` : ''}Couleur RVB : <b>${f.color ? 'oui' : 'non'}</b> · Intensité : <b>${f.intensity ? 'oui' : 'non'}</b></div>
        <details><summary>Étendue et métadonnées</summary><table>
          <tr><td>X</td><td>${fmt(f.min[0], 2)} → ${fmt(f.max[0], 2)} <small>(${fmt(f.max[0] - f.min[0], 2)} m)</small></td></tr>
          <tr><td>Y</td><td>${fmt(f.min[1], 2)} → ${fmt(f.max[1], 2)} <small>(${fmt(f.max[1] - f.min[1], 2)} m)</small></td></tr>
          <tr><td>Z</td><td>${fmt(f.min[2], 2)} → ${fmt(f.max[2], 2)} <small>(${fmt(f.max[2] - f.min[2], 2)} m)</small></td></tr>${info}</table></details>
        ${f.warnings.map((w) => `<div class="warn-line">⚠ ${esc(w)}</div>`).join('')}</div>`;
    }).join('');
  }

  renderClouds() {
    const box = $('#clouds-list');
    if (!this.store.clouds.length) { box.innerHTML = '<p class="empty">Aucun nuage.</p>'; return; }
    box.innerHTML = this.store.clouds.map((c) => `<div class="row ${c.id === this.selectedCloudId ? 'sel' : ''}" data-id="${c.id}">
        <button class="icon-btn ${c.visible ? 'on' : ''}" data-act="vis" title="Afficher / masquer">${c.visible ? '👁' : '⊘'}</button>
        <input type="color" value="${c.color}" data-act="color" title="Couleur « par nuage »" style="width:22px;height:22px;padding:0;border:0;background:none" />
        <span class="grow" data-act="sel" title="${esc(c.name)}">${esc(c.name)} <small>${fmtInt(c.count)} pts</small></span>
        <button class="icon-btn" data-act="zoom" title="Cadrer ce nuage">⌖</button>
        <button class="icon-btn" data-act="del" title="Supprimer">✕</button></div>`).join('');
  }

  renderStations() {
    const box = $('#stations-list');
    if (!this.store.stations.length) { box.innerHTML = '<p class="empty">Aucune station.</p>'; return; }
    box.innerHTML = this.store.stations.map((s) => {
      const w = this.store.toRaw(this.store.stationWorld(s));
      const pano = this.store.pano(s.panoId);
      return `<div class="row" data-id="${s.id}" style="flex-wrap:wrap">
        <span class="grow" data-act="open" title="Ouvrir la vue depuis cette station">📷 ${esc(s.name)} <small>${pano ? '· 360° ✓' : '· sans panoramique'}</small></span>
        <button class="icon-btn" data-act="open" title="Ouvrir">▶</button>
        <button class="icon-btn" data-act="del" title="Supprimer la station">✕</button>
        <details style="width:100%"><summary class="hint" style="cursor:pointer;margin:2px 0">Position (coordonnées brutes)</summary>
          <div class="grid3">${['x', 'y', 'z'].map((k, i) => `<label class="field"><span>${k.toUpperCase()}</span><input type="number" step="0.001" data-act="pos" data-axis="${i}" value="${w[i].toFixed(3)}" /></label>`).join('')}</div></details></div>`;
    }).join('');
  }

  renderPanos() {
    const box = $('#panos-list');
    if (!this.store.panos.length) { box.innerHTML = '<p class="empty">Aucun panoramique. Glissez des JPG/PNG équirectangulaires, ou importez un E57 qui en contient.</p>'; return; }
    box.innerHTML = this.store.panos.map((p) => `<div class="card pano-card" data-id="${p.id}">
        <canvas width="320" height="64"></canvas>
        <div class="t"><span class="grow" title="${esc(p.name)}">${esc(p.name)}</span><button class="icon-btn" data-act="del" title="Supprimer">✕</button></div>
        <div class="meta">${p.width} × ${p.height} px</div>
        <select data-act="link"><option value="">— station : non associée —</option>
          ${this.store.stations.map((s) => `<option value="${s.id}" ${p.stationId === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
          <option value="__new">➕ Nouvelle station (cliquer dans le nuage)…</option></select>
        <label class="field"><span>Rotation de l'image <b>${p.yawDeg.toFixed(1)}°</b></span><input type="range" min="-180" max="180" step="0.5" value="${p.yawDeg}" data-act="yaw" /></label>
        <label class="check"><input type="checkbox" data-act="flip" ${p.flip ? 'checked' : ''} /> Miroir gauche/droite</label></div>`).join('');
    $$('.pano-card', box).forEach((card) => {
      const p = this.store.pano(card.dataset.id);
      const cv = $('canvas', card);
      cv.getContext('2d').drawImage(p.bitmap, 0, 0, cv.width, cv.height);
    });
  }

  _bindLists() {
    $('#clouds-list').addEventListener('click', (e) => {
      const row = e.target.closest('.row');
      if (!row) return;
      const c = this.store.cloud(row.dataset.id);
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!c) return;
      if (act === 'vis') { c.visible = !c.visible; this.viewer.matricesChanged(); this.renderClouds(); this.viewer.invalidate(); }
      else if (act === 'del') { if (confirm(`Supprimer le nuage « ${c.name} » ?`)) this.store.removeCloud(c.id); }
      else if (act === 'zoom') this.zoomTo(c);
      else if (act === 'sel') { this.selectedCloudId = c.id; this.renderClouds(); this.cloudListeners.forEach((fn) => fn()); }
    });
    $('#clouds-list').addEventListener('input', (e) => {
      if (e.target.dataset.act !== 'color') return;
      const c = this.store.cloud(e.target.closest('.row').dataset.id);
      c.color = e.target.value;
      this.viewer.refreshCloudStyle(c);
    });
    $('#stations-list').addEventListener('click', (e) => {
      const row = e.target.closest('.row');
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!row || !act) return;
      if (act === 'open') this.viewer.showStation(row.dataset.id);
      else if (act === 'del') this.store.removeStation(row.dataset.id);
    });
    $('#stations-list').addEventListener('change', (e) => {
      if (e.target.dataset.act !== 'pos') return;
      const s = this.store.station(e.target.closest('.row').dataset.id);
      const raw = $$('input[data-act="pos"]', e.target.closest('.row')).map((i) => parseFloat(i.value));
      const o = this.store.origin;
      const v = new THREE.Vector3(raw[0] - o[0], raw[1] - o[1], raw[2] - o[2]);
      const c = this.store.cloud(s.cloudId);
      if (c) v.applyMatrix4(c.matrix.clone().invert());
      s.local.copy(v);
      this.viewer.updateStationPositions(); this.viewer.invalidate();
    });
    $('#btn-add-station').addEventListener('click', () => this.placeStation(null));
    const panos = $('#panos-list');
    panos.addEventListener('click', (e) => {
      if (e.target.closest('[data-act="del"]')) this.store.removePano(e.target.closest('.card').dataset.id);
    });
    panos.addEventListener('change', (e) => {
      const card = e.target.closest('.card');
      if (!card) return;
      const p = this.store.pano(card.dataset.id);
      const act = e.target.dataset.act;
      if (act === 'link') {
        if (e.target.value === '__new') { this.placeStation(p); this.renderPanos(); }
        else this.store.linkPano(p.id, e.target.value || null);
      } else if (act === 'flip') { p.flip = e.target.checked; this.viewer.invalidate(); }
    });
    panos.addEventListener('input', (e) => {
      if (e.target.dataset.act !== 'yaw') return;
      const p = this.store.pano(e.target.closest('.card').dataset.id);
      p.yawDeg = parseFloat(e.target.value);
      e.target.closest('.field').querySelector('b').textContent = `${p.yawDeg.toFixed(1)}°`;
      $('#sb-yaw').value = p.yawDeg; $('#sb-yaw-val').textContent = `${p.yawDeg.toFixed(1)}°`;
      this.viewer.invalidate();
    });
  }

  zoomTo(c) {
    const box = c.boundsScene();
    const ctr = box.getCenter(new THREE.Vector3());
    const r = Math.max(1, box.getSize(new THREE.Vector3()).length() / 2);
    if (this.viewer.stationId) this.viewer.leaveStation();
    this.viewer.controls.target.copy(ctr);
    this.viewer.cam3d.position.copy(ctr).add(new THREE.Vector3(0.9, -1.2, 0.75).normalize().multiplyScalar(r * 2.1));
    this.viewer.controls.update();
    this.viewer.invalidate();
  }

  /** Place une station : un clic dans le nuage (vue 3D) définit sa position. */
  placeStation(pano) {
    if (!this.store.clouds.length) {
      // pas de nuage : station à l'origine de la scène, éditable ensuite
      const st = this.store.addStation(new Station({ name: `Station ${this.store.stations.length + 1}`, local: [0, 0, 0] }));
      if (pano) this.store.linkPano(pano.id, st.id);
      this._cloudsChanged();
      toast('Station créée à l\'origine : modifiez sa position dans la liste des stations.', 'warn', 6000);
      return;
    }
    if (this.viewer.stationId) this.viewer.leaveStation();
    this.cancelTools();
    this.setBanner('Cliquez dans le nuage pour placer la station (Échap pour annuler)');
    this.viewer.setPicker((hit) => {
      const c = hit.cloud;
      const local = hit.point.clone().applyMatrix4(c.matrix.clone().invert());
      local.z += 0; // le point cliqué est la position de la station (à ajuster ensuite)
      const st = this.store.addStation(new Station({ name: pano ? pano.name : `Station ${this.store.stations.length + 1}`, cloudId: c.id, local: local.toArray() }));
      if (pano) this.store.linkPano(pano.id, st.id);
      this.viewer.setPicker(null);
      this.setBanner('');
      toast('Station placée. Ajustez la rotation de l\'image dans la barre de la station jusqu\'à ce que le nuage superposé coïncide.', 'ok', 8000);
      if (pano) this.viewer.showStation(st.id, 'split');
    });
  }

  // ------------------------------------------------------------------ affichage

  _bindDisplay() {
    const v = this.viewer;
    const updateLegend = () => {
      const mode = $('input[name="cmode"]:checked').value;
      $('#legend-z').hidden = mode !== 'elevation';
      const o = this.store.origin;
      $('#legend-zmin').textContent = `${fmt(v.sceneBox ? v.sceneBox.min.z + o[2] : 0, 1)} m`;
      $('#legend-zmax').textContent = `${fmt(v.sceneBox ? v.sceneBox.max.z + o[2] : 1, 1)} m`;
    };
    $$('input[name="cmode"]').forEach((r) => r.addEventListener('change', () => { v.setColorMode(r.value); updateLegend(); }));
    this.onCloudsChanged(updateLegend);
    const size = $('#point-size'), adapt = $('#size-adaptive');
    const applySize = () => {
      const a = adapt.checked;
      $('#size-val').textContent = a ? `${(+size.value).toFixed(1)} cm` : `${(+size.value).toFixed(1)} px`;
      v.setPointSize(+size.value, a);
    };
    size.addEventListener('input', applySize);
    adapt.addEventListener('change', () => {
      if (adapt.checked) { size.min = '0.5'; size.max = '10'; size.step = '0.5'; size.value = '2'; }
      else { size.min = '1'; size.max = '10'; size.step = '0.5'; size.value = '2.5'; }
      applySize();
    });
    $('#draw-budget').addEventListener('input', (e) => { $('#budget-val').textContent = `${(+e.target.value).toFixed(1)} M`; v.setBudget(+e.target.value * 1e6); });
    $('#bg-color').addEventListener('input', (e) => v.setBackground(e.target.value));
    $('#show-grid').addEventListener('change', (e) => v.setGridVisible(e.target.checked));
    $('#btn-fit').addEventListener('click', () => { if (v.stationId) v.leaveStation(); v.fitView(); });
    $$('[data-view]').forEach((b) => b.addEventListener('click', () => { if (v.stationId) v.leaveStation(); v.standardView(b.dataset.view); }));
    v.on('stats', (s) => {
      const total = this.store.clouds.reduce((a, c) => a + (c.visible ? c.count : 0), 0);
      $('#st-points').textContent = `${fmtInt(s.drawn)} / ${fmtInt(total)} points affichés`;
      $('#st-fps').textContent = `${s.fps} i/s`;
    });
  }

  // ------------------------------------------------------------------ barre de station

  _bindStationBar() {
    const v = this.viewer;
    const bar = $('#station-bar');
    const refresh = () => {
      const s = this.store.station(v.stationId);
      bar.hidden = !s;
      if (!s) return;
      const p = this.store.pano(s.panoId);
      $('#sb-name').textContent = `📷 ${s.name}`;
      $$('input[name="layout"]').forEach((r) => { r.checked = r.value === v.layout; r.disabled = !p && r.value !== '3d'; });
      $('#sb-sync').checked = v.sync;
      $('#sb-yaw').disabled = $('#sb-flip').disabled = $('#sb-overlay').disabled = $('#sb-opacity').disabled = !p;
      $('#sb-yaw').value = p?.yawDeg ?? 0; $('#sb-yaw-val').textContent = `${(p?.yawDeg ?? 0).toFixed(1)}°`;
      $('#sb-flip').checked = !!p?.flip;
    };
    v.on('station', refresh); v.on('layout', refresh); v.on('sync', refresh);
    this.store.on('panos', refresh);
    $$('input[name="layout"]').forEach((r) => r.addEventListener('change', () => v.setLayout(r.value)));
    $('#sb-sync').addEventListener('change', (e) => v.setSync(e.target.checked));
    const ov = () => v.setOverlay($('#sb-overlay').checked, +$('#sb-opacity').value);
    $('#sb-overlay').addEventListener('change', ov);
    $('#sb-opacity').addEventListener('input', ov);
    $('#sb-yaw').addEventListener('input', (e) => {
      const s = this.store.station(v.stationId); const p = s && this.store.pano(s.panoId);
      if (!p) return;
      p.yawDeg = parseFloat(e.target.value);
      $('#sb-yaw-val').textContent = `${p.yawDeg.toFixed(1)}°`;
      v.invalidate();
    });
    $('#sb-yaw').addEventListener('change', () => this.renderPanos());
    $('#sb-flip').addEventListener('change', (e) => {
      const s = this.store.station(v.stationId); const p = s && this.store.pano(s.panoId);
      if (p) { p.flip = e.target.checked; v.invalidate(); this.renderPanos(); }
    });
    $('#sb-exit').addEventListener('click', () => v.leaveStation());
    v.on('picker', (on) => { if (!on) this.setBanner(''); });
  }
}
