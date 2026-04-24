import { federation } from '@module-federation/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// https://vitejs.dev/config/
export default defineConfig({
  server: {
    open: false,
    port: 5175,
  },
  preview: {
    port: 5175,
  },
  // base: 'http://localhost:5175',
  plugins: [
    react(),
    federation({
      name: 'viteViteHost',
      remotes: {
        '@namespace/viteViteRemote': 'http://localhost:5176/testbase/mf-manifest.json',
      },
      dts: false,
      filename: 'remoteEntry-[hash].js',
      varFilename: 'varRemoteEntry.js',
      manifest: true,
      shared: {
        vue: {},
        'react/': {
          singleton: true,
          requiredVersion: '^19.2.4',
        },
        'react-dom': {
          singleton: true,
          requiredVersion: '^19.2.4',
        },
        react: {
          singleton: true,
          requiredVersion: '^19.2.4',
        },
        'react-dom/': {
          singleton: true,
          requiredVersion: '^19.2.4',
        },
        '@vite-vite/shared-lib': { singleton: true },
      },
      runtimePlugins: ['./src/mfPlugins'],
    }),
  ],
  build: {
    target: 'chrome89',
  },
});
