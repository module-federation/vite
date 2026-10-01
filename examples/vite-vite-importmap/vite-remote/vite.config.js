import { federation } from '@module-federation/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { shared } from '../shared.js';

export default defineConfig({
  // Where the remote is served from; written into importmap-manifest.json for the host.
  base: 'http://localhost:5181/',
  plugins: [
    react(),
    federation({
      name: 'importMapRemote',
      exposes: { './Button': './src/Button.jsx' },
      shared,
      experiments: { importMap: true },
    }),
  ],
  build: { target: 'esnext' },
});
