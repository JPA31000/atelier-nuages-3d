// Détection automatique du format : signature (« magic bytes ») d'abord, extension ensuite.

const TEXT_EXT = new Set(['xyz', 'pts', 'txt', 'csv', 'asc', 'pwn']);
const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'webp']);

export const ACCEPTED_EXTENSIONS = ['las', 'laz', 'e57', 'ply', 'xyz', 'pts', 'txt', 'csv', 'asc', 'jpg', 'jpeg', 'png', 'webp'];

export function extOf(name) {
  const k = name.lastIndexOf('.');
  return k < 0 ? '' : name.slice(k + 1).toLowerCase();
}

/** @param {File|Blob} file */
export async function detectFormat(file) {
  const ext = extOf(file.name || '');
  const h = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const s4 = String.fromCharCode(h[0], h[1], h[2], h[3]);
  if (s4 === 'LASF') return { kind: ext === 'laz' ? 'laz' : 'las', ext }; // la compression réelle est lue dans les VLR
  if (s4 === 'ASTF') return { kind: 'e57', ext };
  if (s4 === 'ply\n' || (s4 === 'ply\r')) return { kind: 'ply', ext };
  if (h[0] === 0xff && h[1] === 0xd8) return { kind: 'image', ext };
  if (h[0] === 0x89 && s4.slice(1) === 'PNG') return { kind: 'image', ext };
  if (s4 === 'RIFF') return { kind: 'image', ext };
  if (IMAGE_EXT.has(ext)) return { kind: 'image', ext };
  if (TEXT_EXT.has(ext)) return { kind: 'xyz', ext };
  if (ext === 'las' || ext === 'laz') return { kind: ext, ext };
  if (ext === 'e57') return { kind: 'e57', ext };
  if (ext === 'ply') return { kind: 'ply', ext };
  return { kind: 'unknown', ext };
}
