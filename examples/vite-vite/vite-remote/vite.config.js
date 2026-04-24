import { federation } from '@module-federation/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

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
      hostInitInjectLocation: 'entry',
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
        'react/': {
          singleton: true,
          requiredVersion: '^19.2.4',
        },
        react: {
          singleton: true,
          requiredVersion: '^19.2.4',
        },
        'react-dom/': {
          singleton: true,
          requiredVersion: '^19.2.4',
        },
        'react-dom': {
          singleton: true,
          requiredVersion: '^19.2.4',
        },
        '@vite-vite/shared-lib': { singleton: true },
      },
    }),
  ].filter(Boolean),
  build: {
    target: 'chrome89',
    rolldownOptions: {
      output: {
        chunkFileNames: 'static/js/[name]-[hash].js',
        entryFileNames: 'static/js/[name]-[hash].js',
        assetFileNames: 'static/[ext]/[name]-[hash].[ext]',
      },
    },
  },
});
