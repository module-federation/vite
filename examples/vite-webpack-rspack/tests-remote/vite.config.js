import { federation } from '@module-federation/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import packageJson from './package.json';

const dependencies = Object.keys(packageJson.dependencies).filter(
  (dep) => dep !== '@module-federation/vite'
);

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    federation({
      name: 'testsRemote',
      filename: 'remoteEntry.js',
      // Modules to expose
      exposes: {
        './TestsScreen': './src/TestsScreen.jsx',
      },
      shared: dependencies,
    }),
  ],
  server: {
    port: 4003,
  },
  build: {
    modulePreload: false,
    target: 'esnext',
    minify: false,
    cssCodeSplit: false,
  },
});
