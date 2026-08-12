import { federation } from '@module-federation/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// A classic dual-build SSR host (`vite build` + `vite build --ssr`): its Node
// server renders the federated widget before hydration, which requires the
// remote to publish remoteEntry.ssr.js with its client assets.
export default defineConfig({
  plugins: [
    react(),
    federation({
      name: 'ssrHost',
      remotes: {
        ssrRemote: {
          type: 'module',
          name: 'ssrRemote',
          entry: 'http://localhost:5177/remoteEntry.js',
        },
      },
      dts: false,
      shared: {
        react: { singleton: true, requiredVersion: '^19.2.4' },
        'react-dom': { singleton: true, requiredVersion: '^19.2.4' },
      },
    }),
  ],
  build: { target: 'chrome89' },
});
