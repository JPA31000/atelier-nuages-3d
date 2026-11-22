import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

// « Version 1.1 » affichée sur l'écran de chargement : lue dans package.json (majeur.mineur).
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'));
const version = pkg.version.split('.').slice(0, 2).join('.');
const htmlVersion = () => ({ name: 'html-version', transformIndexHtml: (html) => html.replaceAll('__VERSION__', version) });

// Base relative : le site fonctionne sur https://<compte>.github.io/<depot>/ sans réglage.
export default defineConfig({
  base: './',
  plugins: [htmlVersion()],
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
  server: { port: 5173 },
});
