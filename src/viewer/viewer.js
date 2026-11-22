// Visualiseur : UNE scène Three.js (WebGL2) rendue dans deux vues par « scissor » sur un seul canvas :
//   - la vue 3D (OrbitControls) ;
//   - la vue panoramique 360° depuis une station (rotation libre, FOV réglable).
// Les deux vues partagent les mêmes nuages (un seul jeu de tampons GPU). Quand « synchroniser » est actif,
// la vue 3D se place AU POINT DE LA STATION et suit exactement la direction de visée du panoramique.
//
// Calques (layers) : 0 = nuages, 1 = sphère panoramique, 2 = marqueurs & mesures, 3 = grille / gizmo (3D seulement).

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { Emitter } from '../core/model.js';
import { shared, makePointMaterial, COLOR_MODES } from './pointMaterial.js';
import { pickScreen, pickRay } from './picking.js';

const DEG = Math.PI / 180;

const panoVertex = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const panoFragment = /* glsl */ `
uniform sampler2D uMap;
uniform mat3 uInv;
uniform float uFlip;
varying vec3 vDir;
void main() {
  vec3 d = normalize(uInv * vDir);
  float az = atan(d.y, d.x);
  float el = asin(clamp(d.z, -1.0, 1.0));
  float u = 0.5 - az / 6.28318530718;
  if (uFlip > 0.5) u = 1.0 - u;
  float v = 0.5 - el / 3.14159265359;
  gl_FragColor = texture2D(uMap, vec2(u, v));
}`;

function markerTexture(fill) {
  const c = document.createElement('canvas');
  c.width = c.height = 96;
  const g = c.getContext('2d');
  g.beginPath(); g.arc(48, 48, 40, 0, Math.PI * 2);
  g.fillStyle = fill; g.fill();
  g.lineWidth = 6; g.strokeStyle = '#fff'; g.stroke();
  g.fillStyle = '#fff'; g.font = 'bold 30px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('360', 48, 50);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class Viewer extends Emitter {
  constructor(store, { canvas, views, slot3d, slotPano, labels3d, labelsPano, tooltip }) {
    super();
    this.store = store;
    this.canvas = canvas;
    this.views = views;
    this.slot3d = slot3d;
    this.slotPano = slotPano;
    this.labels = { '3d': labels3d, pano: labelsPano };
    this.tooltip = tooltip;

    this.layout = '3d'; // '3d' | 'split' | 'pano'
    this.stationId = null;
    this.sync = true;
    this.overlay = false;
    this.overlayOpacity = 0.55;
    this.look = { yaw: 0, pitch: 0, fov: 70 };
    this.budget = 4e6;
    this.interacting = false;
    this.bg = new THREE.Color('#14181d');
    this.picker = null;
    this.dirty = true;
    this.objs = new Map();
    this.markers = new Map();
    this.measureObjs = new Map();
    this.measureLabels = new Map();
    this.savedOrbit = null;
    this.hoverStation = null;
    this.stats = { fps: 0, drawn: 0 };

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    shared.uPixelRatio.value = this.renderer.getPixelRatio();
    this.maxTexture = this.renderer.capabilities.maxTextureSize;

    this.scene = new THREE.Scene();
    this.root = new THREE.Group();
    this.scene.add(this.root);

    this.cam3d = new THREE.PerspectiveCamera(50, 1, 0.05, 5000);
    this.camPano = new THREE.PerspectiveCamera(70, 1, 0.05, 5000);
    for (const c of [this.cam3d, this.camPano]) c.up.set(0, 0, 1);
    this.cam3d.position.set(8, -10, 7);
    this.cam3d.layers.disableAll(); [0, 2, 3].forEach((l) => this.cam3d.layers.enable(l));

    this.controls = new OrbitControls(this.cam3d, this.slot3d);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.screenSpacePanning = true;
    this.controls.zoomToCursor = true;
    this.controls.addEventListener('start', () => { this.interacting = true; });
    this.controls.addEventListener('end', () => { this.interacting = false; this.invalidate(); });
    this.controls.addEventListener('change', () => this.invalidate());

    // grille et axes (3D uniquement)
    this.grid = new THREE.GridHelper(10, 10, 0x4c5a6a, 0x2c3540);
    this.grid.rotation.x = Math.PI / 2;
    this.axes = new THREE.AxesHelper(1);
    for (const o of [this.grid, this.axes]) { o.layers.set(3); this.scene.add(o); }

    // sphère panoramique
    this.panoMat = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: null }, uInv: { value: new THREE.Matrix3() }, uFlip: { value: 0 } },
      vertexShader: panoVertex, fragmentShader: panoFragment, side: THREE.BackSide, depthTest: false, depthWrite: false,
    });
    this.panoMesh = new THREE.Mesh(new THREE.SphereGeometry(10, 64, 40), this.panoMat);
    this.panoMesh.layers.set(1);
    this.panoMesh.renderOrder = -1000;
    this.panoMesh.frustumCulled = false;
    this.panoMesh.visible = false;
    this.scene.add(this.panoMesh);

    // marqueurs et mesures
    this.markGroup = new THREE.Group();
    this.scene.add(this.markGroup);
    this.texPano = markerTexture('#2f7bff');
    this.texNoPano = markerTexture('#8a95a3');

    // gizmo de transformation (recalage manuel)
    this.gizmo = new TransformControls(this.cam3d, this.slot3d);
    this.gizmoHelper = this.gizmo.getHelper();
    this.gizmoHelper.traverse((o) => o.layers.set(3));
    this.gizmo.getRaycaster().layers.enableAll(); // le gizmo est sur le calque 3 : son rayon de sélection doit le voir
    this.scene.add(this.gizmoHelper);
    this.gizmo.addEventListener('dragging-changed', (e) => { this.controls.enabled = !e.value && !this.fpvActive(); this.interacting = e.value; if (!e.value) this.invalidate(); });
    this.gizmo.addEventListener('objectChange', () => this._gizmoChanged());
    this.gizmo.addEventListener('mouseUp', () => {
      const g = this._gz;
      if (g && this.gizmoCloud) { g.base.copy(this.gizmoCloud.matrix); g.pivot.updateMatrix(); g.p0.copy(g.pivot.matrix); g.dirty = false; }
      this.emit('gizmo-end', this.gizmoCloud);
    });
    this.gizmoCloud = null;

    this._bindPointer(this.slot3d, '3d');
    this._bindPointer(this.slotPano, 'pano');
    new ResizeObserver(() => { this._resize(); this.invalidate(); }).observe(this.views);
    window.addEventListener('resize', () => this.invalidate());
    this._resize();

    this._tick = this._tick.bind(this);
    this._lastT = performance.now();
    this._frames = 0;
    requestAnimationFrame(this._tick);
  }

  // ---------------------------------------------------------------- état / rendu

  invalidate() { this.dirty = true; }

  _resize() {
    const r = this.views.getBoundingClientRect();
    this.renderer.setSize(Math.max(1, r.width), Math.max(1, r.height), false);
  }

  fpvActive() { return !!this.stationId && this.sync && this.layout !== 'pano'; }

  _tick(t) {
    requestAnimationFrame(this._tick);
    if (this.controls.enabled && this.controls.update()) this.dirty = true;
    if (this.dirty) {
      this.dirty = false;
      this._renderFrame();
      this._frames++;
    }
    if (t - this._lastT > 700) {
      this.stats.fps = Math.round((this._frames * 1000) / (t - this._lastT));
      this._frames = 0; this._lastT = t;
      this.emit('stats', this.stats);
    }
  }

  _updateDrawRanges() {
    let total = 0;
    for (const c of this.store.clouds) if (c.visible) total += c.count;
    const budget = this.interacting && total > 1.5e6 ? this.budget * 0.45 : this.budget;
    const frac = total > 0 ? Math.min(1, budget / total) : 1;
    let drawn = 0;
    for (const c of this.store.clouds) {
      const o = this.objs.get(c.id);
      if (!o) continue;
      o.pts.visible = c.visible;
      const n = Math.max(1, Math.ceil(c.count * frac));
      o.pts.geometry.setDrawRange(0, n);
      if (c.visible) drawn += n;
    }
    this.stats.drawn = drawn;
  }

  _lookCamera(cam, pos) {
    const { yaw, pitch, fov } = this.look;
    const cp = Math.cos(pitch);
    cam.position.copy(pos);
    cam.up.set(0, 0, 1);
    cam.lookAt(pos.x + cp * Math.cos(yaw), pos.y + cp * Math.sin(yaw), pos.z + Math.sin(pitch));
    cam.fov = fov;
  }

  _stationPos() {
    const s = this.store.station(this.stationId);
    return s ? this.store.stationWorld(s) : null;
  }

  _renderFrame() {
    const r = this.renderer;
    this._updateDrawRanges();
    this._updateOrientation();
    const cb = this.canvas.getBoundingClientRect();
    r.setScissorTest(true);
    r.setViewport(0, 0, cb.width, cb.height);
    r.setScissor(0, 0, cb.width, cb.height);
    r.setClearColor(0x0b0e12, 1);
    r.clear();
    this.scene.updateMatrixWorld(true);
    const spos = this.stationId ? this._stationPos() : null;
    const cur = this.stationId ? this.markers.get(this.stationId) : null;

    if (this.layout !== 'pano' && !this.slot3d.hidden) {
      if (this.fpvActive() && spos) { this._lookCamera(this.cam3d, spos); if (cur) cur.visible = false; }
      else if (cur) cur.visible = true;
      this._pass(this.slot3d, this.cam3d, '3d', cb);
      if (cur) cur.visible = true;
    }
    if (this.layout !== '3d' && this.stationId && spos && !this.slotPano.hidden) {
      this._lookCamera(this.camPano, spos);
      this.panoMesh.position.copy(spos);
      if (cur) cur.visible = false;
      this._pass(this.slotPano, this.camPano, 'pano', cb);
      if (cur) cur.visible = true;
    }
    this._updateLabels();
  }

  _pass(slot, cam, kind, cb) {
    const rc = slot.getBoundingClientRect();
    if (rc.width < 2 || rc.height < 2) return;
    const x = rc.left - cb.left, y = cb.bottom - rc.bottom;
    this.renderer.setViewport(x, y, rc.width, rc.height);
    this.renderer.setScissor(x, y, rc.width, rc.height);
    cam.aspect = rc.width / rc.height;
    this._clipPlanes(cam, kind);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    shared.uScale.value = rc.height / (2 * Math.tan((cam.fov * DEG) / 2));
    if (kind === 'pano') {
      cam.layers.disableAll(); cam.layers.enable(1); cam.layers.enable(2);
      if (this.overlay) cam.layers.enable(0);
      shared.uOpacity.value = this.overlay ? this.overlayOpacity : 1;
      this.renderer.setClearColor(0x10141a, 1);
    } else {
      shared.uOpacity.value = 1;
      this.renderer.setClearColor(this.bg, 1);
    }
    this.renderer.clear();
    this.renderer.render(this.scene, cam);
  }

  _clipPlanes(cam, kind) {
    const R = Math.max(1, this.sceneRadius || 10);
    if (kind === 'pano' || (cam === this.cam3d && this.fpvActive())) { cam.near = 0.05; cam.far = R * 6 + 50; return; }
    const d = cam.position.distanceTo(this.controls.target);
    cam.near = Math.max(0.01, Math.min(d * 0.01, R * 0.002));
    cam.far = d + R * 4 + 100;
  }

  _updateOrientation() {
    const s = this.stationId ? this.store.station(this.stationId) : null;
    const p = s ? this.store.pano(s.panoId) : null;
    if (!s || !p) { this.panoMesh.visible = false; return; }
    this.panoMesh.visible = true;
    const q = this.store.stationWorldQuaternion(s).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), p.yawDeg * DEG));
    const m4 = new THREE.Matrix4().makeRotationFromQuaternion(q);
    this.panoMat.uniforms.uInv.value.setFromMatrix4(m4).transpose();
    this.panoMat.uniforms.uFlip.value = p.flip ? 1 : 0;
    this.panoMat.uniforms.uMap.value = this._texture(p);
  }

  _texture(p) {
    if (!p.texture) {
      const t = new THREE.Texture(p.bitmap);
      t.flipY = false;
      t.colorSpace = THREE.NoColorSpace;
      t.generateMipmaps = false;
      t.minFilter = THREE.LinearFilter;
      t.magFilter = THREE.LinearFilter;
      t.needsUpdate = true;
      p.texture = t;
    }
    return p.texture;
  }

  // ---------------------------------------------------------------- nuages

  syncClouds() {
    const ids = new Set(this.store.clouds.map((c) => c.id));
    for (const [id, o] of this.objs) {
      if (!ids.has(id)) { this.root.remove(o.pts); o.pts.geometry.dispose(); o.mat.dispose(); this.objs.delete(id); }
    }
    for (const c of this.store.clouds) if (!this.objs.has(c.id)) this._addCloud(c);
    for (const c of this.store.clouds) this.refreshMatrix(c);
    this.updateBounds();
    this.syncStations();
    this.invalidate();
  }

  _addCloud(c) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(c.positions, 3));
    if (c.colors) g.setAttribute('aColor', new THREE.BufferAttribute(c.colors, 3, true));
    if (c.intensity) g.setAttribute('aIntensity', new THREE.BufferAttribute(c.intensity, 1));
    const mat = makePointMaterial(c);
    const pts = new THREE.Points(g, mat);
    pts.matrixAutoUpdate = false;
    pts.frustumCulled = false;
    pts.userData.cloudId = c.id;
    this.root.add(pts);
    this.objs.set(c.id, { pts, mat });
  }

  /** Reconstruit les tampons GPU d'un nuage dont les tableaux ont changé (filtre, annulation). */
  refreshGeometry(c) {
    const o = this.objs.get(c.id);
    if (!o) return;
    o.pts.geometry.dispose();
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(c.positions, 3));
    if (c.colors) g.setAttribute('aColor', new THREE.BufferAttribute(c.colors, 3, true));
    if (c.intensity) g.setAttribute('aIntensity', new THREE.BufferAttribute(c.intensity, 1));
    o.pts.geometry = g;
    this.updateBounds();
    this.invalidate();
  }

  refreshMatrix(c) {
    const o = this.objs.get(c.id);
    if (!o) return;
    o.pts.matrix.copy(c.matrix);
    o.pts.matrixWorldNeedsUpdate = true;
  }

  refreshCloudStyle(c) {
    const o = this.objs.get(c.id);
    if (!o) return;
    o.mat.uniforms.uCloudColor.value.set(c.color);
    this.invalidate();
  }

  matricesChanged(c = null) {
    if (c) this.refreshMatrix(c); else this.store.clouds.forEach((x) => this.refreshMatrix(x));
    this.updateBounds();
    this.updateStationPositions();
    this.syncMeasures();
    this.invalidate();
  }

  updateBounds() {
    const box = this.store.sceneBounds(true);
    if (box.isEmpty()) { this.sceneCenter = new THREE.Vector3(); this.sceneRadius = 10; this.sceneBox = null; return; }
    this.sceneBox = box;
    this.sceneCenter = box.getCenter(new THREE.Vector3());
    this.sceneRadius = Math.max(1, box.getSize(new THREE.Vector3()).length() / 2);
    shared.uZRange.value.set(box.min.z, box.max.z);
    const size = Math.max(10, Math.ceil(this.sceneRadius * 2 / 10) * 10);
    this.grid.scale.setScalar(size / 10);
    this.grid.position.set(this.sceneCenter.x, this.sceneCenter.y, box.min.z - 0.01);
    this.axes.position.set(box.min.x, box.min.y, box.min.z);
    this.axes.scale.setScalar(Math.max(1, this.sceneRadius * 0.15));
  }

  setGridVisible(v) { this.grid.visible = v; this.axes.visible = v; this.invalidate(); }

  fitView() {
    this.updateBounds();
    const c = this.sceneCenter, R = this.sceneRadius;
    if (this.fpvActive()) return;
    this.cam3d.position.copy(c).add(new THREE.Vector3(0.9, -1.2, 0.75).normalize().multiplyScalar(R * 2.1));
    this.controls.target.copy(c);
    this.controls.update();
    this.invalidate();
  }

  standardView(name) {
    this.updateBounds();
    const c = this.sceneCenter, d = this.sceneRadius * 2.2;
    const dirs = { top: [0, 0.0001, 1], front: [0, -1, 0.05], back: [0, 1, 0.05], left: [-1, 0, 0.05], right: [1, 0, 0.05], iso: [0.9, -1.2, 0.75] };
    const v = new THREE.Vector3(...(dirs[name] || dirs.iso)).normalize().multiplyScalar(d);
    this.cam3d.position.copy(c).add(v);
    this.controls.target.copy(c);
    this.controls.update();
    this.invalidate();
  }

  setColorMode(mode) { shared.uMode.value = COLOR_MODES[mode] ?? 0; this.invalidate(); }
  setPointSize(v, adaptive) { shared.uSize.value = adaptive ? v / 100 : v; shared.uAdaptive.value = adaptive ? 1 : 0; this.invalidate(); }
  setBackground(hex) { this.bg.set(hex); this.invalidate(); }
  setBudget(n) { this.budget = n; this.invalidate(); }

  snapshot() {
    this._renderFrame();
    return this.canvas.toDataURL('image/png');
  }

  // ---------------------------------------------------------------- stations

  syncStations() {
    const ids = new Set(this.store.stations.map((s) => s.id));
    for (const [id, sp] of this.markers) {
      if (!ids.has(id)) { this.markGroup.remove(sp); sp.material.dispose(); this.markers.delete(id); }
    }
    for (const s of this.store.stations) {
      let sp = this.markers.get(s.id);
      const map = s.panoId ? this.texPano : this.texNoPano;
      if (!sp) {
        sp = new THREE.Sprite(new THREE.SpriteMaterial({ map, sizeAttenuation: false, depthTest: false, transparent: true }));
        sp.scale.setScalar(0.045);
        sp.renderOrder = 900;
        sp.layers.set(2);
        sp.userData.stationId = s.id;
        this.markGroup.add(sp);
        this.markers.set(s.id, sp);
      }
      sp.material.map = map;
      sp.material.needsUpdate = true;
    }
    this.updateStationPositions();
    this.invalidate();
  }

  updateStationPositions() {
    for (const s of this.store.stations) {
      const sp = this.markers.get(s.id);
      if (sp) sp.position.copy(this.store.stationWorld(s));
    }
  }

  /** Entre dans la vue d'une station. */
  showStation(id, layout = null) {
    const s = this.store.station(id);
    if (!s) return;
    if (!this.stationId) this.savedOrbit = { pos: this.cam3d.position.clone(), target: this.controls.target.clone(), fov: this.cam3d.fov };
    // continuité : on reprend la direction de visée actuelle de la vue 3D
    if (!this.stationId) {
      const d = this.controls.target.clone().sub(this.cam3d.position).normalize();
      this.look.yaw = Math.atan2(d.y, d.x);
      this.look.pitch = Math.asin(THREE.MathUtils.clamp(d.z, -1, 1)) * 0.5;
    }
    this.stationId = id;
    const hasPano = !!this.store.pano(s.panoId);
    this.setLayout(layout || (hasPano ? (this.layout === '3d' ? 'split' : this.layout) : '3d'));
    this.syncStations();
    this.emit('station', id);
  }

  leaveStation() {
    if (!this.stationId) return;
    this.stationId = null;
    this.layout = '3d';
    this._applyLayout();
    if (this.savedOrbit) {
      this.cam3d.position.copy(this.savedOrbit.pos);
      this.controls.target.copy(this.savedOrbit.target);
      this.cam3d.fov = this.savedOrbit.fov;
      this.cam3d.updateProjectionMatrix();
    }
    this.controls.enabled = true;
    this.panoMesh.visible = false;
    this.emit('station', null);
    this.emit('layout', this.layout);
    this.invalidate();
  }

  setLayout(l) {
    if (!this.stationId && l !== '3d') return;
    this.layout = l;
    this._applyLayout();
    this.emit('layout', l);
    this.invalidate();
  }

  _applyLayout() {
    this.slot3d.hidden = this.layout === 'pano';
    this.slotPano.hidden = this.layout === '3d';
    this.views.dataset.layout = this.layout;
    this.controls.enabled = !this.fpvActive();
    requestAnimationFrame(() => { this._resize(); this.invalidate(); });
  }

  setSync(v) {
    if (v && this.layout !== 'pano' && this.stationId && !this.fpvActive()) {
      this.savedOrbit = { pos: this.cam3d.position.clone(), target: this.controls.target.clone(), fov: this.cam3d.fov };
    }
    const wasFpv = this.fpvActive();
    this.sync = v;
    if (wasFpv && !this.fpvActive() && this.savedOrbit) {
      this.cam3d.position.copy(this.savedOrbit.pos);
      this.controls.target.copy(this.savedOrbit.target);
      this.cam3d.fov = this.savedOrbit.fov;
      this.cam3d.updateProjectionMatrix();
    }
    this.controls.enabled = !this.fpvActive();
    this.emit('sync', v);
    this.invalidate();
  }

  setOverlay(on, opacity = this.overlayOpacity) { this.overlay = on; this.overlayOpacity = opacity; this.invalidate(); }

  // ---------------------------------------------------------------- interaction

  setPicker(fn, cursor = 'crosshair') {
    this.picker = fn;
    for (const s of [this.slot3d, this.slotPano]) s.style.cursor = fn ? cursor : '';
    this.emit('picker', !!fn);
  }

  _bindPointer(el, kind) {
    let down = null;
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.button !== 1 && e.button !== 2) return;
      down = { x: e.clientX, y: e.clientY, t: performance.now(), lx: e.clientX, ly: e.clientY, button: e.button, moved: false };
      this.hideTip();
    });
    el.addEventListener('pointermove', (e) => {
      const lookDrag = this._lookEnabled(kind);
      if (down && (e.buttons & 1) && lookDrag && !this.picker?.noDrag) {
        const rc = el.getBoundingClientRect();
        const k = (this.look.fov * DEG) / rc.height;
        this.look.yaw += (e.clientX - down.lx) * k;
        this.look.pitch = THREE.MathUtils.clamp(this.look.pitch + (e.clientY - down.ly) * k, -89 * DEG, 89 * DEG);
        this.invalidate();
        this.emit('look', this.look);
      }
      if (down) {
        down.lx = e.clientX; down.ly = e.clientY;
        if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) down.moved = true;
      } else {
        this._hover(kind, e);
      }
      this.emit('pointer', { kind, event: e });
    });
    el.addEventListener('pointerup', (e) => {
      const d = down; down = null;
      if (!d || d.moved || d.button !== 0 || performance.now() - d.t > 600) return;
      if (this.gizmoCloud && this.gizmo.axis) return; // clic sur une poignée du gizmo
      this._click(kind, e);
    });
    el.addEventListener('dblclick', (e) => {
      if (kind !== '3d' || this.picker || this.fpvActive()) return;
      const rc = el.getBoundingClientRect();
      const hit = pickScreen(this.store.clouds.filter((c) => c.visible), this.cam3d, e.clientX - rc.left, e.clientY - rc.top, rc.width, rc.height, 10);
      if (hit) { this.controls.target.copy(hit.point); this.invalidate(); }
    });
    el.addEventListener('wheel', (e) => {
      if (!this._lookEnabled(kind)) return;
      e.preventDefault();
      this.look.fov = THREE.MathUtils.clamp(this.look.fov * (e.deltaY > 0 ? 1.08 : 0.92), 12, 110);
      this.invalidate();
      this.emit('look', this.look);
    }, { passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  _lookEnabled(kind) { return !!this.stationId && (kind === 'pano' || this.fpvActive()); }

  _camFor(kind) { return kind === 'pano' ? this.camPano : this.cam3d; }

  _hitStation(kind, px, py, w, h) {
    const cam = this._camFor(kind);
    let best = null, bd = 18;
    for (const s of this.store.stations) {
      if (s.id === this.stationId) continue;
      const v = this.store.stationWorld(s).project(cam);
      if (v.z > 1 || v.z < -1) continue;
      const sx = (v.x * 0.5 + 0.5) * w, sy = (1 - (v.y * 0.5 + 0.5)) * h;
      const d = Math.hypot(sx - px, sy - py);
      if (d < bd) { bd = d; best = s; }
    }
    return best;
  }

  _hover(kind, e) {
    const el = kind === '3d' ? this.slot3d : this.slotPano;
    const rc = el.getBoundingClientRect();
    const s = this.picker ? null : this._hitStation(kind, e.clientX - rc.left, e.clientY - rc.top, rc.width, rc.height);
    if (s?.id !== this.hoverStation) {
      this.hoverStation = s?.id ?? null;
      el.style.cursor = s ? 'pointer' : this.picker ? 'crosshair' : '';
    }
    if (s) {
      this.tooltip.textContent = `${s.name}${s.panoId ? ' — cliquer pour ouvrir le panoramique' : ' — vue depuis la station'}`;
      this.tooltip.style.left = `${e.clientX - this.views.getBoundingClientRect().left + 14}px`;
      this.tooltip.style.top = `${e.clientY - this.views.getBoundingClientRect().top + 10}px`;
      this.tooltip.hidden = false;
    } else this.hideTip();
  }

  hideTip() { this.tooltip.hidden = true; }

  _click(kind, e) {
    const el = kind === '3d' ? this.slot3d : this.slotPano;
    const rc = el.getBoundingClientRect();
    const px = e.clientX - rc.left, py = e.clientY - rc.top;
    const clouds = this.store.clouds.filter((c) => c.visible && (!this.picker?.only || c === this.picker.only));
    if (this.picker) {
      let hit = null;
      if (kind === 'pano') {
        this._lookCamera(this.camPano, this._stationPos());
        this.camPano.aspect = rc.width / rc.height; this.camPano.updateProjectionMatrix(); this.camPano.updateMatrixWorld(true);
        const ndc = new THREE.Vector3((px / rc.width) * 2 - 1, 1 - (py / rc.height) * 2, 0.5).unproject(this.camPano);
        const origin = this.camPano.position.clone();
        const dir = ndc.sub(origin).normalize();
        const tol = (10 * (this.look.fov * DEG)) / rc.height;
        hit = pickRay(clouds, origin, dir, tol);
        if (hit) hit.origin = origin;
      } else {
        const cam = this.cam3d;
        cam.updateMatrixWorld(true);
        cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
        hit = pickScreen(clouds, cam, px, py, rc.width, rc.height, 9);
      }
      this.emit('pick', { hit, kind });
      if (hit) this.picker?.(hit, kind);
      else this.emit('pick-miss', kind);
      return;
    }
    const st = this._hitStation(kind, px, py, rc.width, rc.height);
    if (st) this.showStation(st.id);
  }

  // ---------------------------------------------------------------- gizmo (recalage manuel)

  attachGizmo(cloud, mode = 'translate') {
    this.detachGizmo();
    if (!cloud) return;
    const pivot = new THREE.Object3D();
    pivot.position.copy(cloud.centerLocal().applyMatrix4(cloud.matrix));
    this.scene.add(pivot);
    pivot.updateMatrix();
    this._gz = { pivot, base: cloud.matrix.clone(), p0: pivot.matrix.clone(), dirty: false };
    this.gizmoCloud = cloud;
    this.gizmo.attach(pivot);
    this.gizmo.setMode(mode);
    this.gizmo.setSize(0.9);
    this.invalidate();
  }

  setGizmoMode(m) { this.gizmo.setMode(m); this.invalidate(); }

  detachGizmo() {
    if (this.gizmoCloud) { this.gizmo.detach(); this.scene.remove(this._gz.pivot); this.gizmoCloud = null; this._gz = null; }
    this.controls.enabled = !this.fpvActive();
    this.invalidate();
  }

  _gizmoChanged() {
    const g = this._gz;
    if (!g) return;
    g.pivot.updateMatrix();
    const delta = g.pivot.matrix.clone().multiply(g.p0.clone().invert());
    if (!g.dirty) { this.gizmoCloud.prevMatrix = g.base.clone(); g.dirty = true; }
    this.gizmoCloud.matrix.copy(delta).multiply(g.base);
    this.matricesChanged(this.gizmoCloud);
    this.emit('gizmo', this.gizmoCloud);
  }

  /** Petits points de repère (ex. paires homologues) : clé → liste de positions scène. */
  setMarks(key, points, color = 0xffffff) {
    this._marks ??= new Map();
    const old = this._marks.get(key);
    if (old) { this.markGroup.remove(old); old.geometry.dispose(); old.material.dispose(); this._marks.delete(key); }
    if (points.length) {
      const arr = new Float32Array(points.length * 3);
      points.forEach((p, i) => p.toArray(arr, i * 3));
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
      const o = new THREE.Points(g, new THREE.PointsMaterial({ color, size: 13, sizeAttenuation: false, depthTest: false, transparent: true }));
      o.layers.set(2); o.renderOrder = 960; o.frustumCulled = false;
      this.markGroup.add(o);
      this._marks.set(key, o);
    }
    this.invalidate();
  }

  /** Boîte de découpe (repère scène) ; null pour la masquer. */
  showBox(min, max) {
    if (this.boxHelper) { this.scene.remove(this.boxHelper); this.boxHelper.dispose?.(); this.boxHelper = null; }
    if (min && max) {
      this.boxHelper = new THREE.Box3Helper(new THREE.Box3(new THREE.Vector3(...min), new THREE.Vector3(...max)), 0xffb347);
      this.boxHelper.layers.set(3);
      this.scene.add(this.boxHelper);
    }
    this.invalidate();
  }

  // ---------------------------------------------------------------- mesures

  syncMeasures() {
    const ids = new Set(this.store.measures.map((m) => m.id));
    for (const [id, o] of this.measureObjs) {
      if (!ids.has(id)) {
        this.markGroup.remove(o.group); o.group.traverse((x) => { x.geometry?.dispose(); x.material?.dispose(); });
        this.measureObjs.delete(id);
        for (const k of ['3d', 'pano']) this.measureLabels.get(`${id}:${k}`)?.remove();
        this.measureLabels.delete(`${id}:3d`); this.measureLabels.delete(`${id}:pano`);
      }
    }
    for (const m of this.store.measures) {
      let o = this.measureObjs.get(m.id);
      if (!o) {
        const group = new THREE.Group();
        const pts = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color: m.color || 0xffd24f, size: 10, sizeAttenuation: false, depthTest: false, transparent: true }));
        const line = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: m.color || 0xffd24f, depthTest: false, transparent: true }));
        pts.renderOrder = line.renderOrder = 950;
        pts.frustumCulled = line.frustumCulled = false;
        group.add(line, pts);
        group.traverse((x) => x.layers.set(2));
        this.markGroup.add(group);
        o = { group, pts, line };
        this.measureObjs.set(m.id, o);
        for (const k of ['3d', 'pano']) {
          const el = document.createElement('div');
          el.className = 'measure-label';
          this.labels[k].appendChild(el);
          this.measureLabels.set(`${m.id}:${k}`, el);
        }
      }
      const pos = m.b ? [m.a, m.b] : [m.a];
      const arr = new Float32Array(pos.length * 3);
      pos.forEach((p, i) => p.toArray(arr, i * 3));
      o.pts.geometry.setAttribute('position', new THREE.BufferAttribute(arr, 3));
      o.line.geometry.setAttribute('position', new THREE.BufferAttribute(arr, 3));
      o.line.visible = !!m.b;
      o.group.visible = m.visible !== false;
    }
    this.invalidate();
  }

  _updateLabels() {
    for (const kind of ['3d', 'pano']) {
      const slot = kind === '3d' ? this.slot3d : this.slotPano;
      const visibleSlot = !slot.hidden && (kind === '3d' || this.stationId);
      const cam = this._camFor(kind);
      const rc = slot.getBoundingClientRect();
      for (const m of this.store.measures) {
        const el = this.measureLabels.get(`${m.id}:${kind}`);
        if (!el) continue;
        if (!visibleSlot || m.visible === false || !m.b || rc.width < 2) { el.hidden = true; continue; }
        const mid = m.a.clone().add(m.b).multiplyScalar(0.5).project(cam);
        if (mid.z > 1 || mid.z < -1) { el.hidden = true; continue; }
        el.hidden = false;
        el.textContent = m.label || '';
        el.style.transform = `translate(${(mid.x * 0.5 + 0.5) * rc.width}px, ${(1 - (mid.y * 0.5 + 0.5)) * rc.height}px) translate(-50%, -130%)`;
      }
    }
  }
}
