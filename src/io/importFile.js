// Point d'entrée commun des lecteurs (utilisé par le Web Worker et par les tests Node).

import { detectFormat } from './detect.js';
import { readLas } from './las.js';
import { readE57 } from './e57.js';
import { readPly } from './ply.js';
import { readXyz } from './xyz.js';

/**
 * @param {File} file
 * @param {{budget?:number, getLazPerf?:Function}} opts
 * @param {(fraction:number, label?:string)=>void} onProgress
 */
export async function importFile(file, opts = {}, onProgress = () => {}) {
  const det = await detectFormat(file);
  switch (det.kind) {
    case 'las':
    case 'laz':
      return readLas(file, opts, onProgress);
    case 'e57':
      return readE57(file, opts, onProgress);
    case 'ply':
      return readPly(file, opts, onProgress);
    case 'xyz':
      return readXyz(file, det.ext, opts, onProgress);
    default:
      throw new Error(`Format non reconnu : ${file.name}`);
  }
}
