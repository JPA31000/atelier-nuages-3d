# Atelier Nuages 3D

Application web **100 % côté navigateur** (aucun serveur, aucune installation) pour **importer, visualiser, mesurer, assembler, nettoyer et exporter** des nuages de points issus de scanners laser, avec leurs **panoramiques 360°** par station.
Pensée pour des élèves : elle se publie gratuitement sur **GitHub Pages** et ne fait jamais sortir un fichier de l'ordinateur de l'utilisateur.

> Un bouton **« Jeu de démonstration »** génère une salle scannée depuis deux stations (nuages + panoramiques, avec un défaut de recalage volontaire) : on peut tout essayer sans aucun fichier.

## Sommaire
1. [Démarrer](#démarrer-en-local) · 2. [Publier sur GitHub Pages](#publier-sur-github-pages) · 3. [Formats pris en charge](#formats-pris-en-charge)
4. [Précision et centrage](#précision-et-centrage-des-coordonnées) · 5. [Stations ↔ panoramiques 360°](#stations--panoramiques-360-) · 6. [Recalage](#assemblage-et-recalage)
7. [Nettoyage](#nettoyage) · 8. [Export et limites du .rcp](#export) · 9. [Architecture](#architecture) · 10. [Tests](#tests-et-ce-qui-nest-pas-vérifié) · 11. [Limites connues](#limites-connues)

## Démarrer en local

Prérequis : [Node.js](https://nodejs.org) 20.19+ ou 22.12+.

```bash
npm install        # installe three, laz-perf (décompression LAZ en WebAssembly) et vite
npm run dev        # serveur de développement : http://localhost:5173
npm run build      # site statique prêt à publier dans dist/
npm run preview    # sert dist/ pour vérifier la version de production
npm test           # tests automatiques (lecteurs, écrivains, LAZ, ICP, filtres, démo)
```

Navigateur : navigateur récent avec **WebGL 2** et Web Workers « module » (Chrome, Edge, Firefox ≥ 114, Safari ≥ 16.4) et accélération matérielle activée. Les essais ont été faits dans un navigateur Chromium.
Le rendu utilise WebGL 2 ; WebGPU n'est pas utilisé (voir [limites](#limites-connues)).

## Publier sur GitHub Pages

1. Créez un dépôt GitHub et poussez ce dossier sur la branche `main`.
2. Dans le dépôt : **Settings → Pages → Build and deployment → Source : « GitHub Actions »** (réglage à faire une seule fois).
3. Chaque `push` sur `main` déclenche [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml), qui exécute `npm ci`, `npm test`, `npm run build` puis publie `dist/`.
4. L'adresse est `https://<compte>.github.io/<depot>/`.

Le site est configuré avec une **base relative** (`base: './'` dans [`vite.config.js`](vite.config.js)) : il fonctionne tel quel dans un sous-dossier de GitHub Pages, sans réglage. Les Web Workers et le module WebAssembly sont des fichiers statiques du dossier `dist/assets/`.

## Formats pris en charge

| Format | Lecture | Écriture | Remarques |
|---|---|---|---|
| **LAS** 1.0 → 1.4 (formats de points 0 à 10) | ✅ | ✅ LAS 1.2, format 0 ou 2 | RVB 8 ou 16 bits détectés automatiquement ; intensité ; EPSG lu dans les VLR. |
| **LAZ** | ✅ (laz-perf, WebAssembly) | ✅ formats 0 et 2 | L'encodeur est écrit dans ce projet ([`lazWriter.js`](src/io/lazWriter.js)) car laz-perf ne sait que décompresser. Fichier LAZ lu en mémoire : limite ≈ 1,6 Go. |
| **E57 structuré** | ✅ | — | Plusieurs scans (Data3D) avec **poses de stations**, grille ligne/colonne, coordonnées sphériques, **panoramiques sphériques JPEG/PNG intégrés**. |
| **E57 non structuré** | ✅ | — | Un nuage global sans station. |
| **PLY** (ASCII, binaire little/big endian) | ✅ | ✅ binaire ou ASCII | Sommets uniquement (un maillage est affiché comme nuage de points). |
| **XYZ / PTS / TXT / CSV / ASC** | ✅ | ✅ XYZ | Colonnes détectées : `X Y Z`, `X Y Z I`, `X Y Z R G B`, PTS `X Y Z I R G B`, `X Y Z R G B I` ; normales ignorées. |
| **Panoramiques 360°** JPG / PNG / WebP | ✅ | — | Équirectangulaire 2:1. Réduits à 8192 px si la carte graphique le demande. |

**Détection automatique** : par signature de fichier (`LASF`, `ASTF`, `ply`, JPEG/PNG…) puis par extension.

**E57 « structuré » ou « non structuré » ?** (terminologie ReCap/Revit) L'application classe un E57 comme *structuré* s'il contient plusieurs scans, des poses de stations, une grille ligne/colonne, des coordonnées sphériques ou des images 2D ; *non structuré* sinon. Les raisons sont affichées dans la carte du fichier, avec le nombre de points, de stations, l'étendue XYZ, la présence de RVB et d'intensité.

**Budget de points** : au-delà du budget choisi à l'import (5 millions par défaut), les points sont tirés au hasard (échantillon uniforme) pour que le navigateur reste fluide. La carte du fichier indique le pourcentage conservé.

## Précision et centrage des coordonnées

Les coordonnées topographiques (Lambert-93, UTM : 650 000 m, 6 860 000 m) dépassent la précision d'un nombre flottant 32 bits utilisé par le GPU (≈ 6 cm à 650 000 m). Chaque nuage est donc **recentré sur son barycentre** :

* en mémoire et sur le GPU : `Float32` *locaux*, précis au dixième de millimètre sur 100 m ;
* le décalage exact (`Float64`) est conservé : `brut = local + offset` ;
* la scène utilise comme origine le décalage du premier nuage ; les recalages sont des matrices 4×4 en `Float64` ;
* à l'export et dans les mesures affichées, l'origine exacte est **restituée** : un LAS exporté retrouve les coordonnées d'origine au millimètre (échelle réglable).

## Stations ↔ panoramiques 360°

* Chaque scan E57 devient un **nuage** et une **station** (position et orientation = pose du scan). Les panoramiques intégrés à l'E57 sont rattachés automatiquement à leur scan (`associatedData3DGuid`).
* Les JPG/PNG déposés sont associés **automatiquement** (nom de station contenu dans le nom du fichier, puis même numéro, puis unique restant) ou **manuellement** (liste déroulante dans la carte du panoramique).
* Pas de station ? Choisissez **« ➕ Nouvelle station »** dans la carte du panoramique, puis cliquez un point du nuage : la station est créée à cet endroit. La **rotation de l'image** (curseur « Caler l'image ») et le **miroir** permettent de la caler ; activez **« Superposer le nuage »** pour voir les points par-dessus l'image et juger la coïncidence. La position XYZ d'une station est modifiable dans la liste des stations.
* Convention d'image : équirectangulaire, **centre de l'image = direction +X de la station**, azimut positif dans le sens anti-horaire (la droite de l'image est −Y), haut de l'image = zénith. C'est l'usage des scanners Leica/Faro/Trimble courants ; sinon, utiliser la rotation et le miroir.
* **Navigation** : cliquer une icône **360** dans la scène ouvre la vue **3D + 360°** ; cliquer une autre icône dans le panoramique « téléporte » à cette station. Le bouton **Synchroniser** place la vue 3D *à la station* avec exactement la même direction de visée que le panoramique (glisser dans l'une fait tourner l'autre) ; désactivé, la vue 3D reste libre.
* **Mesure** (onglet Mesure, touche `M`) : deux clics, en 3D **ou** dans le panoramique. Dans le panoramique, le rayon visé est lancé dans le nuage : on retient le **premier groupe de points « épais »** dans un cône de ±10 px (un point isolé devant la surface est ignoré). Les points mesurés sont de **vrais points du nuage** ; on obtient la distance 3D, la distance horizontale, ΔX/ΔY/ΔZ et les coordonnées brutes des deux points (copie CSV pour Excel). Les marqueurs et l'étiquette sont visibles dans les deux vues.

## Assemblage et recalage

1. **Pré-alignement manuel** : poignées de translation/rotation à la souris, ou valeurs numériques (ΔX, ΔY, ΔZ en m ; rotations en degrés autour du centre du nuage). « Annuler le dernier » et « Position d'origine » sont disponibles ; les stations suivent leur nuage.
2. **Points homologues** (facultatif) : paires de points cliqués sur la source puis la cible ; la transformation rigide optimale (méthode de Horn) est calculée.
3. **ICP** (*Iterative Closest Point*, point-à-point) : plus proche voisin par KD-tree, rejet par distance maximale, **recouvrement partiel** réglable, itérations jusqu'à convergence. Le **RMSE** (mm) et sa courbe sont affichés. L'ICP s'exécute dans un Web Worker ; le résultat s'applique au nuage source (annulable).
   *Le RMSE point-à-point ne peut pas descendre sous l'espacement des points : pour comparer des scans de densités différentes, sous-échantillonnez d'abord par voxels.*

## Nettoyage

* **Valeurs aberrantes** : filtre **statistique** (distance moyenne aux *k* voisins, seuil = moyenne + n×σ) et filtre **par rayon** (nombre minimal de voisins).
* **Découpe par boîte** (coordonnées brutes, aperçu 3D, garder l'intérieur ou l'extérieur).
* **Sous-échantillonnage par voxels** (centre de gravité ou premier point, couleurs moyennées).
* Tout s'exécute dans un Worker sur une copie ; **« Annuler la dernière opération »** restaure l'état précédent.

## Export

* **Fusion** : « Fusionner les nuages visibles » crée le nuage final (recalages appliqués).
* **LAS** (1.2), **LAZ**, **PLY**, **XYZ** : coordonnées **globales d'origine** (Float64), RVB et intensité conservés ; plusieurs nuages visibles sont fusionnés à l'export.

### Paquet « .rcp » : ce qui est (et n'est pas) possible dans un navigateur

Un projet ReCap natif (`.rcp` + dossier `.rcs`) est un **index propriétaire Autodesk** (octree compressé, tuiles, miniatures, métadonnées). **Aucune bibliothèque ouverte ne sait l'écrire**, donc aucune application web non plus.
Le bouton **« Paquet .rcp »** produit donc une **archive ZIP de transfert** :

```
nuage_rcp.zip
├── nuage.rcp              manifeste de projet (texte XML : scans, étendues, matrices de recalage, stations, panoramiques)
├── scans/Scan_001_….las   un LAS par nuage, en coordonnées globales, recalages appliqués
├── panoramiques/          images 360° + stations.csv (position, quaternion, image associée)
└── README_RCP.txt         mode d'emploi et limites (rappel de ce paragraphe)
```

Le manifeste **n'est pas lisible par ReCap**. Pour obtenir l'index natif : ReCap Pro → *nouveau projet* → *ajouter les scans* (les LAS du dossier `scans/`) → *indexer* → dans Revit, *Insérer → Nuage de points* sur le `.rcp` généré. Un LAS ne porte pas les positions de scan ni les images : pour les conserver dans ReCap, importez plutôt les E57 d'origine ; `stations.csv` permet de retrouver les positions. L'archive ZIP est limitée à 4 Go (pas de ZIP64).

## Architecture

```
index.html, src/style.css          interface (HTML/CSS, sans framework)
src/app.js, src/ui/*               panneaux : scène, mesure, recalage, nettoyage, export
src/core/model.js, workers.js      modèle (nuages, stations, panoramas) · clients des Web Workers
src/viewer/                        Three.js (WebGL2) : scène unique rendue dans 2 vues (3D + panorama 360°),
                                   matériau de points (RVB / Z / intensité / nuage), sélection CPU, gizmo, mesures
src/io/                            lecteurs (las, e57, ply, xyz), écrivains (las, laz, ply, xyz, zip, rcp), worker d'import
src/geo/                           KD-tree, Horn, ICP, filtres + worker de calcul (ICP, filtres, exports)
src/demo/demoScene.js              jeu de démonstration (lancer de rayons)
tests/                             tests Node (node:test) avec générateur E57 de test
```

* **Import et calculs lourds dans des Web Workers** (l'interface ne se fige pas) ; le décodage LAZ utilise **WebAssembly** (laz-perf). Les tableaux sont transférés sans copie.
* **Un seul jeu de tampons GPU** sert les deux vues (3D et panorama) : la scène est rendue deux fois par *scissor* sur un seul canvas. La sphère panoramique est un shader (projection équirectangulaire), sans couture.
* Après import les points sont **mélangés** : tout préfixe du tableau est un échantillon uniforme, ce qui sert à l'affichage progressif (réglage « Points affichés »), à l'ICP et aux filtres.

## Tests et ce qui n'est pas vérifié

`npm test` (29 tests) vérifie : lecture/écriture de LAS, PLY (3 encodages), XYZ, PTS, E57 (scans multiples, poses, couleurs, intensité, coordonnées sphériques, panoramique intégré, flux d'octets à cheval entre paquets), **LAZ relu par le décodeur laz-perf**, KD-tree contre force brute, Horn, ICP (retrouve 2,5° et ≈ 14 cm), filtres, boîte de découpe, voxels, jeu de démonstration. L'application a aussi été exercée dans un navigateur (import/export de tous les formats par les Workers, panoramique, mesure, gizmo, ICP, nettoyage).

**Non vérifié** — à tester avec de vrais fichiers :
* le lecteur **E57** n'a été éprouvé que sur des fichiers produits par le générateur de test du projet (écrit d'après la norme ASTM E2807), **pas sur des fichiers réels** Leica / Faro / Trimble / Riegl ; la convention d'orientation des panoramiques est la plus courante mais non confirmée sur tous les constructeurs (d'où la rotation et le miroir) ;
* le **LAZ** exporté est validé par le décodeur laz-perf, pas par LAStools / PDAL / CloudCompare ; Firefox et Safari n'ont pas été essayés ;
* les **formats de points LAS 4 à 10** (seuls les formats 0, 2 et 3 sont couverts par des tests) et les **LAZ 1.4** (formats 6 à 10, compression « couches ») ne sont lisibles que dans la mesure où laz-perf les décode.

## Limites connues

* Rendu WebGL 2 uniquement (pas de WebGPU, pas de hiérarchie Potree/octree : adapté à quelques dizaines de millions de points *au total* grâce au budget d'affichage).
* La mémoire du navigateur borne la taille des fichiers : LAZ ≈ 1,6 Go ; 5 à 20 millions de points conservés par fichier.
* L'ICP est point-à-point (pas de point-à-plan) ; les mesures et paires de points restent dans le repère courant de la scène (elles ne suivent pas un recalage ultérieur).
* E57 : seuls les panoramiques *sphériques* sont repris (les images à sténopé / cylindriques sont ignorées et signalées) ; pas d'export E57.
* Les contrôles de somme CRC des pages E57 ne sont pas vérifiés.

## Licence

MIT. Dépendances : [three](https://threejs.org) (MIT), [laz-perf](https://github.com/hobuinc/laz-perf) (Apache-2.0), [Vite](https://vitejs.dev) (MIT, outil de build).
