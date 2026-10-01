import { federation } from '@module-federation/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { shared } from '../shared.js';

export default defineConfig({
  plugins: [
    react(),
    federation({
      name: 'importMapHost',
      // Build the remote first: the host reads its manifest to map `importMapRemote/*`.
      remotes: { importMapRemote: '../vite-remote/dist/importmap-manifest.json' },
      shared,
      experiments: { importMap: true },
    }),
  ],
  build: { target: 'esnext' },
});
