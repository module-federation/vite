# Vite plugin for Module Federation

## Reason why 🤔

[Microservices](https://martinfowler.com/articles/microservices.html) nowadays is a well-known concept and maybe you are using it in your current company.
Do you know that now you can apply similar ideas on the Frontend?
With [Module Federation](https://blog.logrocket.com/building-micro-frontends-webpacks-module-federation/#:~:text=Module%20federation%20is%20a%20JavaScript,between%20two%20different%20application%20codebases.) you can load separately compiled and deployed code into a unique application.
This plugin makes Module Federation work together with [Vite](https://vitejs.dev/).

## Working implementations

### [React](https://github.com/module-federation/module-federation-examples/tree/master/vite-react-microfrontends)<br>

### [Svelte](https://github.com/module-federation/module-federation-examples/tree/master/vite-svelte-microfrontends)<br>

### [Vue](https://github.com/module-federation/module-federation-examples/tree/master/vite-vue-microfrontends)

## Getting started 🚀

https://module-federation.io/guide/basic/webpack.html

```js
// vite.config.js
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { federation } from '@module-federation/vite';
import topLevelAwait from 'vite-plugin-top-level-await';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    federation({
      name: 'bbc',
      remotes: {
        mfapp01: 'mfapp01@https://unpkg.com/mf-app-01@1.0.9/dist/remoteEntry.js',
        remote2: 'mfapp02@https://unpkg.com/mf-app-02/dist/remoteEntry.js',
        remote3:
          'remote1@https://unpkg.com/react-manifest-example_remote1@1.0.6/dist/mf-manifest.json',
        // "remote4": {
        //   entry: "http://localhost:5174/dd/remoteEntry.js",
        //   globalEntryName: "bb",
        //   type: "esm"
        // }
      },
      exposes: {
        './App': './src/App.vue',
      },
      filename: 'dd/remoteEntry.js',
      shared: {
        vue: {},
        react: {
          requiredVersion: '18',
        },
      },
    }),
    // If you set build.target: "chrome89", you can remove this plugin
    // topLevelAwait(),
  ],
  server: {
    port: 5173,
    // dev mode please set origin
    origin: 'http://localhost:5173',
  },
  build: {
    target: 'chrome89',
  },
});
```

## roadmap

- feat: generate mf-manifest.json
- feat: support chrome plugin

* ✅ ~~feat: support runtime plugins~~

- feat: download remote d.ts
- feat: generate d.ts
- feat: support @vitejs/plugin-legacy
- feat: Another plugin, when only some remote modules are started, automatically completes HMR[（#54）](https://github.com/module-federation/vite/issues/54)

### So far so good 🎉

Now you are ready to use Module Federation in Vite!
