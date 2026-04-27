import { createInstance } from '@module-federation/runtime';

export const mfRuntime = createInstance({
  name: 'host',
  remotes: [],
});
