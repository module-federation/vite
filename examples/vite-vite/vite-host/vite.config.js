import { federation } from '@module-federation/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const treeShakingMode = ['server-calc', 'runtime-infer'].includes(process.env.TREE_SHAKING_MODE)
  ? process.env.TREE_SHAKING_MODE
  : undefined;
const eagerShared = process.env.EAGER_SHARED === 'true';
const externalRuntime = process.env.EXTERNAL_RUNTIME === '1';
const antdShared = {
  singleton: true,
  ...(eagerShared && !treeShakingMode ? { eager: true } : {}),
  ...(treeShakingMode
    ? { treeShaking: { mode: treeShakingMode, usedExports: ['Button', 'Input'] } }
    : {}),
};
const shared = {
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
};
const instanceMarkerId = '@namespace/viteViteRemote/InstanceMarker';

function routeInstanceMarker(plugins, acceptsImporter) {
  const proxyRemotes = plugins.find((plugin) => plugin.name === 'proxyRemotes');
  const resolveId = proxyRemotes?.resolveId;
  if (typeof resolveId !== 'function') return plugins;

  proxyRemotes.resolveId = function (source, importer, ...args) {
    if (source === instanceMarkerId && !acceptsImporter(importer)) return;
    return resolveId.call(this, source, importer, ...args);
  };
  return plugins;
}

const primaryFederation = routeInstanceMarker(
  federation({
    name: 'viteViteHost',
    remotes: {
      '@namespace/viteViteRemote': 'http://localhost:5176/testbase/mf-manifest.json',
    },
    dts: false,
    filename: 'hostRemoteEntry.js',
    varFilename: 'hostVarRemoteEntry.js',
    manifest: true,
    shared,
    runtimePlugins: ['./src/mfPlugins'],
    ...(externalRuntime ? { experiments: { provideExternalRuntime: true } } : {}),
  }),
  (importer) => !importer?.endsWith('/SecondaryFederationMarker.jsx')
);

const secondaryFederation = routeInstanceMarker(
  federation({
    name: 'viteViteHostSecondary',
    remotes: {
      '@namespace/viteViteRemote':
        'http://localhost:5176/testbase/secondary-mf-manifest.json',
    },
    dts: false,
    filename: 'secondaryHostRemoteEntry.js',
    varFilename: 'secondaryHostVarRemoteEntry.js',
    manifest: {
      fileName: 'secondary-host-mf-manifest.json',
    },
    shared,
    ...(externalRuntime ? { experiments: { provideExternalRuntime: true } } : {}),
  }),
  (importer) => importer?.endsWith('/SecondaryFederationMarker.jsx')
);

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
    primaryFederation,
    secondaryFederation,
  ],
  build: {
    target: 'chrome89',
  },
});
