import { mfWarn } from '../../utils/logger';
import type { HmrAdapter } from '../pluginDevRemoteHmr';

/**
 * In dev mode each Vite dev server serves its own copy of Vue
 * (`/node_modules/.vite/deps/vue.js`). When a remote module is loaded into the
 * host page, the remote's Vue copy evaluates and runs:
 *
 *     globalThis.__VUE_HMR_RUNTIME__ = createHotReloadAPI()
 *
 * which silently overwrites the host's runtime. After that, `createRecord` for
 * host components lives in the orphaned first runtime, but `reload(hmrId, ...)`
 * goes through the second runtime — the lookup misses and HMR stops working.
 *
 * This guard pins `__VUE_HMR_RUNTIME__` to the first writer (the host's Vue)
 * via a property trap on `globalThis`. Subsequent writes from remote-side Vue
 * copies are silently dropped. Must execute before any Vue module loads —
 * injected as a plain (non-module) script at `head-prepend`.
 *
 * `singleton: true` in `shared` is not sufficient: in dev mode MF's share-scope
 * does not actually dedupe Vue across dev servers, so without this guard the
 * last-loaded copy wins.
 */
const VUE_HMR_RUNTIME_GUARD_SCRIPT = `
(function () {
  var h = null;
  Object.defineProperty(globalThis, '__VUE_HMR_RUNTIME__', {
    get: function () { return h; },
    set: function (v) { if (h === null) h = v; },
    configurable: true,
    enumerable: true,
  });
})();`;

/**
 * `@vitejs/plugin-vue` derives an SFC's `__hmrId` from a hash of the file path
 * relative to Vite's `root`. With module federation, host and remote are
 * separate Vite projects with independent roots — so an SFC at `src/App.vue`
 * in both will hash to the same id. Once both copies of Vue collapse onto the
 * shared `__VUE_HMR_RUNTIME__` (see the guard above), the host's instance and
 * the remote's instance both register under that single id. A remote-only
 * file change then calls `rerender(id, newRender)`, which iterates *every*
 * instance under that id — including the host one — and applies the remote's
 * render function to the host instance. The host's `setupState` doesn't have
 * the remote's bindings, so the render throws and Vue falls back to a full
 * reload required warning.
 *
 * Fix: rewrite the remote's emitted `__hmrId` literal to be prefixed with the
 * federation `name`, so the remote's instances live under a distinct key. The
 * accept callback emitted by plugin-vue reads `_sfc_main.__hmrId` /
 * `updated.__hmrId` at runtime, so rewriting the literal once is enough.
 */
const SFC_HMR_ID_LITERAL_RE = /(\.__hmrId\s*=\s*["'`])([^"'`]+)(["'`])/g;

function rewriteSfcHmrId(code: string, federationName: string): { code: string; matched: boolean } {
  let matched = false;
  const next = code.replace(SFC_HMR_ID_LITERAL_RE, (_match, prefix, id, suffix) => {
    matched = true;
    if (id.startsWith(`${federationName}-`)) return `${prefix}${id}${suffix}`;
    return `${prefix}${federationName}-${id}${suffix}`;
  });
  return { code: next, matched };
}

// Sentinel: once tripped, suppresses further warnings for the lifetime of the
// process. Guards against `@vitejs/plugin-vue` changing its emitted code in a
// way that breaks `SFC_HMR_ID_LITERAL_RE` without anyone noticing.
let pluginVueRegressionWarned = false;

function warnPluginVueRegression() {
  if (pluginVueRegressionWarned) return;
  pluginVueRegressionWarned = true;
  mfWarn(
    'Detected a Vue SFC module that calls `__VUE_HMR_RUNTIME__.createRecord(` ' +
      'but no `.__hmrId = "..."` literal could be rewritten. @vitejs/plugin-vue ' +
      'may have changed its output format — without the rewrite, host and remote ' +
      'SFCs that share a path will collide on the shared HMR runtime. ' +
      'Please report this to @module-federation/vite.'
  );
}

export const vueAdapter: HmrAdapter = {
  name: 'vue',
  pluginNames: [
    'vite:vue', // @vitejs/plugin-vue
    'vite:vue-jsx', // @vitejs/plugin-vue-jsx
  ],
  host: {
    transformIndexHtml() {
      return [
        {
          tag: 'script',
          children: VUE_HMR_RUNTIME_GUARD_SCRIPT,
          injectTo: 'head-prepend',
        },
      ];
    },
  },
  remote: {
    transform(code, _id, ctx) {
      if (!code.includes('__VUE_HMR_RUNTIME__.createRecord(')) return;

      const { code: rewritten, matched } = rewriteSfcHmrId(code, ctx.options.name);
      if (!matched) {
        warnPluginVueRegression();
        return undefined;
      }
      return rewritten === code ? undefined : rewritten;
    },
  },
};
