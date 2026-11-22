// Transformation rigide optimale entre deux séries de points appariés (méthode de Horn, 1987).
// Utilisée par l'ICP et par le recalage par points homologues.

/** Valeurs/vecteurs propres d'une matrice symétrique n×n (Jacobi). a est modifiée. */
function jacobiEigen(a, n) {
  const v = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p][q] * a[p][q];
    if (off < 1e-24) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p][q]) < 1e-30) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k][p], akq = a[k][q];
          a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p][k], aqk = a[q][k];
          a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k][p], vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  return { values: a.map((r, i) => r[i]), vectors: v };
}

export function quatToRot([w, x, y, z]) {
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
  ];
}

/**
 * Cherche R (3×3, ligne par ligne) et t tels que  Q ≈ R·P + t.
 * @param {ArrayLike<number>} P points sources (xyz)
 * @param {ArrayLike<number>} Q points cibles correspondants (xyz)
 * @param {number} n nombre de paires
 * @param {Int32Array|null} pairs si fourni : indices i (dans P) ; Q est alors indexé par la position j de la paire
 */
export function hornTransform(P, Q, n) {
  let pcx = 0, pcy = 0, pcz = 0, qcx = 0, qcy = 0, qcz = 0;
  for (let i = 0; i < n; i++) {
    pcx += P[i * 3]; pcy += P[i * 3 + 1]; pcz += P[i * 3 + 2];
    qcx += Q[i * 3]; qcy += Q[i * 3 + 1]; qcz += Q[i * 3 + 2];
  }
  pcx /= n; pcy /= n; pcz /= n; qcx /= n; qcy /= n; qcz /= n;
  let sxx = 0, sxy = 0, sxz = 0, syx = 0, syy = 0, syz = 0, szx = 0, szy = 0, szz = 0;
  for (let i = 0; i < n; i++) {
    const ax = P[i * 3] - pcx, ay = P[i * 3 + 1] - pcy, az = P[i * 3 + 2] - pcz;
    const bx = Q[i * 3] - qcx, by = Q[i * 3 + 1] - qcy, bz = Q[i * 3 + 2] - qcz;
    sxx += ax * bx; sxy += ax * by; sxz += ax * bz;
    syx += ay * bx; syy += ay * by; syz += ay * bz;
    szx += az * bx; szy += az * by; szz += az * bz;
  }
  const N = [
    [sxx + syy + szz, syz - szy, szx - sxz, sxy - syx],
    [syz - szy, sxx - syy - szz, sxy + syx, szx + sxz],
    [szx - sxz, sxy + syx, -sxx + syy - szz, syz + szy],
    [sxy - syx, szx + sxz, syz + szy, -sxx - syy + szz],
  ];
  const { values, vectors } = jacobiEigen(N, 4);
  let best = 0;
  for (let i = 1; i < 4; i++) if (values[i] > values[best]) best = i;
  let q = [vectors[0][best], vectors[1][best], vectors[2][best], vectors[3][best]];
  const nq = Math.hypot(...q) || 1;
  q = q.map((c) => c / nq);
  if (q[0] < 0) q = q.map((c) => -c);
  const R = quatToRot(q);
  const t = [
    qcx - (R[0] * pcx + R[1] * pcy + R[2] * pcz),
    qcy - (R[3] * pcx + R[4] * pcy + R[5] * pcz),
    qcz - (R[6] * pcx + R[7] * pcy + R[8] * pcz),
  ];
  return { R, t, q };
}

/** Matrice 4×4 colonne-major (convention three.js) à partir de R (3×3 par lignes) et t. */
export function toMatrix4(R, t) {
  return [
    R[0], R[3], R[6], 0,
    R[1], R[4], R[7], 0,
    R[2], R[5], R[8], 0,
    t[0], t[1], t[2], 1,
  ];
}
