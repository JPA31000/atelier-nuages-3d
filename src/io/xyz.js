// Lecteur XYZ / PTS / TXT / CSV / ASC : nuages de points texte.
//
// Colonnes reconnues automatiquement (voir README) :
//   3 col. : X Y Z
//   4-5    : X Y Z Intensité
//   6      : X Y Z R G B (entiers 0-255)  — sinon X Y Z + normales (ignorées)
//   7      : PTS  → X Y Z I R G B ;   XYZ → X Y Z R G B I
//   9+     : X Y Z R G B + normales (ignorées)
// Une première ligne contenant un seul entier (en-tête PTS) est ignorée.

import { PointCollector } from './collector.js';
import { readTextLines, parseNumbers } from './textreader.js';

const isByte = (v) => Number.isInteger(v) && v >= 0 && v <= 255;

export function detectColumns(rows, ext) {
  if (!rows.length) return { ncols: 3, r: -1, g: -1, b: -1, i: -1, label: 'X Y Z' };
  // nombre de colonnes le plus fréquent
  const freq = new Map();
  for (const r of rows) freq.set(r.length, (freq.get(r.length) || 0) + 1);
  let ncols = 3, best = -1;
  for (const [k, v] of freq) if (v > best) { best = v; ncols = k; }
  const sample = rows.filter((r) => r.length === ncols);
  const allByte = (a, b) => sample.every((r) => { for (let k = a; k <= b; k++) if (!isByte(r[k])) return false; return true; });
  const map = { ncols, r: -1, g: -1, b: -1, i: -1, label: 'X Y Z' };
  if (ncols === 4 || ncols === 5) { map.i = 3; map.label = 'X Y Z I'; }
  else if (ncols === 6) {
    if (allByte(3, 5)) { map.r = 3; map.g = 4; map.b = 5; map.label = 'X Y Z R G B'; }
  } else if (ncols === 7 || ncols === 8) {
    if (ext === 'pts' && allByte(4, 6)) { map.i = 3; map.r = 4; map.g = 5; map.b = 6; map.label = 'X Y Z I R G B'; }
    else if (allByte(3, 5)) { map.r = 3; map.g = 4; map.b = 5; map.i = 6; map.label = 'X Y Z R G B I'; }
    else if (allByte(4, 6)) { map.i = 3; map.r = 4; map.g = 5; map.b = 6; map.label = 'X Y Z I R G B'; }
    else { map.i = 3; map.label = 'X Y Z I'; }
  } else if (ncols >= 9) {
    if (allByte(3, 5)) { map.r = 3; map.g = 4; map.b = 5; map.label = 'X Y Z R G B (+ normales ignorées)'; }
  }
  return map;
}

export async function readXyz(file, ext, opts = {}, onProgress = () => {}) {
  const budget = opts.budget ?? Infinity;
  // 1. échantillon pour deviner les colonnes et estimer le nombre de lignes
  const head = new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer());
  const tmp = new Float64Array(24);
  const rows = [];
  let lineBytes = 0, lineCount = 0, ptsHeader = false, firstLine = true;
  let s = 0;
  for (let i = 0; i < head.length && rows.length < 200; i++) {
    if (head[i] !== 10) continue;
    let e = i;
    if (e > s && head[e - 1] === 13) e--;
    const n = parseNumbers(head, s, e, tmp, 24);
    if (firstLine && n === 1 && Number.isInteger(tmp[0])) ptsHeader = true;
    else if (n >= 3) { rows.push(Array.from(tmp.subarray(0, n))); lineBytes += i - s + 1; lineCount++; }
    firstLine = false;
    s = i + 1;
  }
  if (!rows.length) throw new Error('Aucune ligne « X Y Z » lisible dans ce fichier texte.');
  const map = detectColumns(rows, ext);
  const avg = lineBytes / Math.max(1, lineCount);
  const expected = Math.max(1, Math.round(file.size / avg));
  const first = rows[0];
  const col = new PointCollector({
    expected, budget, offsetHint: [first[0], first[1], first[2]],
    hasColor: map.r >= 0, hasIntensity: map.i >= 0,
  });
  const { r, g, b, i: ii } = map;
  let bad = 0;
  await readTextLines(file, 0, (buf, st, en) => {
    const n = parseNumbers(buf, st, en, tmp, 24);
    if (n < 3) { if (n < 0 || n === 1) bad++; return; }
    if (!col.accept()) return;
    col.add(tmp[0], tmp[1], tmp[2], r >= 0 ? tmp[r] : 0, g >= 0 ? tmp[g] : 0, b >= 0 ? tmp[b] : 0, ii >= 0 && ii < n ? tmp[ii] : 0);
  }, { onProgress: (f) => onProgress(f, 'Lecture du texte…') });
  const out = col.finish({ colorMax: map.r >= 0 ? 255 : null });
  return {
    format: ext === 'pts' ? 'PTS' : 'XYZ',
    structure: null,
    info: {
      colonnes: map.label + (ptsHeader ? ' (en-tête PTS)' : ''),
      pointsSource: out.seen,
      lignesIgnorees: bad,
    },
    clouds: [{ name: file.name.replace(/\.[^.]+$/, ''), ...out, station: null }],
    images: [],
    warnings: bad > 5 ? [`${bad} lignes non numériques ont été ignorées.`] : [],
  };
}
