// Données synthétiques déterministes pour les tests.

export function rng(seed = 1) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

/** Nuage de n points d'une « pièce » 10 × 6 × 3 m placée loin de l'origine (Lambert-93 fictif). */
export function roomPoints(n, { origin = [651234.5, 6862345.25, 120.0], seed = 7, color = true, intensity = true } = {}) {
  const r = rng(seed);
  const x = new Float64Array(n), y = new Float64Array(n), z = new Float64Array(n);
  const R = color ? new Uint8Array(n) : null, G = color ? new Uint8Array(n) : null, B = color ? new Uint8Array(n) : null;
  const I = intensity ? new Float32Array(n) : null;
  for (let i = 0; i < n; i++) {
    const face = Math.floor(r() * 6);
    let a = r() * 10, b = r() * 6, c = r() * 3;
    if (face === 0) c = 0; else if (face === 1) c = 3; else if (face === 2) a = 0; else if (face === 3) a = 10; else if (face === 4) b = 0; else b = 6;
    x[i] = origin[0] + Math.round(a * 1000) / 1000;
    y[i] = origin[1] + Math.round(b * 1000) / 1000;
    z[i] = origin[2] + Math.round(c * 1000) / 1000;
    if (color) { R[i] = (a * 25) & 255; G[i] = (b * 40) & 255; B[i] = (c * 80) & 255; }
    if (intensity) I[i] = r();
  }
  return { x, y, z, r: R, g: G, b: B, intensity: I };
}
