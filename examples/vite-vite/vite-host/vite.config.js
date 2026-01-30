import { federation } from '@module-federation/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import topLevelAwait from 'vite-plugin-top-level-await';

// https://vitejs.dev/config/
export default defineConfig({
  server: {
    open: true,
    port: 5175,
  },
  preview: {
    port: 5175,
  },
  // base: 'http://localhost:5175',
  plugins: [
    react(),
    federation({
      name: 'viteViteHost',
      remotes: {
        '@namespace/viteViteRemote': 'http://localhost:5176/testbase/mf-manifest.json',
      },
      dts: false,
      filename: 'remoteEntry-[hash].js',
      varFilename: 'varRemoteEntry.js',
      manifest: true,
      shared: {
        vue: {},
        'react/': {
          requiredVersion: '18',
        },
        'react-dom': {},
        'ag-grid-community': {},
        'ag-grid-react': {},
        '@emotion/react': {},
        'styled-components': { singleton: true },
        '@emotion/styled': {},
        '@mui/material': {},
      },
      runtimePlugins: ['./src/mfPlugins'],
    }),
    // If you set build.target: "chrome89", you can remove this plugin
    false && topLevelAwait(),
  ],
  build: {
    target: 'chrome89',
  },
});
