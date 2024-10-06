import { federation } from '@module-federation/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    federation({
      name: 'dynamicRemote',
      filename: 'remoteEntry.js',
      // Modules to expose
      exposes: {
        './SignUpBanner': './src/SignUpBanner.jsx',
        './SpecialPromo': './src/SpecialPromo.jsx',
      },
      shared: ['react', 'react-dom'],
    }),
  ],
  server: {
    port: 4002,
  },
  build: {
    modulePreload: false,
    target: 'esnext',
    minify: false,
    cssCodeSplit: false,
  },
});
