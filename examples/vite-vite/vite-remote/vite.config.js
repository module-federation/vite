import { federation } from '@module-federation/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import topLevelAwait from 'vite-plugin-top-level-await';

// https://vitejs.dev/config/
const isMixed2 = process.env.MIXED_VV === '2';

export default defineConfig({
  server: {
    open: false,
    port: 5176,
    origin: 'http://localhost:5176',
    watch: isMixed2
      ? {
          ignored: ['**/.__mf__temp/**'],
        }
      : undefined,
  },
  preview: {
    port: 5176,
  },
  base: 'http://localhost:5176/testbase',
  esbuild: isMixed2
    ? {
        jsx: 'automatic',
        jsxDev: false,
        jsxImportSource: '@emotion/react',
      }
    : undefined,
  plugins: [
    !isMixed2 && react({ jsxImportSource: '@emotion/react' }),
    federation({
      name: '@namespace/viteViteRemote',
      exposes: {
        './App1': './src/App1',
        './App2': './src/App2.jsx',
        './AgGridDemo': './src/AgGridDemo.jsx',
        './MuiDemo': './src/MuiDemo.jsx',
        './StyledDemo': './src/StyledDemo.jsx',
        './EmotionDemo': './src/EmotionDemo.jsx',
        '.': './src/App.jsx',
      },
      dts: false,
      filename: 'remoteEntry-[hash].js',
      varFilename: 'varRemoteEntry.js', // in cases when host's config requires remote's "type": "var"
      manifest: true,
      shared: {
        vue: {},
        'react/': {},
        react: {},
        'react-dom/': {},
        'react-dom': {},
        'styled-components': { singleton: true },
        'ag-grid-community/': {},
        'ag-grid-react': {},
        '@emotion/react': {},
        '@emotion/styled': { singleton: true },
        '@mui/material': {},
        '@vite-vite/shared-lib': { singleton: true },
      },
    }),
    // If you set build.target: "chrome89", you can remove this plugin
    false && topLevelAwait(),
  ].filter(Boolean),
  build: {
    target: 'chrome89',
    rollupOptions: {
      output: {
        chunkFileNames: 'static/js/[name]-[hash].js',
        entryFileNames: 'static/js/[name]-[hash].js',
        assetFileNames: 'static/[ext]/[name]-[hash].[ext]',
      },
    },
  },
});
