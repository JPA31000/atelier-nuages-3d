import { defineConfig } from 'vite';

// Base relative : le site fonctionne sur https://<compte>.github.io/<depot>/ sans réglage.
export default defineConfig({
  base: './',
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
  server: { port: 5173 },
});
