import MagicString from 'magic-string';
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'chrome89',
    lib: {
      entry: 'src/index.ts',
      formats: ['es'],
      fileName: 'index',
    },
    sourcemap: true,
  },
  esbuild: {
    treeShaking: true,
    minifyIdentifiers: false,
    minifySyntax: false,
    minifyWhitespace: false,
  },
  plugins: [
    {
      name: 'is-a-browser',
      enforce: 'pre',
      transform(code, id) {
        /*
        Short out window checks.  This will affect `function isBrowserEnv()`, and trickle through
        Thanks to the magic of static code analysis, this will flow through into @module-federation/runtime
        and tree-shake out all the NodeJS code.
        */
        if (id.includes('@module-federation/sdk/dist/index')) {
          const s = new MagicString(code);

          s.overwrite(0, code.length, code.replace(/typeof window !== 'undefined'/g, 'true'));

          const map = s.generateMap({ source: id, includeContent: true });

          return {
            code: s.toString(),
            map,
          };
        }
      },
    },
  ],
});
