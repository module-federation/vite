import type { UserConfig } from 'vite';

export interface Command {
  command: string;
}

export default {
  name: 'normalizeOptimizeDeps',
  config: (config: UserConfig) => {
    let { optimizeDeps } = config;
    if (!optimizeDeps) {
      config.optimizeDeps = {};
      optimizeDeps = config.optimizeDeps;
    }
    if (!optimizeDeps.include) optimizeDeps.include = [];
    if (!optimizeDeps.exclude) optimizeDeps.exclude = [];
    if (!optimizeDeps.needsInterop) optimizeDeps.needsInterop = [];
  },
  configResolved: (config: { optimizeDeps?: UserConfig['optimizeDeps'] }) => {
    const include = config.optimizeDeps?.include;
    const exclude = config.optimizeDeps?.exclude;
    if (!include?.length || !exclude?.length) return;
    const included = new Set(include);
    config.optimizeDeps!.exclude = exclude.filter((dep) => !included.has(dep));
  },
};
