# Vite/Rollup plugin for Module Federation

## Reason why 🤔

[Microservices](https://martinfowler.com/articles/microservices.html) nowadays is a well-known concept and maybe you are using it in your current company.
Do you know that now you can apply similar ideas on the Frontend?
With [Module Federation](https://blog.logrocket.com/building-micro-frontends-webpacks-module-federation/#:~:text=Module%20federation%20is%20a%20JavaScript,between%20two%20different%20application%20codebases.) you can load separately compiled and deployed code into a unique application.
This plugin makes Module Federation work together with [Vite](https://vitejs.dev/).

## Working implementations

### [React](https://github.com/module-federation/module-federation-examples/tree/master/vite-react-microfrontends)<br>
### [Svelte](https://github.com/module-federation/module-federation-examples/tree/master/vite-svelte-microfrontends)

## Getting started 🚀

This plugin is based on top of [native-federation](https://www.npmjs.com/package/@softarc/native-federation) so this library is a [peer dependency](https://docs.npmjs.com/cli/v8/configuring-npm/package-json#peerdependencies).

You need to extend the Vite configuration with this plugin:

```typescript
import { defineConfig } from 'vite';
import { federation } from '@module-federation/vite';
import { createEsBuildAdapter } from '@softarc/native-federation-esbuild';

// https://vitejs.dev/config/
export default defineConfig(async ({ command }) => ({
  server: {
    fs: {
      allow: ['.', '../shared'],
    },
  },
  plugins: [
    await federation({
      options: {
        workspaceRoot: __dirname,
        outputPath: 'dist',
        tsConfig: 'tsconfig.json',
        federationConfig: 'module-federation/federation.config.cjs',
        verbose: false,
        dev: command === 'serve',
      },
      adapter: createEsBuildAdapter({ plugins: [...], }),
    }),
    [...]
  ],
}));
```

<br>

### Define configs

You need to define two different configurations in the `federationConfig` property.<br>
Here are two examples:

- [host](https://www.npmjs.com/package/@softarc/native-federation#configuring-hosts)
- [remote](https://www.npmjs.com/package/@softarc/native-federation#configuring-remotes)
  <br><br>

### So far so good 🎉

Now you are ready to use Module Federation in Vite!

## Thanks 🤝

Big thanks to:

[Manfred Steyer](https://twitter.com/manfredsteyer), Speaker, Trainer, Consultant and Author with focus on Angular. Google Developer Expert (GDE) and Microsoft MVP.

who collaborate with me to make this possible.
