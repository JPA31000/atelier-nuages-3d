// Lecteur PLY (Stanford Polygon File Format) : ASCII, binaire little/big endian.
// Seuls les sommets (élément « vertex ») sont lus : x y z, couleurs, intensité éventuelle.

import { PointCollector } from './collector.js';
import { readTextLines, parseNumbers } from './textreader.js';

const TYPES = {
  char: ['Int8', 1], int8: ['Int8', 1], uchar: ['Uint8', 1], uint8: ['Uint8', 1],
  short: ['Int16', 2], int16: ['Int16', 2], ushort: ['Uint16', 2], uint16: ['Uint16', 2],
  int: ['Int32', 4], int32: ['Int32', 4], uint: ['Uint32', 4], uint32: ['Uint32', 4],
  float: ['Float32', 4], float32: ['Float32', 4], double: ['Float64', 8], float64: ['Float64', 8],
};

function parseHeader(bytes) {
  // cherche « end_header » suivi d'un saut de ligne
  const txt = new TextDecoder('latin1').decode(bytes);
  const m = /end_header\r?\n/.exec(txt);
  if (!m) throw new Error("En-tête PLY incomplet (« end_header » introuvable).");
  const headerEnd = m.index + m[0].length;
  const lines = txt.slice(0, m.index).split(/\r?\n/);
  if (lines[0].trim() !== 'ply') throw new Error('Ce fichier ne commence pas par « ply ».');
  let format = 'ascii';
  const elements = [];
  const comments = [];
  for (const raw of lines.slice(1)) {
    const t = raw.trim().split(/\s+/);
    if (t[0] === 'format') format = t[1];
    else if (t[0] === 'comment') comments.push(raw.trim().slice(8));
    else if (t[0] === 'element') elements.push({ name: t[1], count: parseInt(t[2], 10), props: [] });
    else if (t[0] === 'property' && elements.length) {
      const el = elements[elements.length - 1];
      if (t[1] === 'list') el.props.push({ name: t[4], list: true, countType: t[2], type: t[3] });
      else el.props.push({ name: t[2], type: t[1] });
    }
  }
  return { format, elements, comments, headerEnd };
}

export async function readPly(file, opts = {}, onProgress = () => {}) {
  const budget = opts.budget ?? Infinity;
  const head = new Uint8Array(await file.slice(0, 64 * 1024).arrayBuffer());
  const h = parseHeader(head);
  const vi = h.elements.findIndex((e) => e.name === 'vertex');
  if (vi < 0) throw new Error('Ce PLY ne contient aucun sommet (élément « vertex »).');
  const vert = h.elements[vi];
  if (vert.props.some((p) => p.list)) throw new Error('Propriété liste dans « vertex » : non prise en charge.');
  const names = vert.props.map((p) => p.name.toLowerCase());
  const find = (...c) => { for (const k of c) { const i = names.indexOf(k); if (i >= 0) return i; } return -1; };
  const ix = find('x'), iy = find('y'), iz = find('z');
  if (ix < 0 || iy < 0 || iz < 0) throw new Error('Le PLY n’a pas de propriétés x, y, z.');
  const ir = find('red', 'r', 'diffuse_red'), ig = find('green', 'g', 'diffuse_green'), ib = find('blue', 'b', 'diffuse_blue');
  const hasColor = ir >= 0 && ig >= 0 && ib >= 0;
  const ii = find('intensity', 'scalar_intensity', 'i', 'scalar_scalar_field');
  const colorType = hasColor ? vert.props[ir].type : null;
  const colorMax = !hasColor ? null : /float|double/.test(colorType) ? 1 : /uchar|uint8/.test(colorType) ? 255 : /ushort|uint16/.test(colorType) ? 65535 : null;
  const n = vert.count;
  const col = new PointCollector({ expected: n, budget, hasColor, hasIntensity: ii >= 0 });
  const warnings = [];
  const nonVertexBefore = h.elements.slice(0, vi).length > 0;

  if (h.format === 'ascii') {
    const tmp = new Float64Array(Math.max(32, vert.props.length));
    let read = 0;
    await readTextLines(file, h.headerEnd, (buf, s, e) => {
      if (read >= n) return;
      const k = parseNumbers(buf, s, e, tmp, tmp.length);
      if (k < vert.props.length) return;
      read++;
      if (!col.accept()) return;
      col.add(tmp[ix], tmp[iy], tmp[iz], hasColor ? tmp[ir] : 0, hasColor ? tmp[ig] : 0, hasColor ? tmp[ib] : 0, ii >= 0 ? tmp[ii] : 0);
    }, { onProgress: (f) => onProgress(f, 'Lecture du PLY ASCII…') });
  } else {
    if (nonVertexBefore) throw new Error('PLY binaire avec éléments avant « vertex » : non pris en charge.');
    const le = h.format === 'binary_little_endian';
    if (!le && h.format !== 'binary_big_endian') throw new Error(`Format PLY inconnu : ${h.format}`);
    let stride = 0;
    const props = vert.props.map((p) => {
      const t = TYPES[p.type];
      if (!t) throw new Error(`Type PLY inconnu : ${p.type}`);
      const o = { off: stride, get: 'get' + t[0] };
      stride += t[1];
      return o;
    });
    const rec = (i) => props[i];
    const chunkRecs = Math.max(1, Math.floor((16 * 1024 * 1024) / stride));
    for (let start = 0; start < n; start += chunkRecs) {
      const cnt = Math.min(chunkRecs, n - start);
      const buf = await file.slice(h.headerEnd + start * stride, h.headerEnd + (start + cnt) * stride).arrayBuffer();
      const dv = new DataView(buf);
      const px = rec(ix), py = rec(iy), pz = rec(iz);
      const pr = hasColor ? rec(ir) : null, pg = hasColor ? rec(ig) : null, pb = hasColor ? rec(ib) : null;
      const pi = ii >= 0 ? rec(ii) : null;
      for (let i = 0; i < cnt; i++) {
        if (!col.accept()) continue;
        const o = i * stride;
        col.add(
          dv[px.get](o + px.off, le), dv[py.get](o + py.off, le), dv[pz.get](o + pz.off, le),
          pr ? dv[pr.get](o + pr.off, le) : 0, pg ? dv[pg.get](o + pg.off, le) : 0, pb ? dv[pb.get](o + pb.off, le) : 0,
          pi ? dv[pi.get](o + pi.off, le) : 0,
        );
      }
      onProgress((start + cnt) / n, 'Lecture du PLY binaire…');
    }
  }
  const out = col.finish({ colorMax });
  const faces = h.elements.find((e) => e.name === 'face');
  if (faces && faces.count > 0) warnings.push(`Ce PLY est un maillage (${faces.count} faces) : seuls les sommets sont affichés comme nuage de points.`);
  return {
    format: 'PLY',
    structure: null,
    info: { encodage: h.format, proprietes: vert.props.map((p) => p.name).join(', '), pointsSource: n },
    clouds: [{ name: file.name.replace(/\.[^.]+$/, ''), ...out, station: null }],
    images: [],
    warnings,
  };
}
