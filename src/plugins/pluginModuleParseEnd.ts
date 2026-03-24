/**
 * Dynamic shared modules, such as "react/" and "react-dom/", can only be parsed during the build process;
 * This plugin allows me to wait until all modules are built, and then expose them together.
 */
import { Plugin } from 'vite';
import { mfWarn } from '../utils/logger';

export interface ModuleParseState {
  promise: Promise<number>;
  resolve: (value: number) => void;
  reject: (error: unknown) => void;
  parseTimeout: ReturnType<typeof setTimeout> | null;
  exposesParseEnd: boolean;
  parseStartSet: Set<string>;
  parseEndSet: Set<string>;
}

function resetModuleParsePromise(state: ModuleParseState) {
  let resolve!: (value: number) => void;
  let reject!: (error: unknown) => void;

  state.promise = new Promise<number>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  state.resolve = (value: number) => {
    clearTimeout(state.parseTimeout ?? undefined);
    state.parseTimeout = null;
    resolve(value);
  };
  state.reject = (error: unknown) => {
    clearTimeout(state.parseTimeout ?? undefined);
    state.parseTimeout = null;
    reject(error);
  };
}

export function createModuleParseState(): ModuleParseState {
  const state: ModuleParseState = {
    promise: Promise.resolve(1),
    resolve: () => {},
    reject: () => {},
    parseTimeout: null,
    exposesParseEnd: false,
    parseStartSet: new Set<string>(),
    parseEndSet: new Set<string>(),
  };

  resetModuleParsePromise(state);

  return state;
}

function setParseTimeout(state: ModuleParseState, timeout: number) {
  if (!state.parseTimeout) {
    state.parseTimeout = setTimeout(() => {
      mfWarn(`Parse timeout (${timeout}s) - forcing resolve`);
      state.resolve(1);
    }, timeout * 1000);
  }
}

function resetIdleTimeout(state: ModuleParseState, timeout: number) {
  clearTimeout(state.parseTimeout ?? undefined);
  state.parseTimeout = setTimeout(() => {
    mfWarn(
      `moduleParseIdleTimeout: no module activity for ${timeout}s, forcing resolve. ` +
        'Some shared/remote dependencies may be missing. Consider increasing moduleParseIdleTimeout.'
    );
    state.resolve(1);
  }, timeout * 1000);
}

function resetParseTrackingState(state: ModuleParseState) {
  clearTimeout(state.parseTimeout ?? undefined);
  state.parseTimeout = null;
  state.exposesParseEnd = false;
  state.parseStartSet.clear();
  state.parseEndSet.clear();
  resetModuleParsePromise(state);
}

interface ModuleParseOptions {
  moduleParseTimeout: number;
  moduleParseIdleTimeout?: number;
  virtualExposesId: string;
}

export default function (
  excludeFn: Function,
  options: ModuleParseOptions,
  state: ModuleParseState
): Plugin[] {
  const idleTimeout = options.moduleParseIdleTimeout;
  return [
    {
      name: '_',
      apply: 'serve',
      config() {
        state.resolve(1);
      },
    },
    {
      enforce: 'pre',
      name: 'parseStart',
      apply: 'build',
      buildStart() {
        resetParseTrackingState(state);
        if (idleTimeout) {
          resetIdleTimeout(state, idleTimeout);
        } else {
          setParseTimeout(state, options.moduleParseTimeout);
        }
      },
      load(id) {
        if (excludeFn(id)) {
          return;
        }
        state.parseStartSet.add(id);
      },
    },
    {
      enforce: 'post',
      name: 'parseEnd',
      apply: 'build',
      moduleParsed(module) {
        const id = module.id;
        if (id === options.virtualExposesId) {
          state.exposesParseEnd = true;
        }
        if (idleTimeout) {
          resetIdleTimeout(state, idleTimeout);
        }
        if (excludeFn(id)) {
          return;
        }
        state.parseEndSet.add(id);
        if (state.exposesParseEnd && state.parseStartSet.size === state.parseEndSet.size) {
          state.resolve(1);
        }
      },
    },
  ];
}
