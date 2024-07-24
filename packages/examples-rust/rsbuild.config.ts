import { defineConfig } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
import { ModuleFederationPlugin } from '@module-federation/enhanced/rspack';

export default defineConfig({
  server: {
    port: 5176,
    open: true
  },
  dev: {
    // It is necessary to configure assetPrefix, and in the production environment, you need to configure output.assetPrefix
    assetPrefix: 'http://localhost:5176',
  },
  tools: {
    rspack: (config, { appendPlugins }) => {
      config.output!.uniqueName = 'app1';
      appendPlugins([
        new ModuleFederationPlugin({
          name: 'examples_rust',
          remotes: {
            viteRemote: "http://localhost:5173/dd/remoteEntry.js",
          },
          remoteType: "module",
          exposes: {
            './app': './src/app.tsx',
          },
          manifest: {
            filePath: 'manifestpath',
          },
          shared: [
            'react',
            'react-dom',
            'vue'
            // 'antd'
          ],
        }),
      ]);
    },
  },
  plugins: [
    pluginReact({
      splitChunks: {
        react: false,
        router: false,
      },
    }),
  ],
});
