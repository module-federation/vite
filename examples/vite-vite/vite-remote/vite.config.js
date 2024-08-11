import { federation } from '@module-federation/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import topLevelAwait from 'vite-plugin-top-level-await';

// https://vitejs.dev/config/
export default defineConfig({
  server: {
    open: true,
    port: 5176,
  },
  base: 'http://localhost:5176',
  plugins: [
    react(),
    federation({
      name: '@namespace/viteViteRemote',
      // name: 'viteViteRemote',
      exposes: {
        './App1': './src/App1.jsx',
        './App2': './src/App2.jsx',
        './AgGridDemo': './src/AgGridDemo.jsx',
        '.': './src/App1.jsx',
      },
      filename: 'remoteEntry.js',
      shared: {
        vue: {},
        react: {
          requiredVersion: '18',
        },
        'react-dom': {},
      },
    }),
    // If you set build.target: "chrome89", you can remove this plugin
    false && topLevelAwait(),
  ],
  build: {
    target: 'chrome89',
  },
});
