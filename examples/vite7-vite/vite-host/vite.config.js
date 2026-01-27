import { federation } from '@module-federation/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import topLevelAwait from 'vite-plugin-top-level-await';

// https://vitejs.dev/config/
export default defineConfig({
  server: {
    open: true,
    port: 5177,
  },
  preview: {
    port: 5177,
  },
  // base: 'http://localhost:5177',
  plugins: [
    react(),
    federation({
      name: 'vite7ViteHost',
      remotes: {
        mfapp01: 'mfapp01@https://unpkg.com/mf-app-01@1.0.11/dist/remoteEntry.js',
        remote2: 'mfapp02@https://unpkg.com/mf-app-02/dist/remoteEntry.js',
        remote3:
          'remote1@https://unpkg.com/react-manifest-example_remote1@1.0.6/dist/mf-manifest.json',
        '@namespace/vite7ViteRemote': 'http://localhost:5178/testbase/mf-manifest.json',
      },
      dts: {
        tsConfigPath: './tsconfig.json',
        generateTypes: false,
        consumeTypes: {
          typesOnBuild: true,
        },
      },
      filename: 'remoteEntry-[hash].js',
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
