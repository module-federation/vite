import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/runtime.ts', 'src/utils/ssrEntryLoader.ts'],
  format: ['esm', 'cjs'],
  outDir: 'lib',
  dts: true,
  clean: true,
  deps: {
    onlyAllowBundle: false,
  },
});
