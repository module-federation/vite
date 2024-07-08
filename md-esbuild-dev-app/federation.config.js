import path from 'path';
import { shareAll } from '@module-federation/esbuild/build';

export default {
  name: 'remote',
  filename: 'remoteEntry.js',
  exposes: {
    './HelloWorld': path.resolve(__dirname, 'src/components/HelloWorld.vue'),
  },
  shared: {
    vue: {
      singleton: true,
      version: '^3.4.29',
    },
    ...shareAll({
      singleton: true,
      strictVersion: true,
      requiredVersion: 'auto',
      includeSecondaries: false,
    }),
  },
};
