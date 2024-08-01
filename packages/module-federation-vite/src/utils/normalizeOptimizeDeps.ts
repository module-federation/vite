import { UserConfig } from "vite";

export interface Command {
  command: string;
}

export default {
  name: 'normalizeOptimizeDeps',
  config: (config: UserConfig, { command }: Command) => {
    let { optimizeDeps } = config;
    if (!optimizeDeps) {
      config.optimizeDeps = {};
      optimizeDeps = config.optimizeDeps;
    }
    if (!optimizeDeps.include) optimizeDeps.include = [];
    if (!optimizeDeps.needsInterop) optimizeDeps.needsInterop = [];
  }
};