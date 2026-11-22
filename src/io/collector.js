// Collecteur de points : sous-échantillonnage, centrage local, mélange.
//
// Principe de précision (cf. README) :
//   - les coordonnées d'origine (Float64) sont ramenées autour du BARYCENTRE du nuage ;
//   - on ne garde en mémoire / sur le GPU que des Float32 « locaux » (précis au 1/10 mm sur 100 m) ;
//   - le décalage exact (Float64) est conservé dans `offset` : brut = local + offset.
//
// Les points sont mélangés (Fisher-Yates) à la fin : tout préfixe du tableau est alors un
// échantillon uniforme du nuage, ce qui sert à l'affichage progressif, à l'ICP et aux filtres.

export class PointCollector {
  /**
   * @param {object} o
   * @param {number} o.expected   nombre de points attendus (pour le taux d'échantillonnage)
   * @param {number} o.budget     nombre maximal de points à conserver
   * @param {number[]|null} o.offsetHint  centre approximatif (coordonnées brutes)
   * @param {boolean} o.hasColor
   * @param {boolean} o.hasIntensity
   */
  constructor({ expected = 0, budget = Infinity, offsetHint = null, hasColor = false, hasIntensity = false, seed = 2463534242 } = {}) {
    this.hasColor = hasColor;
    this.hasIntensity = hasIntensity;
    this.keep = expected > 0 && budget < expected ? budget / expected : 1;
    this.seen = 0;
    this.n = 0;
    this.offset = offsetHint ? [offsetHint[0], offsetHint[1], offsetHint[2]] : null;
    let cap = Math.max(1024, Math.ceil(Math.min(expected || 1 << 16, budget) * 1.05));
    if (!Number.isFinite(cap)) cap = 1 << 16;
    this.cap = cap;
    this.pos = new Float32Array(cap * 3);
    this.col = hasColor ? new Uint16Array(cap * 3) : null;
    this.int = hasIntensity ? new Float32Array(cap) : null;
    this._s = seed | 0 || 1;
  }

  _rand() {
    let s = this._s;
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    this._s = s;
    return (s >>> 0) / 4294967296;
  }

  /** À appeler pour chaque point source avant de le décoder : true = on le garde. */
  accept() {
    this.seen++;
    return this.keep >= 1 || this._rand() < this.keep;
  }

  _grow() {
    const cap = Math.ceil(this.cap * 1.5) + 1024;
    const pos = new Float32Array(cap * 3); pos.set(this.pos); this.pos = pos;
    if (this.col) { const c = new Uint16Array(cap * 3); c.set(this.col); this.col = c; }
    if (this.int) { const i = new Float32Array(cap); i.set(this.int); this.int = i; }
    this.cap = cap;
  }

  add(x, y, z, r = 0, g = 0, b = 0, intensity = 0) {
    if (this.n >= this.cap) this._grow();
    if (!this.offset) this.offset = [x, y, z];
    const o = this.offset;
    const k = this.n * 3;
    this.pos[k] = x - o[0];
    this.pos[k + 1] = y - o[1];
    this.pos[k + 2] = z - o[2];
    if (this.col) { this.col[k] = r; this.col[k + 1] = g; this.col[k + 2] = b; }
    if (this.int) this.int[this.n] = intensity;
    this.n++;
  }

  /**
   * @param {object} [o]
   * @param {number} [o.colorMax]  valeur maximale des couleurs sources (255, 65535, 1…) ; auto sinon
   * @param {number[]} [o.intensityRange] [min,max] source ; auto sinon
   * @param {boolean} [o.shuffle=true]
   */
  finish({ colorMax = null, intensityRange = null, shuffle = true } = {}) {
    const n = this.n;
    const base = this.offset || [0, 0, 0];
    const pos = this.pos;
    // 1. recentrage exact sur le barycentre (somme en double précision)
    let mx = 0, my = 0, mz = 0;
    for (let i = 0; i < n; i++) { mx += pos[i * 3]; my += pos[i * 3 + 1]; mz += pos[i * 3 + 2]; }
    if (n > 0) { mx /= n; my /= n; mz /= n; }
    const fx = Math.fround(mx), fy = Math.fround(my), fz = Math.fround(mz);
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = (pos[i * 3] -= fx), y = (pos[i * 3 + 1] -= fy), z = (pos[i * 3 + 2] -= fz);
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    const offset = [base[0] + fx, base[1] + fy, base[2] + fz];

    // 2. couleurs -> Uint8
    let colors = null;
    if (this.col && n > 0) {
      let cmax = colorMax;
      if (!cmax) {
        let m = 0;
        const c = this.col;
        for (let i = 0; i < n * 3; i++) if (c[i] > m) m = c[i];
        cmax = m <= 255 ? 255 : 65535;
      }
      const f = 255 / cmax;
      colors = new Uint8Array(n * 3);
      const c = this.col;
      for (let i = 0; i < n * 3; i++) { const v = Math.round(c[i] * f); colors[i] = v > 255 ? 255 : v; }
    }
    // 3. intensité -> [0,1]
    let intensity = null;
    let usedRange = null;
    if (this.int && n > 0) {
      let lo, hi;
      if (intensityRange && intensityRange[1] > intensityRange[0]) { lo = intensityRange[0]; hi = intensityRange[1]; }
      else {
        lo = Infinity; hi = -Infinity;
        for (let i = 0; i < n; i++) { const v = this.int[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
        if (!(hi > lo)) { lo = 0; hi = lo + 1; }
      }
      const inv = 1 / (hi - lo);
      intensity = new Float32Array(n);
      for (let i = 0; i < n; i++) { const v = (this.int[i] - lo) * inv; intensity[i] = v < 0 ? 0 : v > 1 ? 1 : v; }
      usedRange = [lo, hi];
    }
    let positions = pos.slice(0, n * 3);

    // 4. mélange en place (le préfixe devient un échantillon uniforme)
    if (shuffle && n > 1) {
      for (let i = n - 1; i > 0; i--) {
        const j = (this._rand() * (i + 1)) | 0;
        if (j === i) continue;
        const a = i * 3, b = j * 3;
        let t = positions[a]; positions[a] = positions[b]; positions[b] = t;
        t = positions[a + 1]; positions[a + 1] = positions[b + 1]; positions[b + 1] = t;
        t = positions[a + 2]; positions[a + 2] = positions[b + 2]; positions[b + 2] = t;
        if (colors) {
          let u = colors[a]; colors[a] = colors[b]; colors[b] = u;
          u = colors[a + 1]; colors[a + 1] = colors[b + 1]; colors[b + 1] = u;
          u = colors[a + 2]; colors[a + 2] = colors[b + 2]; colors[b + 2] = u;
        }
        if (intensity) { const t2 = intensity[i]; intensity[i] = intensity[j]; intensity[j] = t2; }
      }
    }
    this.pos = this.col = this.int = null;
    return {
      count: n,
      seen: this.seen,
      offset,
      positions,
      colors,
      intensity,
      intensityRange: usedRange,
      boundsLocal: n ? [minX, minY, minZ, maxX, maxY, maxZ] : [0, 0, 0, 0, 0, 0],
    };
  }
}
