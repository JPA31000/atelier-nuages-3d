// Lecture en flux de fichiers texte (XYZ, PTS, PLY ASCII) sans jamais tout charger en mémoire.

const CHUNK = 8 * 1024 * 1024;

/**
 * Appelle onLine(bytes, start, end) pour chaque ligne (CR/LF retirés).
 * `onProgress(fraction)` est appelé après chaque bloc.
 */
export async function readTextLines(blob, startByte, onLine, { onProgress, chunk = CHUNK } = {}) {
  let pos = startByte;
  let carry = null;
  const total = blob.size;
  while (pos < total) {
    const end = Math.min(total, pos + chunk);
    const fresh = new Uint8Array(await blob.slice(pos, end).arrayBuffer());
    pos = end;
    let buf = fresh;
    if (carry && carry.length) {
      buf = new Uint8Array(carry.length + fresh.length);
      buf.set(carry, 0);
      buf.set(fresh, carry.length);
    }
    let s = 0;
    const n = buf.length;
    for (let i = 0; i < n; i++) {
      if (buf[i] === 10) {
        let e = i;
        if (e > s && buf[e - 1] === 13) e--;
        onLine(buf, s, e);
        s = i + 1;
      }
    }
    carry = s < n ? buf.slice(s) : null;
    if (onProgress) onProgress(pos / total);
  }
  if (carry && carry.length) {
    let e = carry.length;
    if (e > 0 && carry[e - 1] === 13) e--;
    onLine(carry, 0, e);
  }
}

/**
 * Lit jusqu'à `max` nombres séparés par espace/tab/virgule/point-virgule.
 * @returns {number} nombre de valeurs lues, ou -1 si la ligne n'est pas numérique.
 */
export function parseNumbers(b, s, e, out, max = 24) {
  let n = 0;
  let i = s;
  while (i < e && n < max) {
    let c = b[i];
    if (c === 32 || c === 9 || c === 44 || c === 59) { i++; continue; }
    let neg = false;
    if (c === 45) { neg = true; i++; } else if (c === 43) { i++; }
    let v = 0;
    let digits = 0;
    while (i < e && (c = b[i]) >= 48 && c <= 57) { v = v * 10 + (c - 48); i++; digits++; }
    if (i < e && b[i] === 46) {
      i++;
      let scale = 1;
      while (i < e && (c = b[i]) >= 48 && c <= 57) { v = v * 10 + (c - 48); scale *= 10; i++; digits++; }
      v /= scale;
    }
    if (!digits) return -1;
    if (i < e && (b[i] === 101 || b[i] === 69)) {
      i++;
      let eneg = false;
      if (i < e && b[i] === 45) { eneg = true; i++; } else if (i < e && b[i] === 43) i++;
      let ev = 0;
      let ed = 0;
      while (i < e && (c = b[i]) >= 48 && c <= 57) { ev = ev * 10 + (c - 48); i++; ed++; }
      if (!ed) return -1;
      v *= Math.pow(10, eneg ? -ev : ev);
    }
    if (i < e) {
      c = b[i];
      if (!(c === 32 || c === 9 || c === 44 || c === 59)) return -1; // jeton mal formé (lettre, etc.)
    }
    out[n++] = neg ? -v : v;
  }
  return n;
}
