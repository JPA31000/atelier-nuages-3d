// KD-tree statique (implicite, équilibré par médiane) sur un tableau Float32/Float64 xyz.
// Construction O(n log n) ; requêtes : plus proche voisin, k plus proches, comptage dans un rayon.

const LEAF = 8;

export class KDTree {
  constructor(pos, n = Math.floor(pos.length / 3)) {
    this.pos = pos;
    this.n = n;
    this.idx = new Uint32Array(n);
    for (let i = 0; i < n; i++) this.idx[i] = i;
    this.axis = new Uint8Array(n);
    this.bestD2 = Infinity;
    this.bestI = -1;
    this._build();
  }

  _build() {
    const { idx, pos, axis } = this;
    const stack = [0, this.n];
    while (stack.length) {
      const hi = stack.pop(), lo = stack.pop();
      if (hi - lo <= LEAF) continue;
      let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
      for (let i = lo; i < hi; i++) {
        const k = idx[i] * 3;
        const x = pos[k], y = pos[k + 1], z = pos[k + 2];
        if (x < mnx) mnx = x; if (x > mxx) mxx = x;
        if (y < mny) mny = y; if (y > mxy) mxy = y;
        if (z < mnz) mnz = z; if (z > mxz) mxz = z;
      }
      const ex = mxx - mnx, ey = mxy - mny, ez = mxz - mnz;
      const ax = ex >= ey && ex >= ez ? 0 : ey >= ez ? 1 : 2;
      const mid = (lo + hi) >> 1;
      this._select(lo, hi - 1, mid, ax);
      axis[mid] = ax;
      stack.push(lo, mid, mid + 1, hi);
    }
  }

  _select(lo, hi, k, ax) {
    const { idx, pos } = this;
    while (hi > lo) {
      const m = (lo + hi) >> 1;
      const a = pos[idx[lo] * 3 + ax], b = pos[idx[m] * 3 + ax], c = pos[idx[hi] * 3 + ax];
      const pv = a < b ? (b < c ? b : a < c ? c : a) : (a < c ? a : b < c ? c : b);
      let i = lo, j = hi;
      while (i <= j) {
        while (pos[idx[i] * 3 + ax] < pv) i++;
        while (pos[idx[j] * 3 + ax] > pv) j--;
        if (i <= j) { const t = idx[i]; idx[i] = idx[j]; idx[j] = t; i++; j--; }
      }
      if (k <= j) hi = j; else if (k >= i) lo = i; else return;
    }
  }

  /** Indice du point le plus proche (ou -1) ; la distance² est dans `this.bestD2`. */
  nearest(x, y, z, maxD2 = Infinity) {
    this.bestD2 = maxD2;
    this.bestI = -1;
    this._nn(0, this.n, x, y, z);
    return this.bestI;
  }

  _nn(lo, hi, x, y, z) {
    const { idx, pos } = this;
    if (hi - lo <= LEAF) {
      for (let i = lo; i < hi; i++) {
        const k = idx[i] * 3;
        const dx = pos[k] - x, dy = pos[k + 1] - y, dz = pos[k + 2] - z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < this.bestD2) { this.bestD2 = d2; this.bestI = idx[i]; }
      }
      return;
    }
    const mid = (lo + hi) >> 1;
    const pi = idx[mid] * 3;
    const dx = pos[pi] - x, dy = pos[pi + 1] - y, dz = pos[pi + 2] - z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < this.bestD2) { this.bestD2 = d2; this.bestI = idx[mid]; }
    const diff = (this.axis[mid] === 0 ? x : this.axis[mid] === 1 ? y : z) - pos[pi + this.axis[mid]];
    if (diff < 0) {
      this._nn(lo, mid, x, y, z);
      if (diff * diff < this.bestD2) this._nn(mid + 1, hi, x, y, z);
    } else {
      this._nn(mid + 1, hi, x, y, z);
      if (diff * diff < this.bestD2) this._nn(lo, mid, x, y, z);
    }
  }

  /**
   * k plus proches voisins : remplit `outD2` (trié croissant) ; retourne le nombre trouvé.
   * `outD2` doit avoir au moins k éléments.
   */
  knn(x, y, z, k, outD2, outIdx = null) {
    this._k = k; this._cnt = 0; this._od = outD2; this._oi = outIdx;
    this._knn(0, this.n, x, y, z);
    return this._cnt;
  }

  _push(d2, i) {
    const od = this._od, oi = this._oi, k = this._k;
    let p = this._cnt < k ? this._cnt++ : k - 1;
    while (p > 0 && od[p - 1] > d2) { od[p] = od[p - 1]; if (oi) oi[p] = oi[p - 1]; p--; }
    od[p] = d2;
    if (oi) oi[p] = i;
  }

  _knn(lo, hi, x, y, z) {
    const { idx, pos } = this;
    const bound = () => (this._cnt < this._k ? Infinity : this._od[this._k - 1]);
    if (hi - lo <= LEAF) {
      for (let i = lo; i < hi; i++) {
        const q = idx[i] * 3;
        const dx = pos[q] - x, dy = pos[q + 1] - y, dz = pos[q + 2] - z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < bound()) this._push(d2, idx[i]);
      }
      return;
    }
    const mid = (lo + hi) >> 1;
    const pi = idx[mid] * 3;
    const dx = pos[pi] - x, dy = pos[pi + 1] - y, dz = pos[pi + 2] - z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < bound()) this._push(d2, idx[mid]);
    const ax = this.axis[mid];
    const diff = (ax === 0 ? x : ax === 1 ? y : z) - pos[pi + ax];
    if (diff < 0) {
      this._knn(lo, mid, x, y, z);
      if (diff * diff < bound()) this._knn(mid + 1, hi, x, y, z);
    } else {
      this._knn(mid + 1, hi, x, y, z);
      if (diff * diff < bound()) this._knn(lo, mid, x, y, z);
    }
  }

  /** Nombre de points à distance² ≤ r2 (s'arrête dès que `limit` est atteint). */
  countWithin(x, y, z, r2, limit = Infinity) {
    this._c = 0; this._lim = limit; this._r2 = r2;
    this._cw(0, this.n, x, y, z);
    return this._c;
  }

  _cw(lo, hi, x, y, z) {
    if (this._c >= this._lim) return;
    const { idx, pos } = this;
    if (hi - lo <= LEAF) {
      for (let i = lo; i < hi; i++) {
        const k = idx[i] * 3;
        const dx = pos[k] - x, dy = pos[k + 1] - y, dz = pos[k + 2] - z;
        if (dx * dx + dy * dy + dz * dz <= this._r2) this._c++;
      }
      return;
    }
    const mid = (lo + hi) >> 1;
    const pi = idx[mid] * 3;
    const dx = pos[pi] - x, dy = pos[pi + 1] - y, dz = pos[pi + 2] - z;
    if (dx * dx + dy * dy + dz * dz <= this._r2) this._c++;
    const ax = this.axis[mid];
    const diff = (ax === 0 ? x : ax === 1 ? y : z) - pos[pi + ax];
    if (diff < 0) {
      this._cw(lo, mid, x, y, z);
      if (diff * diff <= this._r2) this._cw(mid + 1, hi, x, y, z);
    } else {
      this._cw(mid + 1, hi, x, y, z);
      if (diff * diff <= this._r2) this._cw(lo, mid, x, y, z);
    }
  }
}
