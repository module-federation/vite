import { federation } from '@module-federation/vite';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';
import topLevelAwait from 'vite-plugin-top-level-await';

// https://vitejs.dev/config/
export default defineConfig({
  server: {
    open: false,
    port: 5181,
  },
  preview: {
    port: 5181,
  },
  // base: 'http://localhost:5181',
  plugins: [
    vue(),
    federation({
      name: 'viteViteHost',
      remotes: {
        '@namespace/viteViteRemote': 'http://localhost:5182/testbase/mf-manifest.json',
      },
      dts: false,
      filename: 'remoteEntry-[hash].js',
      varFilename: 'varRemoteEntry.js',
      manifest: true,
      shared: {
        vue: {},
      },
      runtimePlugins: ['./src/mfPlugins'],
    }),
  ],
  build: {
    target: 'baseline-widely-available',
  },
});
