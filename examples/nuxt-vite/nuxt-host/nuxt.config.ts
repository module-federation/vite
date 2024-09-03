import { federation } from '@module-federation/vite';

export default defineNuxtConfig({
  compatibilityDate: '2024-04-03',
  devtools: { enabled: true },
  vite: {
    plugins: [
      federation({
        name: 'viteViteHost',
        remotes: {
          '@namespace/viteViteRemote': {
            entry: 'http://localhost:5176/remoteEntry.js',
            type: 'module',
          },
        },
        filename: 'remoteEntry.js',
        shared: {
          vue: {},
        },
        runtimePlugins: ['./utils/mfPlugins'],
      }),
    ],
    build: {
      target: 'chrome89',
    },
  },
});
