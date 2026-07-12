import { federation } from '@module-federation/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const treeShakingMode = ['server-calc', 'runtime-infer'].includes(process.env.TREE_SHAKING_MODE)
  ? process.env.TREE_SHAKING_MODE
  : undefined;
const eagerShared = process.env.EAGER_SHARED === 'true';
const antdShared = {
  singleton: true,
  ...(eagerShared && !treeShakingMode ? { eager: true } : {}),
  ...(treeShakingMode
    ? { treeShaking: { mode: treeShakingMode, usedExports: ['Button', 'Input'] } }
    : {}),
};

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
        '@vite-vite/shared-consumer': { singleton: true },
        '@vite-vite/shared-lib': { singleton: true },
        '@vite-vite/shared-lib/helpers': { singleton: true },
        antd: {
          ...antdShared,
        },
      },
      runtimePlugins: ['./src/mfPlugins'],
    }),
  ],
  build: {
    target: 'chrome89',
  },
});
