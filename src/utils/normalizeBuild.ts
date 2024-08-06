import { UserConfig } from 'vite';

interface Output {
  manualChunks?: {
    [key: string]: any;
  };
}

export default (singleChunkModules: string[]) => ({
  name: 'normalizeBuild',
  config: (config: UserConfig, { command }: { command: string }) => {
    if (!config.build) config.build = {};
    if (!config.build.rollupOptions) config.build.rollupOptions = {};
    let { rollupOptions } = config.build;
    if (!rollupOptions.output) rollupOptions.output = {};
    normalizeManualChunks(rollupOptions.output as any, singleChunkModules);
  },
});

function normalizeManualChunks(output: Output, singleChunkModules: string[]): void {
  const pattern = new RegExp(`node_modules/(${singleChunkModules.join('|')})/`);
  if (!output.manualChunks) output.manualChunks = {};
  const wrapManualChunks =
    (original: any) =>
    (id: string, ...args: any[]) => {
      const [_, moduleName] = id.match(pattern) || [];
      if (moduleName) {
        return moduleName;
      }
      if (typeof original === 'function') {
        return original(id, ...args);
      }
      if (typeof original === 'object' && original) {
        return original[id];
      }
    };
  output.manualChunks = wrapManualChunks(output.manualChunks);
}
