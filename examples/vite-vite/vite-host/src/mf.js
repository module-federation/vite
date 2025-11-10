import { createInstance } from '@module-federation/runtime';
import React from 'react';

const mf = createInstance({
  name: 'viteViteHost',
  remotes: [
    {
      name: '@namespace/viteViteRemote',
      entry: 'http://localhost:5176/testbase/varRemoteEntry.js',
      type: 'var',
    },
  ],
  shared: {
    react: {
      version: React.version,
      lib: () => React,
      shareConfig: {
        singleton: true,
        requiredVersion: false,
      },
    },
  },
});

export { mf };
