// Archive ZIP minimale (méthode « stockée », sans compression) — suffisante pour livrer un dossier.
// Limite : pas de ZIP64 (taille totale < 4 Go).

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(parts, crc = 0) {
  let c = ~crc >>> 0;
  for (const p of parts) for (let i = 0; i < p.length; i++) c = TABLE[(c ^ p[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

const enc = new TextEncoder();

/**
 * @param {Array<{name:string, parts:Uint8Array[]}>} entries
 * @returns {Uint8Array[]} parts de l'archive
 */
export function makeZip(entries) {
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const out = [];
  const central = [];
  let offset = 0;
  let total = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const size = e.parts.reduce((a, p) => a + p.length, 0);
    total += size;
    if (total > 4 * 1024 ** 3 - 1024) throw new Error('Archive trop volumineuse (> 4 Go) : exportez en plusieurs fois.');
    const crc = crc32(e.parts);
    const lh = new Uint8Array(30 + name.length);
    const dv = new DataView(lh.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 0x0800, true); // noms en UTF-8
    dv.setUint16(8, 0, true);
    dv.setUint16(10, dosTime, true); dv.setUint16(12, dosDate, true);
    dv.setUint32(14, crc, true); dv.setUint32(18, size, true); dv.setUint32(22, size, true);
    dv.setUint16(26, name.length, true); dv.setUint16(28, 0, true);
    lh.set(name, 30);
    out.push(lh, ...e.parts);
    const ch = new Uint8Array(46 + name.length);
    const cd = new DataView(ch.buffer);
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true); cd.setUint16(6, 20, true); cd.setUint16(8, 0x0800, true); cd.setUint16(10, 0, true);
    cd.setUint16(12, dosTime, true); cd.setUint16(14, dosDate, true);
    cd.setUint32(16, crc, true); cd.setUint32(20, size, true); cd.setUint32(24, size, true);
    cd.setUint16(28, name.length, true);
    cd.setUint32(42, offset, true);
    ch.set(name, 46);
    central.push(ch);
    offset += lh.length + size;
  }
  const cdSize = central.reduce((a, c) => a + c.length, 0);
  const end = new Uint8Array(22);
  const ed = new DataView(end.buffer);
  ed.setUint32(0, 0x06054b50, true);
  ed.setUint16(8, entries.length, true); ed.setUint16(10, entries.length, true);
  ed.setUint32(12, cdSize, true); ed.setUint32(16, offset, true);
  return [...out, ...central, end];
}
