import { federation } from '@module-federation/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  base: 'http://localhost:4176/',
  plugins: [
    react(),
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
  build: {
    target: 'chrome89',
  },
});
