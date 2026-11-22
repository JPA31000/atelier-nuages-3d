// Modèle de données de la scène : nuages, stations, panoramiques, mesures.
//
// Repères :
//   - « local »  : coordonnées Float32 d'un nuage, centrées sur son barycentre ;
//   - « scène »  : repère de rendu = coordonnées brutes − sceneOrigin (petites valeurs, précis en Float32) ;
//   - « brut »   : repère d'origine du fichier (Lambert, UTM, …) = scène + sceneOrigin (Float64).
// cloud.matrix : local → scène (inclut le décalage du barycentre et les recalages successifs).

import * as THREE from 'three';

THREE.Object3D.DEFAULT_UP.set(0, 0, 1); // Z vers le haut (convention topographique)

export class Emitter {
  constructor() { this._h = new Map(); }
  on(evt, fn) {
    if (!this._h.has(evt)) this._h.set(evt, new Set());
    this._h.get(evt).add(fn);
    return () => this._h.get(evt)?.delete(fn);
  }
  emit(evt, ...args) { this._h.get(evt)?.forEach((fn) => fn(...args)); }
}

let counter = 1;
export const newId = (prefix) => `${prefix}${counter++}`;

const PALETTE = ['#4f9cff', '#ff8a4f', '#4fd18b', '#d36bff', '#ffd24f', '#ff5c7a', '#5fe0e6', '#a3c94f'];

export class Cloud {
  constructor(d) {
    this.id = newId('c');
    this.name = d.name;
    this.fileName = d.fileName ?? d.name;
    this.format = d.format ?? '?';
    this.structure = d.structure ?? null;
    this.meta = d.meta ?? {};
    this.count = d.count;
    this.positions = d.positions;
    this.colors = d.colors ?? null;
    this.intensity = d.intensity ?? null;
    this.offset = d.offset; // Float64[3]
    this.boundsLocal = d.boundsLocal;
    this.matrix = new THREE.Matrix4();
    this.initialMatrix = new THREE.Matrix4();
    this.prevMatrix = null;
    this.visible = true;
    this.color = PALETTE[(counter + 3) % PALETTE.length];
    this.undo = null; // état précédent après un filtre
    this.seen = d.seen ?? d.count;
  }

  /** Centre du nuage (repère local). */
  centerLocal() {
    const b = this.boundsLocal;
    return new THREE.Vector3((b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2);
  }

  /** Boîte englobante dans le repère scène (8 coins transformés). */
  boundsScene() {
    const b = this.boundsLocal;
    const box = new THREE.Box3();
    const v = new THREE.Vector3();
    for (const x of [b[0], b[3]]) for (const y of [b[1], b[4]]) for (const z of [b[2], b[5]]) {
      box.expandByPoint(v.set(x, y, z).applyMatrix4(this.matrix));
    }
    return box;
  }

  recomputeBounds() {
    const p = this.positions;
    let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < this.count; i++) {
      for (let k = 0; k < 3; k++) {
        const v = p[i * 3 + k];
        if (v < mn[k]) mn[k] = v;
        if (v > mx[k]) mx[k] = v;
      }
    }
    this.boundsLocal = this.count ? [...mn, ...mx] : [0, 0, 0, 0, 0, 0];
  }
}

export class Station {
  constructor({ name, cloudId = null, local, quaternion = [0, 0, 0, 1] }) {
    this.id = newId('s');
    this.name = name;
    this.cloudId = cloudId; // le repère de la station est celui de ce nuage (suit ses recalages)
    this.local = new THREE.Vector3(...local);
    this.quaternion = new THREE.Quaternion(...quaternion);
    this.panoId = null;
  }
}

export class Panorama {
  constructor({ name, bitmap, bytes, mime }) {
    this.id = newId('p');
    this.name = name;
    this.bitmap = bitmap;
    this.width = bitmap.width;
    this.height = bitmap.height;
    this.bytes = bytes; // fichier image d'origine (pour l'export du paquet)
    this.mime = mime;
    this.stationId = null;
    this.yawDeg = 0;
    this.flip = false;
    this.texture = null;
  }
}

export class Store extends Emitter {
  constructor() {
    super();
    this.clouds = [];
    this.stations = [];
    this.panos = [];
    this.measures = [];
    this.sceneOrigin = null; // Float64[3]
    this.files = []; // journal d'import [{name, format, structure, info, warnings, ...}]
  }

  cloud(id) { return this.clouds.find((c) => c.id === id) ?? null; }
  station(id) { return this.stations.find((s) => s.id === id) ?? null; }
  pano(id) { return this.panos.find((p) => p.id === id) ?? null; }

  get origin() { return this.sceneOrigin ?? [0, 0, 0]; }

  addCloud(cloud) {
    if (!this.sceneOrigin) this.sceneOrigin = cloud.offset.slice();
    const o = this.sceneOrigin;
    cloud.matrix.makeTranslation(cloud.offset[0] - o[0], cloud.offset[1] - o[1], cloud.offset[2] - o[2]);
    cloud.initialMatrix.copy(cloud.matrix);
    this.clouds.push(cloud);
    this.emit('clouds');
    return cloud;
  }

  removeCloud(id) {
    const c = this.cloud(id);
    if (!c) return;
    this.clouds = this.clouds.filter((x) => x.id !== id);
    this.stations = this.stations.filter((s) => {
      if (s.cloudId !== id) return true;
      const p = this.pano(s.panoId);
      if (p) p.stationId = null;
      return false;
    });
    if (!this.clouds.length && !this.stations.length) this.sceneOrigin = null;
    this.emit('clouds', { removed: id });
    this.emit('stations');
  }

  addStation(st) {
    if (!this.sceneOrigin && !st.cloudId) this.sceneOrigin = [0, 0, 0];
    this.stations.push(st);
    this.emit('stations');
    return st;
  }

  removeStation(id) {
    const s = this.station(id);
    if (!s) return;
    const p = this.pano(s.panoId);
    if (p) p.stationId = null;
    this.stations = this.stations.filter((x) => x.id !== id);
    this.emit('stations');
  }

  addPano(p) { this.panos.push(p); this.emit('panos'); return p; }

  removePano(id) {
    const p = this.pano(id);
    if (!p) return;
    const s = this.station(p.stationId);
    if (s) s.panoId = null;
    p.texture?.dispose();
    this.panos = this.panos.filter((x) => x.id !== id);
    this.emit('panos');
    this.emit('stations');
  }

  linkPano(panoId, stationId) {
    const p = this.pano(panoId);
    if (!p) return;
    const old = this.station(p.stationId);
    if (old) old.panoId = null;
    p.stationId = null;
    const s = this.station(stationId);
    if (s) {
      const prev = this.pano(s.panoId);
      if (prev) prev.stationId = null;
      s.panoId = p.id;
      p.stationId = s.id;
    }
    this.emit('panos');
    this.emit('stations');
  }

  /** Position de la station dans le repère scène. */
  stationWorld(s) {
    const c = this.cloud(s.cloudId);
    return c ? s.local.clone().applyMatrix4(c.matrix) : s.local.clone();
  }

  stationWorldQuaternion(s) {
    const c = this.cloud(s.cloudId);
    if (!c) return s.quaternion.clone();
    const q = new THREE.Quaternion();
    c.matrix.decompose(new THREE.Vector3(), q, new THREE.Vector3());
    return q.multiply(s.quaternion);
  }

  /** Coordonnées brutes (Float64) d'un point de la scène. */
  toRaw(v) {
    const o = this.origin;
    return [v.x + o[0], v.y + o[1], v.z + o[2]];
  }

  /** Boîte englobante des nuages visibles (repère scène). */
  sceneBounds(onlyVisible = true) {
    const box = new THREE.Box3();
    for (const c of this.clouds) if (!onlyVisible || c.visible) box.union(c.boundsScene());
    for (const s of this.stations) box.expandByPoint(this.stationWorld(s));
    return box;
  }
}
