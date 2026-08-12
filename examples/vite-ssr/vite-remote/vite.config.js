import { federation } from '@module-federation/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// A client-only remote: it has exposes but no ssr Vite environment of its
// own. Its remoteEntry.ssr.js is consumed by the SSR host's Node server over
// HTTP, so it must be emitted alongside the client assets.
export default defineConfig({
  // Dev port differs from preview so a leftover `vite dev` can never be
  // mistaken for the preview server on 5177 by Playwright's reuseExistingServer.
  server: { open: false, port: 5179 },
  preview: { port: 5177, strictPort: true },
  plugins: [
    react(),
    federation({
      name: 'ssrRemote',
      filename: 'remoteEntry.js',
      exposes: {
        './Widget': './src/Widget.jsx',
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
