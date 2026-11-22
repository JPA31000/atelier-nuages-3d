// Paquet « .rcp » : archive ZIP contenant un manifeste de projet .rcp, les scans associés (LAS)
// et, si disponibles, les panoramiques 360° et la table des stations.
//
// ⚠ Honnêteté sur les limites : un VRAI projet ReCap (.rcp + dossier .rcs) est un index propriétaire
// d'Autodesk (octree compressé, tuiles .rcs, métadonnées de scans). Aucune bibliothèque ouverte ne sait
// l'écrire depuis un navigateur. Ce paquet est donc un projet de TRANSFERT : un manifeste lisible + des
// scans LAS standard, à importer puis à indexer dans ReCap Pro (voir README_RCP.txt, généré dans l'archive).

import { makeExportSource, sourceBounds } from './exportSource.js';
import { writeLas } from './writers.js';
import { makeZip } from './zip.js';

const enc = new TextEncoder();
const esc = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
const safe = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'scan';
const f = (v, d = 4) => (Number.isFinite(v) ? v.toFixed(d) : '0');

export const RCP_README = (name) => `LIMITES DE L'EXPORT .RCP DEPUIS LE NAVIGATEUR
=============================================

Ce dossier a été produit par « Atelier Nuages 3D », entièrement dans votre navigateur.

CE QUE CONTIENT L'ARCHIVE
  ${name}.rcp          Manifeste du projet (texte XML) : liste des scans, étendues, stations,
                       transformations de recalage, panoramiques associés.
  scans/               Un fichier LAS (1.2) par nuage, en coordonnées GLOBALES d'origine (Float64 → entiers LAS
                       au millimètre), recalages appliqués.
  panoramiques/        Panoramiques 360° (si présents) et stations.csv (position + orientation).
  README_RCP.txt       Ce fichier.

CE QUE CE N'EST PAS
  Le fichier ${name}.rcp n'est PAS un projet ReCap indexé. Le format natif d'Autodesk ReCap (.rcp + dossier .rcs)
  est un index propriétaire (structure octree compressée, tuiles .rcs, miniatures, métadonnées de scans). Il ne peut
  être créé que par un logiciel Autodesk (ReCap Pro, ou ReCap Photo/Revit à l'import). Aucun outil ouvert ne sait
  l'écrire, donc aucune application web non plus. Ouvrir ce .rcp directement dans ReCap ou Revit ne fonctionnera pas.

COMMENT L'UTILISER AVEC RECAP / REVIT
  1. Ouvrir Autodesk ReCap Pro → « Nouveau projet ».
  2. « Ajouter des scans » : sélectionner tous les fichiers du dossier scans/ (LAS pris en charge).
  3. Lancer l'indexation : ReCap génère alors le vrai .rcp et le dossier .rcs.
  4. Dans Revit : Insérer → Nuage de points → choisir ce .rcp (ou lier directement les .rcs).
  Variante : Revit/Navisworks acceptent aussi directement un LAS ; l'indexation est alors faite à l'insertion.

POINTS D'ATTENTION
  - Les LAS sont dans le système de coordonnées d'origine de vos fichiers ; ReCap n'en connaît pas le code EPSG
    (indiquez-le dans ReCap si nécessaire, voir le manifeste → <CoordinateSystem>).
  - Un LAS ne porte pas les « positions de scan » ni les panoramiques : pour conserver les stations et les images
    dans ReCap, importez plutôt les E57 originaux (structurés) ; stations.csv et panoramiques/ vous permettent de
    retrouver les positions.
  - ZIP sans ZIP64 : taille maximale 4 Go.
`;

/**
 * @param {object} p
 * @param {string} p.projectName
 * @param {Array<{name:string, positions:Float32Array, colors, intensity, count:number, matrix:number[]|Float32Array|Float64Array, format?:string}>} p.clouds
 * @param {number[]} p.sceneOrigin
 * @param {Array<{name:string, position:number[], quaternion:number[], panoName:string|null}>} p.stations  position en coordonnées BRUTES
 * @param {Array<{fileName:string, bytes:Uint8Array}>} p.panoramas
 * @param {{scale?:number}} [p.options]
 */
export function buildRcpPackage({ projectName, clouds, sceneOrigin, stations = [], panoramas = [], options = {} }, onProgress = () => {}) {
  const name = safe(projectName || 'Projet');
  const entries = [];
  const scanXml = [];
  clouds.forEach((c, i) => {
    const source = makeExportSource([c], sceneOrigin);
    const file = `scans/Scan_${String(i + 1).padStart(3, '0')}_${safe(c.name)}.las`;
    const parts = writeLas(source, options, (f2) => onProgress((i + f2) / clouds.length));
    const b = sourceBounds(source);
    entries.push({ name: file, parts });
    scanXml.push(
      `    <Scan id="${i + 1}" name="${esc(c.name)}" file="${esc(file)}" format="LAS 1.2" pointFormat="${source.hasColor ? 2 : 0}" points="${c.count}">\n` +
      `      <Bounds min="${b.min.map((v) => f(v, 3)).join(' ')}" max="${b.max.map((v) => f(v, 3)).join(' ')}"/>\n` +
      `      <RegistrationMatrixColumnMajor local-to-scene="${Array.from(c.matrix).map((v) => v.toPrecision(12)).join(' ')}"/>\n` +
      `    </Scan>`,
    );
  });
  const stationXml = stations.map((s) =>
    `    <Station name="${esc(s.name)}" x="${f(s.position[0], 4)}" y="${f(s.position[1], 4)}" z="${f(s.position[2], 4)}" quaternionXYZW="${s.quaternion.map((v) => f(v, 8)).join(' ')}"` +
    `${s.panoName ? ` panorama="panoramiques/${esc(s.panoName)}"` : ''}/>`);
  const manifest =
`<?xml version="1.0" encoding="UTF-8"?>
<!--
  MANIFESTE DE PROJET — Atelier Nuages 3D
  Ce fichier n'est PAS un index ReCap natif (.rcp/.rcs propriétaires Autodesk).
  Il décrit les scans à importer dans ReCap Pro, qui produira lui-même le vrai .rcp. Voir README_RCP.txt.
-->
<RecapTransferProject generator="Atelier Nuages 3D" manifestVersion="1.0" nativeRecapIndex="false">
  <Project name="${esc(projectName || 'Projet')}" created="${new Date().toISOString()}"/>
  <CoordinateSystem epsg="" sceneOrigin="${sceneOrigin.map((v) => f(v, 4)).join(' ')}" note="Coordonnées LAS = coordonnées brutes d'origine (scène + origine)."/>
  <Scans count="${clouds.length}">
${scanXml.join('\n')}
  </Scans>
  <Stations count="${stations.length}">
${stationXml.join('\n')}
  </Stations>
</RecapTransferProject>
`;
  entries.unshift({ name: `${name}.rcp`, parts: [enc.encode(manifest)] });
  entries.push({ name: 'README_RCP.txt', parts: [enc.encode(RCP_README(name))] });
  if (stations.length) {
    const csv = ['nom;x;y;z;qx;qy;qz;qw;panoramique', ...stations.map((s) => [s.name, ...s.position.map((v) => f(v, 4)), ...s.quaternion.map((v) => f(v, 8)), s.panoName ?? ''].join(';'))].join('\n') + '\n';
    entries.push({ name: 'panoramiques/stations.csv', parts: [enc.encode(csv)] });
  }
  for (const p of panoramas) entries.push({ name: `panoramiques/${p.fileName}`, parts: [p.bytes] });
  return { parts: makeZip(entries), fileName: `${name}_rcp.zip` };
}
