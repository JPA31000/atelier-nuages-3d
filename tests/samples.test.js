import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLazPerf } from 'laz-perf';
import { importFile } from '../src/io/importFile.js';

// Les jeux d'essai proposés au téléchargement sur la page d'accueil doivent se rouvrir dans l'application.
const dir = mkdtempSync(join(tmpdir(), 'exemples-'));
execFileSync(process.execPath, ['scripts/make-samples.mjs'], { env: { ...process.env, SAMPLES_OUT: dir }, stdio: 'pipe' });
const file = (n) => new File([readFileSync(join(dir, n))], n);

test('exemple E57 structuré : 2 stations, 2 panoramiques PNG rattachés', async () => {
  const r = await importFile(file('salle-demo-structure.e57'));
  assert.equal(r.format, 'E57');
  assert.equal(r.structure.type, 'structuré');
  assert.equal(r.clouds.length, 2);
  assert.ok(r.clouds.every((c) => c.count > 50000 && c.colors && c.intensity && c.station));
  assert.equal(r.images.length, 2);
  assert.deepEqual(r.images.map((i) => i.stationIndex).sort(), [0, 1]);
  assert.ok(r.images.every((i) => i.mime === 'image/png' && i.bytes[1] === 0x50)); // signature PNG
  // coordonnées globales type Lambert-93 retrouvées
  assert.ok(r.clouds[0].offset[0] > 651000 && r.clouds[0].offset[1] > 6862000);
});

test('exemple LAZ : nuage fusionné lisible', async () => {
  const lp = await createLazPerf();
  const r = await importFile(file('salle-demo-nuage.laz'), { getLazPerf: async () => lp });
  assert.equal(r.format, 'LAZ');
  assert.ok(r.clouds[0].count > 100000);
  assert.equal(r.clouds[0].station, null);
});
