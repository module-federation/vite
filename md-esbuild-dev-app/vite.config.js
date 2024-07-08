import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import Inspect from 'vite-plugin-inspect';
import { federation } from './module-federation-plugin';
import federationConfig from './federation.config.js';

// https://vitejs.dev/config/

export default defineConfig({
  build: {
    minify: false,
  },
  optimizeDeps: {
    exclude: ['vue'],
  },
  plugins: [Inspect(), vue(), federation(federationConfig)],
});
