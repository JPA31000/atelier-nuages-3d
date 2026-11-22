// Lecteur E57 (ASTM E2807) — écrit pour le navigateur, sans dépendance.
//
// Structure d'un fichier E57 :
//   [En-tête 48 o] [sections binaires…] [XML]      — le tout découpé en pages de 1024 o
//   (1020 octets utiles + 4 octets de CRC32C par page).
// Les décalages du XML (fileOffset) sont des décalages PHYSIQUES (CRC inclus) ;
// on les convertit en décalages LOGIQUES (sans CRC) avant lecture.
//
// « Structuré » / « non structuré » (terminologie ReCap / Revit) :
//   structuré     = plusieurs scans (Data3D) avec pose de station, et/ou grille ligne-colonne,
//                   et/ou coordonnées sphériques, et/ou images 2D associées ;
//   non structuré = un nuage unique déjà exprimé dans un repère global, sans station.

import { PointCollector } from './collector.js';
import { parseXml, child, childrenNamed, text, num } from './xml.js';

const PAGE = 1024;
const PAYLOAD = 1020;

class PagedFile {
  constructor(file) { this.file = file; }
  physToLogical(p) { const page = Math.floor(p / PAGE); return page * PAYLOAD + (p - page * PAGE); }
  get logicalSize() { return Math.floor(this.file.size / PAGE) * PAYLOAD; }
  async read(logical, length) {
    if (length <= 0) return new Uint8Array(0);
    const p0 = Math.floor(logical / PAYLOAD);
    const p1 = Math.floor((logical + length - 1) / PAYLOAD);
    const raw = new Uint8Array(await this.file.slice(p0 * PAGE, (p1 + 1) * PAGE).arrayBuffer());
    const out = new Uint8Array(length);
    let o = 0;
    for (let p = p0; p <= p1; p++) {
      const ps = p * PAYLOAD;
      const from = Math.max(logical, ps) - ps;
      const to = Math.min(logical + length, ps + PAYLOAD) - ps;
      const src = (p - p0) * PAGE;
      if (src + to > raw.length) { // fin de fichier tronquée
        const avail = Math.max(0, raw.length - src - from);
        out.set(raw.subarray(src + from, src + from + avail), o);
        break;
      }
      out.set(raw.subarray(src + from, src + to), o);
      o += to - from;
    }
    return out;
  }
}

// ---------- décodeurs de flux d'octets ----------

class Column {
  constructor() { this.a = new Float64Array(4096); this.n = 0; }
  reserve(extra) {
    if (this.n + extra > this.a.length) {
      const b = new Float64Array(Math.max(this.a.length * 2, this.n + extra));
      b.set(this.a.subarray(0, this.n));
      this.a = b;
    }
  }
  consume(k) { // retire les k premières valeurs
    if (k >= this.n) { this.n = 0; return; }
    this.a.copyWithin(0, k, this.n);
    this.n -= k;
  }
}

class FloatDecoder {
  constructor(size) { this.size = size; this.carry = new Uint8Array(0); this.col = new Column(); this.constant = false; }
  push(src) {
    let data = src;
    if (this.carry.length) { data = new Uint8Array(this.carry.length + src.length); data.set(this.carry); data.set(src, this.carry.length); }
    const nv = Math.floor(data.length / this.size);
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    this.col.reserve(nv);
    const a = this.col.a;
    let n = this.col.n;
    if (this.size === 4) for (let i = 0; i < nv; i++) a[n++] = dv.getFloat32(i * 4, true);
    else for (let i = 0; i < nv; i++) a[n++] = dv.getFloat64(i * 8, true);
    this.col.n = n;
    this.carry = data.slice(nv * this.size);
  }
}

class IntDecoder {
  // valeur = (min + brut) * scale + offset ; brut codé sur `bits` bits, LSB d'abord
  constructor(min, max, scale, offset) {
    this.min = min; this.scale = scale; this.offset = offset;
    const range = max - min;
    this.bits = range <= 0 ? 0 : Math.ceil(Math.log2(range + 1));
    if (this.bits > 53) throw new Error('Champ entier E57 de plus de 53 bits : non pris en charge.');
    this.constant = this.bits === 0;
    this.constValue = min * scale + offset;
    this.data = new Uint8Array(8); this.len = 0; this.bitStart = 0;
    this.col = new Column();
  }
  push(src) {
    if (this.constant) return;
    const bits = this.bits;
    // concatène le reliquat + les nouveaux octets (+ 8 octets de garde)
    const total = this.len + src.length;
    const d = new Uint8Array(total + 8);
    d.set(this.data.subarray(0, this.len), 0);
    d.set(src, this.len);
    const nv = Math.floor((total * 8 - this.bitStart) / bits);
    this.col.reserve(nv);
    const a = this.col.a;
    let n = this.col.n;
    const min = this.min, scale = this.scale, off = this.offset;
    const mask = bits >= 32 ? 0xffffffff : (1 << bits) - 1;
    const hiMask = bits > 32 ? Math.pow(2, bits - 32) - 1 : 0;
    let pos = this.bitStart;
    for (let k = 0; k < nv; k++) {
      const by = pos >>> 3, sh = pos & 7;
      const lo = (d[by] | (d[by + 1] << 8) | (d[by + 2] << 16) | (d[by + 3] << 24)) >>> 0;
      let v;
      if (bits + sh <= 32) {
        v = ((lo >>> sh) & mask) >>> 0;
      } else {
        const hi = (d[by + 4] | (d[by + 5] << 8) | (d[by + 6] << 16) | (d[by + 7] << 24)) >>> 0;
        let lo2, hi2;
        if (sh === 0) { lo2 = lo; hi2 = hi; } else { lo2 = ((lo >>> sh) | (hi << (32 - sh))) >>> 0; hi2 = hi >>> sh; }
        v = bits <= 32 ? (lo2 & mask) >>> 0 : lo2 + (hi2 & hiMask) * 4294967296;
      }
      a[n++] = (min + v) * scale + off;
      pos += bits;
    }
    this.col.n = n;
    const keepFrom = pos >>> 3;
    this.bitStart = pos & 7;
    this.len = total - keepFrom;
    if (this.data.length < this.len + 8) this.data = new Uint8Array(this.len + 8);
    this.data.set(d.subarray(keepFrom, total), 0);
  }
}

function makeDecoder(f) {
  if ((f.type === 'Integer' || f.type === 'ScaledInteger') && (f.min === undefined || f.max === undefined)) {
    throw new Error(`Champ E57 « ${f.name} » sans bornes minimum/maximum (entier 64 bits) : non pris en charge.`);
  }
  if (f.type === 'Float') return new FloatDecoder(f.precision === 'single' ? 4 : 8);
  if (f.type === 'Integer') return new IntDecoder(f.min ?? 0, f.max ?? 0, 1, 0);
  if (f.type === 'ScaledInteger') return new IntDecoder(f.min ?? 0, f.max ?? 0, f.scale ?? 1, f.offset ?? 0);
  throw new Error(`Type de champ E57 non pris en charge : ${f.type}`);
}

// ---------- extraction des métadonnées du XML ----------

function readPose(node) {
  const pose = { q: [1, 0, 0, 0], t: [0, 0, 0], present: false };
  const p = child(node, 'pose');
  if (!p) return pose;
  const r = child(p, 'rotation');
  const t = child(p, 'translation');
  if (r) { pose.q = [num(r, 'w', 1), num(r, 'x', 0), num(r, 'y', 0), num(r, 'z', 0)]; pose.present = true; }
  if (t) { pose.t = [num(t, 'x', 0), num(t, 'y', 0), num(t, 'z', 0)]; pose.present = true; }
  const n = Math.hypot(...pose.q) || 1;
  pose.q = pose.q.map((v) => v / n);
  return pose;
}

function parseField(node) {
  const a = node.attrs;
  const f = { name: node.name, type: a.type };
  if (a.precision) f.precision = a.precision;
  if (a.minimum !== undefined) f.min = parseFloat(a.minimum);
  if (a.maximum !== undefined) f.max = parseFloat(a.maximum);
  if (a.scale !== undefined) f.scale = parseFloat(a.scale);
  if (a.offset !== undefined) f.offset = parseFloat(a.offset);
  return f;
}

function readBounds(node, names) {
  const b = child(node, names.tag);
  if (!b) return null;
  const v = names.keys.map((k) => num(b, k));
  return v.every((x) => x !== null) ? v : null;
}

function describeData3D(node, index) {
  const pts = child(node, 'points');
  const proto = child(pts, 'prototype');
  const fields = proto ? proto.children.map(parseField) : [];
  const byName = Object.fromEntries(fields.map((f) => [f.name, f]));
  return {
    index,
    guid: text(node, 'guid'),
    name: text(node, 'name') || `Scan ${index + 1}`,
    description: text(node, 'description'),
    sensor: [text(node, 'sensorVendor'), text(node, 'sensorModel')].filter(Boolean).join(' '),
    pose: readPose(node),
    bounds: readBounds(node, { tag: 'cartesianBounds', keys: ['xMinimum', 'yMinimum', 'zMinimum', 'xMaximum', 'yMaximum', 'zMaximum'] }),
    intensityLimits: readBounds(node, { tag: 'intensityLimits', keys: ['intensityMinimum', 'intensityMaximum'] }),
    colorLimits: readBounds(node, { tag: 'colorLimits', keys: ['colorRedMinimum', 'colorRedMaximum'] }),
    indexBounds: readBounds(node, { tag: 'indexBounds', keys: ['rowMinimum', 'rowMaximum', 'columnMinimum', 'columnMaximum'] }),
    recordCount: pts ? parseInt(pts.attrs.recordCount || '0', 10) : 0,
    fileOffset: pts ? parseInt(pts.attrs.fileOffset || '0', 10) : 0,
    fields,
    byName,
    hasCartesian: !!(byName.cartesianX && byName.cartesianY && byName.cartesianZ),
    hasSpherical: !!(byName.sphericalRange && byName.sphericalAzimuth && byName.sphericalElevation),
    hasGrid: !!(byName.rowIndex && byName.columnIndex),
    hasColor: !!(byName.colorRed && byName.colorGreen && byName.colorBlue),
    hasIntensity: !!byName.intensity,
  };
}

function quatToMatrix([w, x, y, z]) {
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
  ];
}

// ---------- lecture du vecteur compressé ----------

async function streamPoints(pf, scan, collector, extra, onProgress) {
  const fields = scan.fields;
  const dec = fields.map(makeDecoder);
  const idx = (n) => fields.findIndex((f) => f.name === n);
  const iX = idx('cartesianX'), iY = idx('cartesianY'), iZ = idx('cartesianZ');
  const iRg = idx('sphericalRange'), iAz = idx('sphericalAzimuth'), iEl = idx('sphericalElevation');
  const iInvC = idx('cartesianInvalidState'), iInvS = idx('sphericalInvalidState');
  const iR = idx('colorRed'), iG = idx('colorGreen'), iB = idx('colorBlue'), iI = idx('intensity');
  const useCart = iX >= 0 && iY >= 0 && iZ >= 0;
  if (!useCart && !(iRg >= 0 && iAz >= 0 && iEl >= 0)) throw new Error(`Scan « ${scan.name} » : ni coordonnées cartésiennes ni sphériques.`);
  const R = quatToMatrix(scan.pose.q);
  const T = scan.pose.t;
  const isConst = dec.map((d) => d.constant);
  const live = dec.map((d, i) => i).filter((i) => !isConst[i]);

  const sectionLogical = pf.physToLogical(scan.fileOffset);
  const sec = await pf.read(sectionLogical, 32);
  const sdv = new DataView(sec.buffer, sec.byteOffset, sec.byteLength);
  if (sec[0] !== 1) throw new Error('Section binaire E57 invalide (identifiant de section ≠ 1).');
  const dataPhys = Number(sdv.getBigUint64(16, true));
  let pos = pf.physToLogical(dataPhys);
  const logicalEnd = pf.logicalSize;

  const BLOCK = 8 * 1024 * 1024;
  let buf = new Uint8Array(0);
  let bufStart = 0;
  const ensure = async (p, len) => {
    if (p >= bufStart && p + len <= bufStart + buf.length) return;
    bufStart = p;
    buf = await pf.read(p, Math.min(Math.max(len, BLOCK), logicalEnd - p));
    if (buf.length < len) throw new Error('Fin de fichier E57 inattendue pendant la lecture des paquets.');
  };

  const total = scan.recordCount;
  let emitted = 0;
  const ci = (i) => (i >= 0 ? dec[i] : null);
  while (emitted < total) {
    await ensure(pos, 4);
    let o = pos - bufStart;
    const type = buf[o];
    const len = (buf[o + 2] | (buf[o + 3] << 8)) + 1;
    await ensure(pos, len);
    o = pos - bufStart;
    if (type === 1) {
      const nStreams = buf[o + 4] | (buf[o + 5] << 8);
      let sp = o + 6 + nStreams * 2;
      for (let s = 0; s < nStreams && s < dec.length; s++) {
        const bl = buf[o + 6 + s * 2] | (buf[o + 7 + s * 2] << 8);
        dec[s].push(buf.subarray(sp, sp + bl));
        sp += bl;
      }
      // nombre d'enregistrements complets disponibles
      let n = Infinity;
      for (const i of live) if (dec[i].col.n < n) n = dec[i].col.n;
      if (!Number.isFinite(n)) n = total - emitted; // tous les champs sont constants
      n = Math.min(n, total - emitted);
      if (n > 0) {
        const aX = ci(iX)?.col.a, aY = ci(iY)?.col.a, aZ = ci(iZ)?.col.a;
        const aRg = ci(iRg)?.col.a, aAz = ci(iAz)?.col.a, aEl = ci(iEl)?.col.a;
        const aIc = ci(iInvC)?.col.a, aIs = ci(iInvS)?.col.a;
        const aR = ci(iR)?.col.a, aG = ci(iG)?.col.a, aB = ci(iB)?.col.a, aI = ci(iI)?.col.a;
        const cv = (i, arr, k) => (isConst[i] ? dec[i].constValue : arr[k]);
        for (let k = 0; k < n; k++) {
          if (iInvC >= 0 && cv(iInvC, aIc, k) !== 0) continue;
          if (!useCart && iInvS >= 0 && cv(iInvS, aIs, k) !== 0) continue;
          if (!collector.accept()) continue;
          let x, y, z;
          if (useCart) { x = cv(iX, aX, k); y = cv(iY, aY, k); z = cv(iZ, aZ, k); }
          else {
            const rr = cv(iRg, aRg, k), az = cv(iAz, aAz, k), el = cv(iEl, aEl, k);
            const ce = Math.cos(el);
            x = rr * ce * Math.cos(az); y = rr * ce * Math.sin(az); z = rr * Math.sin(el);
          }
          const gx = R[0] * x + R[1] * y + R[2] * z + T[0];
          const gy = R[3] * x + R[4] * y + R[5] * z + T[1];
          const gz = R[6] * x + R[7] * y + R[8] * z + T[2];
          collector.add(
            gx, gy, gz,
            iR >= 0 ? cv(iR, aR, k) : 0, iG >= 0 ? cv(iG, aG, k) : 0, iB >= 0 ? cv(iB, aB, k) : 0,
            iI >= 0 ? cv(iI, aI, k) : 0,
          );
        }
        for (const i of live) dec[i].col.consume(n);
        emitted += n;
      }
    }
    pos += len;
    if (pos >= logicalEnd) break;
    onProgress(Math.min(1, emitted / total));
  }
  return emitted;
}

// ---------- images 2D ----------

async function readBlob(pf, node) {
  if (!node) return null;
  const phys = parseInt(node.attrs.fileOffset || '0', 10);
  const length = parseInt(node.attrs.length || '0', 10);
  if (!phys || !length) return null;
  return pf.read(pf.physToLogical(phys) + 16, length); // 16 o = en-tête de section blob
}

async function readImages(pf, root, scans, warnings) {
  const out = [];
  const list = child(root, 'images2D');
  if (!list) return { images: out, skipped: 0 };
  let skipped = 0;
  for (const [i, im] of childrenNamed(list, 'vectorChild').entries()) {
    const rep = ['sphericalRepresentation', 'pinholeRepresentation', 'cylindricalRepresentation', 'visualReferenceRepresentation']
      .map((n) => child(im, n)).find(Boolean);
    const repName = rep?.name;
    if (repName !== 'sphericalRepresentation') { skipped++; continue; }
    const jpeg = child(rep, 'jpegImage'), png = child(rep, 'pngImage');
    const blob = jpeg || png;
    if (!blob) { skipped++; continue; }
    const bytes = await readBlob(pf, blob);
    if (!bytes || !bytes.length) { skipped++; continue; }
    const guid = text(im, 'associatedData3DGuid');
    const scan = scans.find((s) => s.guid && s.guid === guid) ?? null;
    out.push({
      name: text(im, 'name') || `Panoramique ${i + 1}`,
      mime: jpeg ? 'image/jpeg' : 'image/png',
      bytes,
      width: num(rep, 'imageWidth'),
      height: num(rep, 'imageHeight'),
      pose: readPose(im),
      stationIndex: scan ? scan.index : null,
      kind: 'spherical',
    });
  }
  return { images: out, skipped };
}

// ---------- point d'entrée ----------

export async function readE57(file, opts = {}, onProgress = () => {}) {
  const budget = opts.budget ?? Infinity;
  const hd = new Uint8Array(await file.slice(0, 48).arrayBuffer());
  const dv = new DataView(hd.buffer);
  if (String.fromCharCode(hd[0], hd[1], hd[2], hd[3]) !== 'ASTF') throw new Error("Signature « ASTF » absente : ce n'est pas un fichier E57.");
  const verMajor = dv.getUint32(4, true), verMinor = dv.getUint32(8, true);
  const xmlPhys = Number(dv.getBigUint64(24, true));
  const xmlLen = Number(dv.getBigUint64(32, true));
  const pf = new PagedFile(file);
  const xmlBytes = await pf.read(pf.physToLogical(xmlPhys), xmlLen);
  const xml = parseXml(new TextDecoder('utf-8').decode(xmlBytes));
  const root = child(xml, 'e57Root');
  if (!root) throw new Error('XML E57 invalide (élément e57Root manquant).');
  const d3 = child(root, 'data3D');
  const scans = childrenNamed(d3, 'vectorChild').map(describeData3D).filter((s) => s.recordCount > 0);
  if (!scans.length) throw new Error('Aucun scan avec des points (data3D vide).');
  const warnings = [];
  const totalRecords = scans.reduce((a, s) => a + s.recordCount, 0);

  const { images, skipped } = await readImages(pf, root, scans, warnings);
  if (skipped) warnings.push(`${skipped} image(s) 2D non sphérique(s) ignorée(s) (seuls les panoramiques équirectangulaires sont gérés).`);

  const clouds = [];
  let done = 0;
  for (const scan of scans) {
    const hint = scan.pose.t;
    const colMax = scan.colorLimits ? scan.colorLimits[1] : scan.byName.colorRed?.max ?? 255;
    const col = new PointCollector({
      expected: scan.recordCount,
      // la part de budget de chaque scan est proportionnelle à sa taille
      budget: Math.max(1000, Math.round(budget * (scan.recordCount / totalRecords))),
      offsetHint: hint, hasColor: scan.hasColor, hasIntensity: scan.hasIntensity,
    });
    await streamPoints(pf, scan, col, {}, (f) => onProgress((done + f * scan.recordCount) / totalRecords, `Scan « ${scan.name} »…`));
    done += scan.recordCount;
    let iRange = null;
    if (scan.intensityLimits) iRange = scan.intensityLimits;
    else if (scan.byName.intensity && scan.byName.intensity.max !== undefined && scan.byName.intensity.max > (scan.byName.intensity.min ?? 0)) {
      const f = scan.byName.intensity;
      iRange = [f.type === 'ScaledInteger' ? f.min * (f.scale ?? 1) + (f.offset ?? 0) : f.min ?? 0, f.type === 'ScaledInteger' ? f.max * (f.scale ?? 1) + (f.offset ?? 0) : f.max];
    }
    const out = col.finish({ colorMax: scan.hasColor ? colMax : null, intensityRange: iRange });
    const quat = [scan.pose.q[1], scan.pose.q[2], scan.pose.q[3], scan.pose.q[0]]; // x y z w
    clouds.push({
      name: scan.name,
      ...out,
      station: scan.pose.present ? { name: scan.name, position: scan.pose.t.slice(), quaternion: quat } : null,
      scanIndex: scan.index,
      meta: {
        guid: scan.guid, capteur: scan.sensor, pointsSource: scan.recordCount,
        grille: scan.indexBounds ? `${scan.indexBounds[1] + 1} lignes × ${scan.indexBounds[3] + 1} colonnes` : null,
        coordonnees: scan.hasCartesian ? 'cartésiennes' : 'sphériques (converties)',
      },
    });
  }

  // images : rattachement à la station ; la pose de l'image prime sur celle du scan
  const imgOut = images.map((im) => {
    const cloud = im.stationIndex !== null ? clouds.find((c) => c.scanIndex === im.stationIndex) : null;
    const q = im.pose.present
      ? [im.pose.q[1], im.pose.q[2], im.pose.q[3], im.pose.q[0]]
      : cloud?.station?.quaternion ?? [0, 0, 0, 1];
    return { ...im, stationIndex: cloud ? clouds.indexOf(cloud) : null, quaternion: q, position: im.pose.present ? im.pose.t : cloud?.station?.position ?? null };
  });
  // une image par station (la plus grande)
  const seen = new Map();
  const images2 = [];
  for (const im of imgOut) {
    if (im.stationIndex === null) { images2.push(im); continue; }
    const prev = seen.get(im.stationIndex);
    if (!prev || (im.width || 0) > (prev.width || 0)) seen.set(im.stationIndex, im);
  }
  for (const im of seen.values()) images2.push(im);

  const reasons = [];
  if (scans.length > 1) reasons.push(`${scans.length} scans (Data3D)`);
  if (scans.some((s) => s.pose.present)) reasons.push('poses de stations');
  if (scans.some((s) => s.hasGrid)) reasons.push('grille ligne/colonne');
  if (scans.some((s) => s.hasSpherical && !s.hasCartesian)) reasons.push('coordonnées sphériques');
  if (images.length) reasons.push(`${images.length} panoramique(s) 360° intégré(s)`);
  const structured = reasons.length > 0;

  return {
    format: 'E57',
    structure: { type: structured ? 'structuré' : 'non structuré', reasons },
    info: {
      version: `${verMajor}.${verMinor}`,
      scans: scans.length,
      pointsSource: totalRecords,
      champs: [...new Set(scans.flatMap((s) => s.fields.map((f) => f.name)))].join(', '),
    },
    clouds,
    images: images2,
    warnings,
  };
}
