/**
 * Dynamic shared modules, such as "react/" and "react-dom/", can only be parsed during the build process;
 * This plugin allows me to wait until all modules are built, and then expose them together.
 */
import { Plugin } from 'vite';

let _resolve: any, _reject: any, _parseTimeout: any;

const promise = new Promise((resolve, reject) => {
  _resolve = (v: any) => {
    clearTimeout(_parseTimeout);
    _parseTimeout = null;
    resolve(v);
  };
  _reject = (e: any) => {
    clearTimeout(_parseTimeout);
    _parseTimeout = null;
    reject(e);
  };
});

function setParseTimeout(timeout: number) {
  if (!_parseTimeout) {
    _parseTimeout = setTimeout(() => {
      console.warn(`Parse timeout (${timeout}s) - forcing resolve`);
      _resolve(1);
    }, timeout * 1000);
  }
}

let parsePromise = promise;
let exposesParseEnd = false;

const parseStartSet = new Set();
const parseEndSet = new Set();

interface ModuleParseOptions {
  moduleParseTimeout: number;
  virtualExposesId: string;
}

export default function (excludeFn: Function, options: ModuleParseOptions): Plugin[] {
  setParseTimeout(options.moduleParseTimeout);
  return [
    {
      name: '_',
      apply: 'serve',
      config() {
        // No waiting in development mode
        _resolve(1);
      },
    },
    {
      enforce: 'pre',
      name: 'parseStart',
      apply: 'build',
      load(id) {
        if (excludeFn(id)) {
          return;
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
        if (excludeFn(id)) {
          return;
        }
        parseEndSet.add(id);
        if (exposesParseEnd && parseStartSet.size === parseEndSet.size) {
          _resolve(1);
        }
      },
    },
  ];
}
export { parsePromise };
