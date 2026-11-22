// Source d'export : fusionne plusieurs nuages dans le repère GLOBAL d'origine.
//
// Pour un point local p d'un nuage de matrice M (local → scène, colonne-major comme three.js) :
//   scène = M · p        brut = scène + sceneOrigin     (Float64 : aucune perte de précision)

const CHUNK = 1 << 16;

/**
 * @param {Array<{positions:Float32Array, colors:Uint8Array|null, intensity:Float32Array|null, count:number, matrix:ArrayLike<number>}>} clouds
 * @param {number[]} sceneOrigin
 */
export function makeExportSource(clouds, sceneOrigin) {
  const total = clouds.reduce((a, c) => a + c.count, 0);
  const hasColor = clouds.some((c) => c.colors);
  const hasIntensity = clouds.some((c) => c.intensity);
  return {
    total,
    hasColor,
    hasIntensity,
    sceneOrigin,
    *chunks() {
      const ox = sceneOrigin[0], oy = sceneOrigin[1], oz = sceneOrigin[2];
      for (const c of clouds) {
        const m = c.matrix;
        const m0 = m[0], m4 = m[4], m8 = m[8], m12 = m[12] + ox;
        const m1 = m[1], m5 = m[5], m9 = m[9], m13 = m[13] + oy;
        const m2 = m[2], m6 = m[6], m10 = m[10], m14 = m[14] + oz;
        const p = c.positions;
        for (let s = 0; s < c.count; s += CHUNK) {
          const n = Math.min(CHUNK, c.count - s);
          const x = new Float64Array(n), y = new Float64Array(n), z = new Float64Array(n);
          for (let i = 0; i < n; i++) {
            const k = (s + i) * 3;
            const px = p[k], py = p[k + 1], pz = p[k + 2];
            x[i] = m0 * px + m4 * py + m8 * pz + m12;
            y[i] = m1 * px + m5 * py + m9 * pz + m13;
            z[i] = m2 * px + m6 * py + m10 * pz + m14;
          }
          let rgb = null;
          if (hasColor) {
            rgb = new Uint8Array(n * 3);
            if (c.colors) rgb.set(c.colors.subarray(s * 3, (s + n) * 3));
            else rgb.fill(200);
          }
          let inten = null;
          if (hasIntensity) {
            inten = new Float32Array(n);
            if (c.intensity) inten.set(c.intensity.subarray(s, s + n));
          }
          yield { n, x, y, z, rgb, inten };
        }
      }
    },
  };
}

export function sourceBounds(source) {
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const ch of source.chunks()) {
    for (let i = 0; i < ch.n; i++) {
      const a = ch.x[i], b = ch.y[i], c = ch.z[i];
      if (a < mn[0]) mn[0] = a; if (a > mx[0]) mx[0] = a;
      if (b < mn[1]) mn[1] = b; if (b > mx[1]) mx[1] = b;
      if (c < mn[2]) mn[2] = c; if (c > mx[2]) mx[2] = c;
    }
  }
  if (!source.total) return { min: [0, 0, 0], max: [0, 0, 0] };
  return { min: mn, max: mx };
}
