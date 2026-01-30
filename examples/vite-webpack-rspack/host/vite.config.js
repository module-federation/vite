import { federation } from '@module-federation/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const mfConfig = {
  name: 'host',
  remotes: {
    // vite remote (module)
    moduleRemote: {
      name: 'moduleRemote', // should not conflict with "var" remote name // todo: related to https://github.com/module-federation/vite/issues/352
      entry: 'http://localhost:4001/custom-filename.js',
      type: 'module',
    },
    // vite remote (var)
    remote: {
      entry: 'http://localhost:4001/varRemoteEntry.js',
      type: 'var',
    },
    webpack: {
      entry: 'http://localhost:8080/remoteEntry.js',
      type: 'var',
    },
    rspack: {
      entry: 'http://localhost:8081/remoteEntry.js',
      type: 'var',
    },
    testsRemote: {
      entry: 'http://localhost:4003/remoteEntry.js',
      type: 'module',
    },
  },
  shared: ['react', 'react-dom', 'lodash'],
  moduleParseTimeout: 2,
};

// https://vitejs.dev/config/
export default defineConfig({
  server: {
    host: true,
  },
  plugins: [
    react(),
    federation({
      ...mfConfig,
    }),
  ],
  build: {
    target: 'chrome89',
    minify: false,
  },
});
