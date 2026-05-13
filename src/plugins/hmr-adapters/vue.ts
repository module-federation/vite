import { mfWarn } from '../../utils/logger';
import type { HmrAdapter } from '../pluginDevRemoteHmr';

const VUE_RUNTIME_PACKAGES = ['vue', '@vue/runtime-core', '@vue/runtime-dom'];

export const vueAdapter: HmrAdapter = {
  name: 'vue',
  pluginNames: [
    'vite:vue', // @vitejs/plugin-vue
    'vite:vue-jsx', // @vitejs/plugin-vue-jsx
  ],
  /**
   * Vue's `__VUE_HMR_RUNTIME__` lives inside `@vue/runtime-core` and is
   * attached to `globalThis` on module load. Cross-federation HMR works only
   * when host and remote share the same Vue copy — otherwise
   * `createRecord`/`reload` writes to one map and reads from another.
   * Warn when this is misconfigured so users don't silently lose hot updates.
   */
  validate({ options }) {
    const hasSingletonVue = VUE_RUNTIME_PACKAGES.some(
      (name) => options.shared[name]?.shareConfig.singleton === true
    );
    if (hasSingletonVue) return;

    mfWarn(
      'remoteHmr is enabled and a Vue plugin (vite:vue / vite:vue-jsx) was detected, ' +
        'but "vue" is not configured as a singleton in `shared`. ' +
        'Cross-federation Vue HMR requires a single shared `@vue/runtime-core` instance — ' +
        'add `shared: { vue: { singleton: true } }` (or set `remoteHmr: "full-reload"`).'
    );
  },
};
