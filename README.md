# Vite plugin for Module Federation

[![npm](https://img.shields.io/npm/v/@module-federation/vite.svg)](https://www.npmjs.com/package/@module-federation/vite)

## Reason why 🤔

[Microservices](https://martinfowler.com/articles/microservices.html) nowadays is a well-known concept and maybe you are using it in your current company.
Do you know that now you can apply similar ideas on the Frontend?
With [Module Federation](https://blog.logrocket.com/building-micro-frontends-webpacks-module-federation/#:~:text=Module%20federation%20is%20a%20JavaScript,between%20two%20different%20application%20codebases.) you can load separately compiled and deployed code into a unique application.
This plugin makes Module Federation work together with [Vite](https://vitejs.dev/).

## Working implementations

### [Vue](https://github.com/gioboa/vue-microfrontend-demo)

### [React](https://github.com/gioboa/react-microfrontend-demo)<br>

### [More examples here](https://github.com/module-federation/vite/tree/main/examples)<br>

```
pnpm install && pnpm run dev-vv # vite+vite dev demo
```

```
pnpm install && pnpm run preview-vv # vite+vite build demo
```

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
        //   entry: "http://localhost:xxxx/remoteEntry.js",
        //   globalEntryName: "xxxx",
        //   type: "module"
        // }
      },
      exposes: {
        './App': './src/App.vue',
      },
      filename: 'remoteEntry-[hash].js',
      // https://github.com/module-federation/vite/issues/87
      manifest: true,
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

- ✅ ~~feat: generate mf-manifest.json~~
- ✅ ~~feat: support chrome plugin~~

* ✅ ~~feat: support runtime plugins~~
* feat: nuxt ssr

- feat: download remote d.ts
- feat: generate d.ts
- feat: support @vitejs/plugin-legacy
- feat: Another plugin, when only some remote modules are started, automatically completes HMR[（#54）](https://github.com/module-federation/vite/issues/54)

### So far so good 🎉

Now you are ready to use Module Federation in Vite!
