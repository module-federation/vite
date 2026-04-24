/**
 * Dynamic shared modules, such as "react/" and "react-dom/", can only be parsed during the build process;
 * This plugin allows me to wait until all modules are built, and then expose them together.
 */
import type { Plugin } from 'vite';
import { mfWarn } from '../utils/logger';

let _resolve: ((value: any) => void) | null = null;
let _parseTimeout: ReturnType<typeof setTimeout> | null = null;

let parsePromise = Promise.resolve(1);
let exposesParseEnd = false;
let expectsExposesParseEnd = false;

let parseStartSet = new Set<string>();
let parseEndSet = new Set<string>();

function clearParseTimeout() {
  if (_parseTimeout) {
    clearTimeout(_parseTimeout);
    _parseTimeout = null;
  }
}

function resetParseState() {
  clearParseTimeout();
  exposesParseEnd = false;
  expectsExposesParseEnd = false;
  parseStartSet = new Set();
  parseEndSet = new Set();
  parsePromise = new Promise((resolve) => {
    _resolve = (v: any) => {
      clearParseTimeout();
      resolve(v);
    };
  });
}

function setParseTimeout(timeout: number) {
  if (!_parseTimeout) {
    _parseTimeout = setTimeout(() => {
      mfWarn(`Parse timeout (${timeout}s) - forcing resolve`);
      _resolve?.(1);
    }, timeout * 1000);
  }
}

function resetIdleTimeout(timeout: number) {
  clearParseTimeout();
  _parseTimeout = setTimeout(() => {
    mfWarn(
      `moduleParseIdleTimeout: no module activity for ${timeout}s, forcing resolve. ` +
        'Some shared/remote dependencies may be missing. Consider increasing moduleParseIdleTimeout.'
    );
    _resolve?.(1);
  }, timeout * 1000);
}

interface ModuleParseOptions {
  moduleParseTimeout: number;
  moduleParseIdleTimeout?: number;
  virtualExposesId: string;
}

export default function (excludeFn: Function, options: ModuleParseOptions): Plugin[] {
  const idleTimeout = options.moduleParseIdleTimeout;
  return [
    {
      name: '_',
      apply: 'serve',
      config() {
        // No waiting in development mode
        _resolve?.(1);
      },
    },
    {
      enforce: 'pre',
      name: 'parseStart',
      apply: 'build',
      buildStart() {
        resetParseState();
        if (idleTimeout) {
          resetIdleTimeout(idleTimeout);
        } else {
          setParseTimeout(options.moduleParseTimeout);
        }
      },
      load(id) {
        if (excludeFn(id)) {
          return;
        }
        if (id === options.virtualExposesId) {
          expectsExposesParseEnd = true;
        }
        parseStartSet.add(id);
      },
    },
    {
      enforce: 'post',
      name: 'parseEnd',
      apply: 'build',
      moduleParsed(module) {
        const id = module.id;
        if (id === options.virtualExposesId) {
          // When the entry JS file is empty and only contains exposes export code, it’s necessary to wait for the exposes modules to be resolved in order to collect the dependencies being used.
          exposesParseEnd = true;
        }
        if (idleTimeout) {
          // Reset idle timer on every module — any activity means the build is still progressing.
          resetIdleTimeout(idleTimeout);
        }
        if (excludeFn(id)) {
          return;
        }
        parseEndSet.add(id);
        const parseCompleted = parseStartSet.size === parseEndSet.size;
        const exposesCompleted = !expectsExposesParseEnd || exposesParseEnd;
        if (parseCompleted && exposesCompleted) {
          _resolve?.(1);
        }
      },
    },
  ];
}
export { parsePromise };
