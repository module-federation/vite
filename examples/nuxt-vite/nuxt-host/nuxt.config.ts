import { federation } from '@module-federation/vite';
import TopAwait from 'vite-plugin-top-level-await';

export default defineNuxtConfig({
  compatibilityDate: '2024-04-03',
  debug: true,
  devtools: { enabled: true },
  vite: {
    plugins: [
      federation({
        name: 'nuxhost',
        remotes: {
          '@namespace/viteViteRemote': 'viteRemote@http://localhost:3000/_nuxt/mf-manifest.json',
        },
        filename: 'remoteEntry.js',
        shared: {
          // vue: {},
        },
        runtimePlugins: ['./utils/mfPlugins'],
        // exposes: {
        //   "./App": "./App.vue"
        // }
        // manifest: {
        //   fileName: "_nuxt/mf-manifest.json",
        // }
      }),
      new TopAwait(),
    ],
    build: {
      target: 'chrome89',
    },
  },
});
