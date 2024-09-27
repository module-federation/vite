import { federation } from '@module-federation/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const mfConfig = {
  name: 'host',
  dts: {
    consumeTypes: true,
  },
  dev: true,
  remotes: {
    remote: {
      entry: 'http://localhost:4001/remoteEntry.js',
      type: 'module',
    },
    webpack: {
      entry: 'http://localhost:8080/remoteEntry.js',
      type: 'var',
    },
    rspack: {
      entry: 'http://localhost:8081/remoteEntry.js',
      type: 'var',
    },
  },
  shared: ['react', 'react-dom'],
};

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    federation({
      ...mfConfig,
    }),
  ],
  build: {
    target: 'chrome89',
  },
});
