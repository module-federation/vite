import { defineConfig } from 'vitest/config';

const vitePackage = process.env.MFE_VITE_PACKAGE;

export default defineConfig({
  resolve: vitePackage
    ? {
        alias: [{ find: /^vite(?=\/|$)/, replacement: vitePackage }],
      }
    : undefined,
  test: {
    globals: true,
    exclude: ['**/e2e/**', '**/node_modules/**'],
    env: {
      MFE_VITE_NO_TEST_ENV_CHECK: 'true',
    },
    // vm.SourceTextModule (used by the ssrEntryLoader 'vm' strategy) is gated
    // behind this flag; the vm strategy tests skip themselves when it's absent.
    execArgv: ['--experimental-vm-modules'],
  },
});
