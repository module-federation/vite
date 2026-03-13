import { federation } from '@module-federation/vite';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

// https://vitejs.dev/config/
export default defineConfig({
  server: {
    open: false,
    port: 5182,
    origin: 'http://localhost:5182',
  },
  preview: {
    port: 5182,
  },
  base: 'http://localhost:5182/testbase',
  plugins: [
    vue(),
    federation({
      name: '@namespace/viteViteRemote',
      exposes: {
        './Test': './src/Test.vue',
      },
      dts: false,
      filename: 'remoteEntry-[hash].js',
      varFilename: 'varRemoteEntry.js', // in cases when host's config requires remote's "type": "var"
      manifest: true,
      shared: {
        vue: {},
      },
    }),
  ],
  build: {
    target: 'baseline-widely-available',
    rollupOptions: {
      output: {
        chunkFileNames: 'static/js/[name]-[hash].js',
        entryFileNames: 'static/js/[name]-[hash].js',
        assetFileNames: 'static/[ext]/[name]-[hash].[ext]',
      },
    },
  },
});
