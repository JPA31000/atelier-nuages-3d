// Générateur E57 pour les tests (et pour l'export éventuel) : pages de 1024 o avec CRC32C,
// sections binaires de paquets de données, XML final, blobs d'images.
// Les flux d'octets sont volontairement coupés à des positions d'octets arbitraires
// (valeurs à cheval entre deux paquets, champs de progression inégale) pour éprouver le lecteur.

const PAGE = 1024, PAYLOAD = 1020;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32c = (b) => {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
};

const phys = (l) => Math.floor(l / PAYLOAD) * PAGE + (l % PAYLOAD);

function packBits(values, bits) {
  const out = new Uint8Array(Math.ceil((values.length * bits) / 8) + 8);
  let pos = 0;
  for (const v0 of values) {
    let v = BigInt(v0);
    for (let b = 0; b < bits; b++) {
      if ((v >> BigInt(b)) & 1n) out[pos >> 3] |= 1 << (pos & 7);
      pos++;
    }
  }
  return out.subarray(0, Math.ceil((values.length * bits) / 8));
}

const f32 = (arr) => { const b = new Uint8Array(arr.length * 4); const dv = new DataView(b.buffer); arr.forEach((v, i) => dv.setFloat32(i * 4, v, true)); return b; };
const f64 = (arr) => { const b = new Uint8Array(arr.length * 8); const dv = new DataView(b.buffer); arr.forEach((v, i) => dv.setFloat64(i * 8, v, true)); return b; };

/** Construit les champs d'un scan : [{name, xml, stream(Uint8Array), bits|bytesPerValue}] */
function encodeScan(sc) {
  const n = sc.points.x.length;
  const fields = [];
  const scaled = sc.encoding !== 'float';
  const mkCoord = (name, arr) => {
    if (!scaled) {
      return { name, xml: `<${name} type="Float" precision="single" minimum="${Math.min(...arr)}" maximum="${Math.max(...arr)}"/>`, stream: f32(arr), unit: 32 };
    }
    const scale = 0.0005;
    const ints = Array.from(arr, (v) => Math.round(v / scale));
    const mn = Math.min(...ints), mx = Math.max(...ints);
    const bits = Math.max(1, Math.ceil(Math.log2(mx - mn + 1)));
    return { name, xml: `<${name} type="ScaledInteger" minimum="${mn}" maximum="${mx}" scale="${scale}" offset="0"/>`, stream: packBits(ints.map((v) => v - mn), bits), unit: bits };
  };
  if (sc.spherical) {
    const r = [], az = [], el = [];
    for (let i = 0; i < n; i++) {
      const x = sc.points.x[i], y = sc.points.y[i], z = sc.points.z[i];
      const rr = Math.hypot(x, y, z);
      r.push(rr); az.push(Math.atan2(y, x)); el.push(Math.asin(z / rr));
    }
    fields.push({ name: 'sphericalRange', xml: `<sphericalRange type="Float" precision="double" minimum="0" maximum="500"/>`, stream: f64(r), unit: 64 });
    fields.push({ name: 'sphericalAzimuth', xml: `<sphericalAzimuth type="Float" precision="double" minimum="-3.2" maximum="3.2"/>`, stream: f64(az), unit: 64 });
    fields.push({ name: 'sphericalElevation', xml: `<sphericalElevation type="Float" precision="double" minimum="-1.6" maximum="1.6"/>`, stream: f64(el), unit: 64 });
  } else {
    fields.push(mkCoord('cartesianX', sc.points.x), mkCoord('cartesianY', sc.points.y), mkCoord('cartesianZ', sc.points.z));
  }
  if (sc.points.r) {
    for (const [nm, arr] of [['colorRed', sc.points.r], ['colorGreen', sc.points.g], ['colorBlue', sc.points.b]]) {
      fields.push({ name: nm, xml: `<${nm} type="Integer" minimum="0" maximum="255"/>`, stream: packBits(Array.from(arr), 8), unit: 8 });
    }
  }
  if (sc.points.intensity) {
    fields.push({ name: 'intensity', xml: `<intensity type="Float" precision="single" minimum="0" maximum="1"/>`, stream: f32(Array.from(sc.points.intensity)), unit: 32 });
  }
  // champ constant (0 bit) : état invalide Cartésien toujours 0 → aucun octet dans le flux
  fields.push({ name: 'cartesianInvalidState', xml: `<cartesianInvalidState type="Integer" minimum="0" maximum="0"/>`, stream: new Uint8Array(0), unit: 0 });
  return { fields, n };
}

function buildPackets(enc, recordsPerPacket) {
  const { fields, n } = enc;
  const packets = [];
  let r0 = 0;
  while (r0 < n) {
    const r1 = Math.min(n, r0 + recordsPerPacket);
    const last = r1 === n;
    const bufs = fields.map((f) => {
      if (f.unit === 0) return new Uint8Array(0);
      const from = Math.floor((r0 * f.unit) / 8);
      const to = last ? f.stream.length : Math.floor((r1 * f.unit) / 8);
      return f.stream.subarray(from, to);
    });
    const dataLen = bufs.reduce((a, b) => a + b.length, 0);
    let len = 6 + 2 * bufs.length + dataLen;
    const pad = (4 - (len % 4)) % 4;
    len += pad;
    const p = new Uint8Array(len);
    const dv = new DataView(p.buffer);
    p[0] = 1; p[1] = 0;
    dv.setUint16(2, len - 1, true);
    dv.setUint16(4, bufs.length, true);
    let o = 6;
    bufs.forEach((b) => { dv.setUint16(o, b.length, true); o += 2; });
    bufs.forEach((b) => { p.set(b, o); o += b.length; });
    packets.push(p);
    r0 = r1;
  }
  return packets;
}

/**
 * @param {{scans: Array, images?: Array}} spec
 * scans[i] = {name, guid, pose?:{q:[w,x,y,z], t:[x,y,z]}, points:{x,y,z,r?,g?,b?,intensity?}, encoding?:'scaled'|'float', spherical?:bool, recordsPerPacket?:number}
 * images[i] = {name, scanGuid, bytes:Uint8Array, width, height, pose?}
 */
export function buildE57({ scans, images = [] }) {
  const chunks = []; // {logical, bytes}
  let logical = 48; // l'en-tête (48 o) occupe le début de la page 0
  const put = (bytes) => { const at = logical; chunks.push({ at, bytes }); logical += bytes.length; return at; };
  const align4 = () => { while (logical % 4) { chunks.push({ at: logical, bytes: new Uint8Array(1) }); logical++; } };

  const scanInfo = scans.map((sc) => {
    const enc = encodeScan(sc);
    const packets = buildPackets(enc, sc.recordsPerPacket ?? 333);
    align4();
    const start = logical;
    const body = packets.reduce((a, p) => a + p.length, 0);
    const head = new Uint8Array(32);
    const dv = new DataView(head.buffer);
    head[0] = 1;
    dv.setBigUint64(8, BigInt(32 + body), true);
    dv.setBigUint64(16, BigInt(phys(start + 32)), true);
    put(head);
    packets.forEach(put);
    return { sc, enc, fileOffset: phys(start) };
  });

  const imageInfo = images.map((im) => {
    align4();
    const start = logical;
    const padded = Math.ceil(im.bytes.length / 4) * 4;
    const head = new Uint8Array(16);
    new DataView(head.buffer).setBigUint64(8, BigInt(16 + padded), true);
    put(head);
    const data = new Uint8Array(padded); data.set(im.bytes);
    put(data);
    return { im, fileOffset: phys(start) };
  });

  const poseXml = (p) => (p
    ? `<pose type="Structure"><rotation type="Structure"><w type="Float">${p.q[0]}</w><x type="Float">${p.q[1]}</x><y type="Float">${p.q[2]}</y><z type="Float">${p.q[3]}</z></rotation><translation type="Structure"><x type="Float">${p.t[0]}</x><y type="Float">${p.t[1]}</y><z type="Float">${p.t[2]}</z></translation></pose>`
    : '');
  let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<e57Root type="Structure" xmlns="http://www.astm.org/COMMITTEE/E57/2010-e57-v1.0">\n<formatName type="String"><![CDATA[ASTM E57 3D Image File Format Standard]]></formatName>\n<guid type="String"><![CDATA[{TEST-FILE}]]></guid>\n<data3D type="Vector" allowHeterogeneousChildren="1">\n`;
  for (const si of scanInfo) {
    const { sc, enc } = si;
    xml += `<vectorChild type="Structure"><guid type="String"><![CDATA[${sc.guid}]]></guid><name type="String"><![CDATA[${sc.name}]]></name>${poseXml(sc.pose)}`;
    if (sc.points.r) xml += `<colorLimits type="Structure"><colorRedMinimum type="Integer">0</colorRedMinimum><colorRedMaximum type="Integer">255</colorRedMaximum></colorLimits>`;
    if (sc.grid) xml += `<indexBounds type="Structure"><rowMinimum type="Integer">0</rowMinimum><rowMaximum type="Integer">${sc.grid[0] - 1}</rowMaximum><columnMinimum type="Integer">0</columnMinimum><columnMaximum type="Integer">${sc.grid[1] - 1}</columnMaximum></indexBounds>`;
    xml += `<points type="CompressedVector" fileOffset="${si.fileOffset}" recordCount="${enc.n}"><prototype type="Structure">${enc.fields.map((f) => f.xml).join('')}</prototype><codecs type="Vector" allowHeterogeneousChildren="1"/></points></vectorChild>\n`;
  }
  xml += `</data3D>\n<images2D type="Vector" allowHeterogeneousChildren="1">\n`;
  for (const ii of imageInfo) {
    const im = ii.im;
    xml += `<vectorChild type="Structure"><guid type="String"><![CDATA[${im.name}-guid]]></guid><name type="String"><![CDATA[${im.name}]]></name><associatedData3DGuid type="String"><![CDATA[${im.scanGuid}]]></associatedData3DGuid>${poseXml(im.pose)}<sphericalRepresentation type="Structure"><jpegImage type="Blob" fileOffset="${ii.fileOffset}" length="${im.bytes.length}"/><imageWidth type="Integer">${im.width}</imageWidth><imageHeight type="Integer">${im.height}</imageHeight><pixelWidth type="Float">${(2 * Math.PI) / im.width}</pixelWidth><pixelHeight type="Float">${Math.PI / im.height}</pixelHeight></sphericalRepresentation></vectorChild>\n`;
  }
  xml += `</images2D>\n</e57Root>\n`;
  const xmlBytes = new TextEncoder().encode(xml);
  align4();
  const xmlLogical = logical;
  put(xmlBytes);

  // pagination
  const pages = Math.ceil(logical / PAYLOAD);
  const logicalBuf = new Uint8Array(pages * PAYLOAD);
  const header = new Uint8Array(48);
  const hv = new DataView(header.buffer);
  header.set(new TextEncoder().encode('ASTF'), 0);
  hv.setUint32(4, 1, true); hv.setUint32(8, 0, true);
  hv.setBigUint64(16, BigInt(pages * PAGE), true);
  hv.setBigUint64(24, BigInt(phys(xmlLogical)), true);
  hv.setBigUint64(32, BigInt(xmlBytes.length), true);
  hv.setBigUint64(40, BigInt(PAGE), true);
  logicalBuf.set(header, 0);
  for (const c of chunks) logicalBuf.set(c.bytes, c.at);
  const file = new Uint8Array(pages * PAGE);
  for (let p = 0; p < pages; p++) {
    const payload = logicalBuf.subarray(p * PAYLOAD, (p + 1) * PAYLOAD);
    file.set(payload, p * PAGE);
    new DataView(file.buffer).setUint32(p * PAGE + PAYLOAD, crc32c(payload), false);
  }
  return file;
}
