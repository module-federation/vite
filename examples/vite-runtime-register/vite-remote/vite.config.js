import { federation } from '@module-federation/vite';
import babel from '@rolldown/plugin-babel';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  base: 'http://localhost:4176/',
  plugins: [
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    federation({
      name: 'runtimeRemote',
      manifest: true,
      exposes: {
        './MessageCard': './src/MessageCard.jsx',
        './message': './src/message.js',
      },
      shared: {
        react: {
          singleton: true,
        },
        'react-dom': {
          singleton: true,
        },
        'react/compiler-runtime': {
          singleton: true,
        },
      },
      dts: false,
    }),
  ],
  server: {
    open: false,
    origin: 'http://localhost:4176',
    port: 4176,
  },
  preview: {
    port: 4176,
  },
  optimizeDeps: {
    exclude: ['react/compiler-runtime'],
  },
  build: {
    target: 'chrome89',
  },
});
