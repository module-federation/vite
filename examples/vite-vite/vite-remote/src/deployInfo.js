// A small standalone module isolated into its own chunk via `manualChunks` so it
// can be rewritten at deploy time without touching the rest of the remote bundle.
// See the `build.rollupOptions.output.manualChunks` entry in vite.config.js.
export const deployInfo = 'remote-deploy-info';
