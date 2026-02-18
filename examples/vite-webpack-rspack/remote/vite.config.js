import { federation } from '@module-federation/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    federation({
      name: 'remote',
      filename: 'custom-filename.js',
      varFilename: 'varRemoteEntry.js',
      // Modules to expose
      exposes: {
        './Product': './src/Product.jsx',
        './PurchasesCount': './src/PurchasesCount.jsx',
      },
      shared: ['react', 'react-dom'],
    }),
  ],
  server: {
    port: 4001,
  },
  build: {
    modulePreload: false,
    target: 'esnext',
    minify: false,
    cssCodeSplit: false,
  },
});
