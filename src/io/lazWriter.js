// Encodeur LAZ (LASzip « v2 », compression point par point, par blocs) — formats de points 0 et 2.
//
// laz-perf ne sait que DÉCOMPRESSER : ce module implémente le codeur arithmétique de LASzip
// (codeur d'intervalles 32 bits, modèles adaptatifs de bits/symboles, compresseur d'entiers) et
// les compresseurs d'éléments POINT10 et RGB12. Il est validé par relecture avec laz-perf
// (tests/laz.test.js) : tout fichier produit ici doit se décompresser à l'identique.
//
// Contrainte volontaire : retour 1/1, pas de GPS (format 0 ou 2) ; c'est ce que produit l'application.

import { lasHeaderAndLayout, buildLasHeader, lasRecords } from './writers.js';

const MIN_LENGTH = 0x01000000;
const BM_SHIFT = 13, BM_MAX = 1 << 13;
const DM_SHIFT = 15, DM_MAX = 1 << 15; // DM__MaxCount = 1 << DM__LengthShift (LASzip)
const TWO32 = 4294967296;

// ---------- modèles adaptatifs ----------

class BitModel {
  constructor() {
    this.bit0Count = 1; this.bitCount = 2; this.bit0Prob = 1 << (BM_SHIFT - 1);
    this.updateCycle = 4; this.untilUpdate = 4;
  }
  update() {
    if ((this.bitCount += this.updateCycle) > BM_MAX) {
      this.bitCount = (this.bitCount + 1) >>> 1;
      this.bit0Count = (this.bit0Count + 1) >>> 1;
      if (this.bit0Count === this.bitCount) ++this.bitCount;
    }
    const scale = Math.floor(0x80000000 / this.bitCount);
    this.bit0Prob = Math.floor((this.bit0Count * scale) / 2 ** (31 - BM_SHIFT));
    this.updateCycle = (5 * this.updateCycle) >>> 2;
    if (this.updateCycle > 64) this.updateCycle = 64;
    this.untilUpdate = this.updateCycle;
  }
}

class SymbolModel {
  constructor(symbols) {
    this.symbols = symbols;
    this.lastSymbol = symbols - 1;
    this.dist = new Uint32Array(symbols);
    this.count = new Uint32Array(symbols).fill(1);
    this.total = 0;
    this.updateCycle = symbols;
    this.update();
    this.updateCycle = (symbols + 6) >>> 1;
    this.untilUpdate = this.updateCycle;
  }
  update() {
    if ((this.total += this.updateCycle) > DM_MAX) {
      this.total = 0;
      for (let n = 0; n < this.symbols; n++) this.total += (this.count[n] = (this.count[n] + 1) >>> 1);
    }
    let sum = 0;
    const scale = Math.floor(0x80000000 / this.total);
    for (let k = 0; k < this.symbols; k++) {
      this.dist[k] = Math.floor((scale * sum) / 2 ** (31 - DM_SHIFT));
      sum += this.count[k];
    }
    this.updateCycle = (5 * this.updateCycle) >>> 2;
    const maxCycle = (this.symbols + 6) << 3;
    if (this.updateCycle > maxCycle) this.updateCycle = maxCycle;
    this.untilUpdate = this.updateCycle;
  }
}

// ---------- codeur arithmétique ----------

class ArithEncoder {
  constructor() { this.buf = new Uint8Array(1 << 16); this.n = 0; this.base = 0; this.length = 0xffffffff; }
  init() { this.n = 0; this.base = 0; this.length = 0xffffffff; }
  _out(b) {
    if (this.n >= this.buf.length) { const nb = new Uint8Array(this.buf.length * 2); nb.set(this.buf); this.buf = nb; }
    this.buf[this.n++] = b;
  }
  _carry() {
    let p = this.n - 1;
    while (p > 0 && this.buf[p] === 0xff) { this.buf[p] = 0; p--; }
    this.buf[p]++;
  }
  _add(x) {
    this.base += x;
    if (this.base >= TWO32) { this.base -= TWO32; this._carry(); }
  }
  _renorm() {
    do {
      this._out(this.base >>> 24);
      this.base = (this.base << 8) >>> 0;
      this.length *= 256;
    } while (this.length < MIN_LENGTH);
  }
  encodeBit(m, bit) {
    const x = m.bit0Prob * (this.length >>> BM_SHIFT);
    if (bit === 0) { this.length = x; ++m.bit0Count; }
    else { this._add(x); this.length -= x; }
    if (this.length < MIN_LENGTH) this._renorm();
    if (--m.untilUpdate === 0) m.update();
  }
  encodeSymbol(m, sym) {
    let x;
    if (sym === m.lastSymbol) {
      x = m.dist[sym] * (this.length >>> DM_SHIFT);
      this._add(x);
      this.length -= x;
    } else {
      const l = this.length >>> DM_SHIFT;
      x = m.dist[sym] * l;
      this._add(x);
      this.length = m.dist[sym + 1] * l - x;
    }
    if (this.length < MIN_LENGTH) this._renorm();
    ++m.count[sym];
    if (--m.untilUpdate === 0) m.update();
  }
  writeBits(bits, sym) {
    if (bits > 19) { this.writeShort(sym & 0xffff); sym >>>= 16; bits -= 16; }
    this.length = this.length >>> bits;
    this._add(sym * this.length);
    if (this.length < MIN_LENGTH) this._renorm();
  }
  writeShort(sym) {
    this.length = this.length >>> 16;
    this._add(sym * this.length);
    if (this.length < MIN_LENGTH) this._renorm();
  }
  /** Termine le flux et renvoie les octets (avec les 2-3 octets nuls de synchronisation). */
  done() {
    let another = true;
    if (this.length > 2 * MIN_LENGTH) { this._add(MIN_LENGTH); this.length = MIN_LENGTH >>> 1; }
    else { this._add(MIN_LENGTH >>> 1); this.length = MIN_LENGTH >>> 9; another = false; }
    this._renorm();
    const out = new Uint8Array(this.n + (another ? 3 : 2));
    out.set(this.buf.subarray(0, this.n));
    return out;
  }
}

// ---------- compresseur d'entiers ----------

class IntegerCompressor {
  constructor(enc, bits = 16, contexts = 1, bitsHigh = 8) {
    this.enc = enc; this.bitsHigh = bitsHigh; this.k = 0;
    if (bits && bits < 32) { this.corrBits = bits; this.corrRange = 2 ** bits; }
    else { this.corrBits = 32; this.corrRange = 0; }
    this.corrMin = -Math.floor(this.corrRange / 2);
    this.corrMax = this.corrMin + this.corrRange - 1;
    this.mBits = Array.from({ length: contexts }, () => new SymbolModel(this.corrBits + 1));
    this.mCorr = [new BitModel()];
    for (let i = 1; i <= this.corrBits; i++) this.mCorr.push(new SymbolModel(i <= bitsHigh ? 1 << i : 1 << bitsHigh));
  }
  compress(pred, real, ctx) {
    let corr = (real - pred) | 0;
    if (this.corrRange) {
      if (corr < this.corrMin) corr += this.corrRange;
      else if (corr > this.corrMax) corr -= this.corrRange;
    }
    this._write(corr, this.mBits[ctx]);
  }
  _write(c, mBits) {
    const enc = this.enc;
    let k = 0;
    let c1 = c <= 0 ? -c : c - 1;
    while (c1) { c1 >>>= 1; k++; }
    this.k = k;
    enc.encodeSymbol(mBits, k);
    if (k) {
      if (k < 32) {
        c = c < 0 ? c + (2 ** k - 1) : c - 1;
        if (k <= this.bitsHigh) enc.encodeSymbol(this.mCorr[k], c);
        else {
          const k1 = k - this.bitsHigh;
          const low = c & ((1 << k1) - 1);
          enc.encodeSymbol(this.mCorr[k], Math.floor(c / 2 ** k1));
          enc.writeBits(k1, low);
        }
      }
    } else {
      enc.encodeBit(this.mCorr[0], c);
    }
  }
}

class StreamingMedian5 {
  constructor() { this.v = [0, 0, 0, 0, 0]; this.high = true; }
  get() { return this.v[2]; }
  add(x) {
    const v = this.v;
    if (this.high) {
      if (x < v[2]) {
        v[4] = v[3]; v[3] = v[2];
        if (x < v[0]) { v[2] = v[1]; v[1] = v[0]; v[0] = x; }
        else if (x < v[1]) { v[2] = v[1]; v[1] = x; }
        else v[2] = x;
      } else {
        if (x < v[3]) { v[4] = v[3]; v[3] = x; } else v[4] = x;
        this.high = false;
      }
    } else if (v[2] < x) {
      v[0] = v[1]; v[1] = v[2];
      if (v[4] < x) { v[2] = v[3]; v[3] = v[4]; v[4] = x; }
      else if (v[3] < x) { v[2] = v[3]; v[3] = x; }
      else v[2] = x;
    } else {
      if (v[1] < x) { v[0] = v[1]; v[1] = x; } else v[0] = x;
      this.high = true;
    }
  }
}

const fold8 = (n) => n & 255;
const clamp8 = (n) => (n < 0 ? 0 : n > 255 ? 255 : n);

// ---------- encodeur d'un bloc (chunk) ----------

class ChunkEncoder {
  constructor(hasRgb, recLen) {
    this.hasRgb = hasRgb; this.recLen = recLen;
    this.enc = new ArithEncoder();
  }

  /** Premier point du bloc : écrit en clair, puis (ré)initialise tous les modèles. */
  begin(rec, off) {
    const enc = this.enc;
    enc.init();
    this.raw = rec.slice(off, off + this.recLen);
    // POINT10
    this.lastItem = rec.slice(off, off + 20);
    this.lastItem[12] = 0; this.lastItem[13] = 0; // intensité mémorisée à part
    this.lastIntensity = new Uint16Array(16);
    this.medX = Array.from({ length: 16 }, () => new StreamingMedian5());
    this.medY = Array.from({ length: 16 }, () => new StreamingMedian5());
    this.lastHeight = new Int32Array(8);
    this.mChanged = new SymbolModel(64);
    this.icIntensity = new IntegerCompressor(enc, 16, 4);
    this.mScanAngle = [new SymbolModel(256), new SymbolModel(256)];
    this.icSourceId = new IntegerCompressor(enc, 16);
    this.mBitByte = new Array(256).fill(null);
    this.mClass = new Array(256).fill(null);
    this.mUser = new Array(256).fill(null);
    this.icDx = new IntegerCompressor(enc, 32, 2);
    this.icDy = new IntegerCompressor(enc, 32, 22);
    this.icZ = new IntegerCompressor(enc, 32, 20);
    this.lastPoint = {
      x: this._i32(rec, off), y: this._i32(rec, off + 4), z: this._i32(rec, off + 8),
      sourceId: rec[off + 18] | (rec[off + 19] << 8),
    };
    // RGB12
    if (this.hasRgb) {
      const o = off + 20;
      this.lastRgb = [rec[o] | (rec[o + 1] << 8), rec[o + 2] | (rec[o + 3] << 8), rec[o + 4] | (rec[o + 5] << 8)];
      this.mByteUsed = new SymbolModel(128);
      this.mDiff = Array.from({ length: 6 }, () => new SymbolModel(256));
    }
  }

  _i32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) | 0; }

  add(rec, off) {
    const enc = this.enc;
    // ---- POINT10 ----
    const bitByte = rec[off + 14];
    const r = bitByte & 7, n = (bitByte >> 3) & 7;
    const m = NUMBER_RETURN_MAP[n][r], l = NUMBER_RETURN_LEVEL[n][r];
    const intensity = rec[off + 12] | (rec[off + 13] << 8);
    const sourceId = rec[off + 18] | (rec[off + 19] << 8);
    const last = this.lastItem;
    const changed =
      ((last[14] !== bitByte ? 1 : 0) << 5) | ((this.lastIntensity[m] !== intensity ? 1 : 0) << 4) |
      ((last[15] !== rec[off + 15] ? 1 : 0) << 3) | ((last[16] !== rec[off + 16] ? 1 : 0) << 2) |
      ((last[17] !== rec[off + 17] ? 1 : 0) << 1) | (this.lastPoint.sourceId !== sourceId ? 1 : 0);
    enc.encodeSymbol(this.mChanged, changed);
    if (changed & 32) {
      if (!this.mBitByte[last[14]]) this.mBitByte[last[14]] = new SymbolModel(256);
      enc.encodeSymbol(this.mBitByte[last[14]], bitByte);
    }
    if (changed & 16) {
      this.icIntensity.compress(this.lastIntensity[m], intensity, m < 3 ? m : 3);
      this.lastIntensity[m] = intensity;
    }
    if (changed & 8) {
      if (!this.mClass[last[15]]) this.mClass[last[15]] = new SymbolModel(256);
      enc.encodeSymbol(this.mClass[last[15]], rec[off + 15]);
    }
    if (changed & 4) {
      const dir = (bitByte >> 6) & 1;
      enc.encodeSymbol(this.mScanAngle[dir], fold8(rec[off + 16] - last[16]));
    }
    if (changed & 2) {
      if (!this.mUser[last[17]]) this.mUser[last[17]] = new SymbolModel(256);
      enc.encodeSymbol(this.mUser[last[17]], rec[off + 17]);
    }
    if (changed & 1) this.icSourceId.compress(this.lastPoint.sourceId, sourceId, 0);

    const x = this._i32(rec, off), y = this._i32(rec, off + 4), z = this._i32(rec, off + 8);
    const lp = this.lastPoint;
    let diff = (x - lp.x) | 0;
    this.icDx.compress(this.medX[m].get(), diff, n === 1 ? 1 : 0);
    this.medX[m].add(diff);
    let kb = this.icDx.k;
    diff = (y - lp.y) | 0;
    this.icDy.compress(this.medY[m].get(), diff, (n === 1 ? 1 : 0) + (kb < 20 ? kb & 0xfffffffe : 20));
    this.medY[m].add(diff);
    kb = (this.icDx.k + this.icDy.k) >>> 1;
    this.icZ.compress(this.lastHeight[l], z, (n === 1 ? 1 : 0) + (kb < 18 ? kb & 0xfffffffe : 18));
    this.lastHeight[l] = z;
    for (let i = 14; i < 18; i++) last[i] = rec[off + i];
    lp.x = x; lp.y = y; lp.z = z; lp.sourceId = sourceId;

    // ---- RGB12 ----
    if (this.hasRgb) {
      const o = off + 20;
      const c = [rec[o] | (rec[o + 1] << 8), rec[o + 2] | (rec[o + 3] << 8), rec[o + 4] | (rec[o + 5] << 8)];
      const L = this.lastRgb;
      let sym = 0;
      sym |= ((L[0] & 0xff) !== (c[0] & 0xff) ? 1 : 0) << 0;
      sym |= ((L[0] & 0xff00) !== (c[0] & 0xff00) ? 1 : 0) << 1;
      sym |= ((L[1] & 0xff) !== (c[1] & 0xff) ? 1 : 0) << 2;
      sym |= ((L[1] & 0xff00) !== (c[1] & 0xff00) ? 1 : 0) << 3;
      sym |= ((L[2] & 0xff) !== (c[2] & 0xff) ? 1 : 0) << 4;
      sym |= ((L[2] & 0xff00) !== (c[2] & 0xff00) ? 1 : 0) << 5;
      sym |= (((c[0] & 0xff) !== (c[1] & 0xff)) || ((c[0] & 0xff) !== (c[2] & 0xff)) || ((c[0] & 0xff00) !== (c[1] & 0xff00)) || ((c[0] & 0xff00) !== (c[2] & 0xff00)) ? 1 : 0) << 6;
      enc.encodeSymbol(this.mByteUsed, sym);
      let dl = 0, dh = 0;
      if (sym & 1) { dl = (c[0] & 255) - (L[0] & 255); enc.encodeSymbol(this.mDiff[0], fold8(dl)); }
      if (sym & 2) { dh = (c[0] >> 8) - (L[0] >> 8); enc.encodeSymbol(this.mDiff[1], fold8(dh)); }
      if (sym & 64) {
        if (sym & 4) enc.encodeSymbol(this.mDiff[2], fold8((c[1] & 255) - clamp8(dl + (L[1] & 255))));
        if (sym & 16) {
          dl = Math.trunc((dl + ((c[1] & 255) - (L[1] & 255))) / 2);
          enc.encodeSymbol(this.mDiff[4], fold8((c[2] & 255) - clamp8(dl + (L[2] & 255))));
        }
        if (sym & 8) enc.encodeSymbol(this.mDiff[3], fold8((c[1] >> 8) - clamp8(dh + (L[1] >> 8))));
        if (sym & 32) {
          dh = Math.trunc((dh + ((c[1] >> 8) - (L[1] >> 8))) / 2);
          enc.encodeSymbol(this.mDiff[5], fold8((c[2] >> 8) - clamp8(dh + (L[2] >> 8))));
        }
      }
      this.lastRgb = c;
    }
  }

  /** Termine le bloc : point brut + octets arithmétiques. */
  end() {
    const tail = this.enc.done();
    const out = new Uint8Array(this.raw.length + tail.length);
    out.set(this.raw, 0);
    out.set(tail, this.raw.length);
    return out;
  }
}

const NUMBER_RETURN_MAP = [
  [15, 14, 13, 12, 11, 10, 9, 8],
  [14, 0, 1, 3, 6, 10, 10, 9],
  [13, 1, 2, 4, 7, 11, 11, 10],
  [12, 3, 4, 5, 8, 12, 12, 11],
  [11, 6, 7, 8, 9, 13, 13, 12],
  [10, 10, 11, 12, 13, 14, 14, 13],
  [9, 10, 11, 12, 13, 14, 15, 14],
  [8, 9, 10, 11, 12, 13, 14, 15],
];
const NUMBER_RETURN_LEVEL = [
  [0, 1, 2, 3, 4, 5, 6, 7],
  [1, 0, 1, 2, 3, 4, 5, 6],
  [2, 1, 0, 1, 2, 3, 4, 5],
  [3, 2, 1, 0, 1, 2, 3, 4],
  [4, 3, 2, 1, 0, 1, 2, 3],
  [5, 4, 3, 2, 1, 0, 1, 2],
  [6, 5, 4, 3, 2, 1, 0, 1],
  [7, 6, 5, 4, 3, 2, 1, 0],
];

// ---------- fichier LAZ ----------

function lazVlr(hasRgb) {
  const items = [[6, 20, 2]];
  if (hasRgb) items.push([8, 6, 2]);
  const body = new Uint8Array(34 + items.length * 6);
  const dv = new DataView(body.buffer);
  dv.setUint16(0, 2, true); // compresseur : point par point, par blocs
  dv.setUint16(2, 0, true); // codeur arithmétique
  body[4] = 3; body[5] = 4; dv.setUint16(6, 3, true); // version LASzip 3.4r3
  dv.setUint32(8, 0, true); // options
  dv.setUint32(12, 50000, true); // taille de bloc (écrasée par l'appelant)
  dv.setBigInt64(16, -1n, true); dv.setBigInt64(24, -1n, true);
  dv.setUint16(32, items.length, true);
  items.forEach((it, i) => { dv.setUint16(34 + i * 6, it[0], true); dv.setUint16(36 + i * 6, it[1], true); dv.setUint16(38 + i * 6, it[2], true); });
  const head = new Uint8Array(54);
  const hv = new DataView(head.buffer);
  head.set(new TextEncoder().encode('laszip encoded'), 2);
  hv.setUint16(18, 22204, true);
  hv.setUint16(20, body.length, true);
  head.set(new TextEncoder().encode('http://laszip.org'), 22);
  return { head, body };
}

/** Table des blocs : tailles compressées par IntegerCompressor(32 bits, 2 contextes), contexte 1. */
function chunkTable(sizes) {
  const enc = new ArithEncoder();
  const ic = new IntegerCompressor(enc, 32, 2);
  let pred = 0;
  for (const s of sizes) { ic.compress(pred, s, 1); pred = s; }
  const body = enc.done();
  const head = new Uint8Array(8);
  const dv = new DataView(head.buffer);
  dv.setUint32(0, 0, true); dv.setUint32(4, sizes.length, true);
  return [head, body];
}

/**
 * @returns {Uint8Array[]} parts d'un fichier .laz (LAS 1.2, format 0 ou 2)
 */
export function writeLaz(source, { scale = 0.001, chunkSize = 50000 } = {}, onProgress = () => {}) {
  const lay = lasHeaderAndLayout(source, { scale });
  const hasRgb = lay.format === 2;
  const header = buildLasHeader(source.total, lay);
  const { head: vlrHead, body: vlrBody } = lazVlr(hasRgb);
  new DataView(vlrBody.buffer).setUint32(12, chunkSize, true);
  const dv = new DataView(header.buffer);
  dv.setUint8(104, lay.format | 0x80);
  dv.setUint32(100, 1, true);
  const pointOffset = 227 + vlrHead.length + vlrBody.length;
  dv.setUint32(96, pointOffset, true);

  const chunks = [];
  const sizes = [];
  const ce = new ChunkEncoder(hasRgb, lay.recLen);
  let inChunk = 0;
  let done = 0;
  for (const ch of source.chunks()) {
    const recs = lasRecords(ch, lay);
    for (let i = 0; i < ch.n; i++) {
      const off = i * lay.recLen;
      if (inChunk === 0) ce.begin(recs, off);
      else ce.add(recs, off);
      inChunk++;
      if (inChunk === chunkSize) { const c = ce.end(); chunks.push(c); sizes.push(c.length); inChunk = 0; }
    }
    done += ch.n;
    onProgress(done / Math.max(1, source.total));
  }
  if (inChunk > 0) { const c = ce.end(); chunks.push(c); sizes.push(c.length); }

  const dataBytes = sizes.reduce((a, b) => a + b, 0);
  const tableStart = pointOffset + 8 + dataBytes;
  const offsetField = new Uint8Array(8);
  new DataView(offsetField.buffer).setBigInt64(0, BigInt(tableStart), true);
  return [header, vlrHead, vlrBody, offsetField, ...chunks, ...chunkTable(sizes)];
}
