import { federation } from '@module-federation/vite';
import TopAwait from 'vite-plugin-top-level-await';

export default defineNuxtConfig({
  compatibilityDate: '2024-04-03',
  debug: true,
  devtools: { enabled: true },
  vite: {
    plugins: [
      federation({
        name: 'nuxremote',
        filename: 'remoteEntry.js',
        shared: {
          // vue: {},
        },
        runtimePlugins: ['./utils/mfPlugins'],
        exposes: {
          './app': './app.vue',
        },
        manifest: {
          fileName: '_nuxt/mf-manifest.json',
        },
      }),
      new TopAwait(),
    ],
    build: {
      target: 'chrome89',
    },
  },
});
