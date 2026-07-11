/**
 * Dynamic shared modules, such as "react/" and "react-dom/", can only be parsed during the build process;
 * This plugin allows me to wait until all modules are built, and then expose them together.
 */
import type { Plugin } from 'vite';
import { mfWarn } from '../utils/logger';

let _resolve: ((value: any) => void) | null = null;
let _parseTimeout: ReturnType<typeof setTimeout> | null = null;
let _settleTimeout: ReturnType<typeof setTimeout> | null = null;

let parsePromise = Promise.resolve(1);

let parseStartSet = new Set<string>();
let parseEndSet = new Set<string>();
let lastLoadedModule = '';
let lastParsedModule = '';

function clearParseTimeout() {
  if (_parseTimeout) {
    clearTimeout(_parseTimeout);
    _parseTimeout = null;
  }
}

function clearSettleTimeout() {
  if (_settleTimeout) {
    clearTimeout(_settleTimeout);
    _settleTimeout = null;
  }
}

function resetParseState() {
  clearParseTimeout();
  clearSettleTimeout();
  parseStartSet = new Set();
  parseEndSet = new Set();
  lastLoadedModule = '';
  lastParsedModule = '';
  parsePromise = new Promise((resolve) => {
    _resolve = (v: any) => {
      clearParseTimeout();
      clearSettleTimeout();
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
    const pendingModules = Array.from(parseStartSet).filter(
      (moduleId) => !parseEndSet.has(moduleId)
    );
    mfWarn(
      `moduleParseIdleTimeout: no module activity for ${timeout}s, forcing resolve. ` +
        'Some shared/remote dependencies may be missing. Consider increasing moduleParseIdleTimeout.' +
        ` Tracked modules: ${parseEndSet.size}/${parseStartSet.size}.` +
        (lastLoadedModule ? ` Last loaded: ${lastLoadedModule}.` : '') +
        (lastParsedModule ? ` Last parsed: ${lastParsedModule}.` : '') +
        (pendingModules.length ? ` Pending modules: ${pendingModules.slice(0, 10).join(', ')}` : '')
    );
    _resolve?.(1);
  }, timeout * 1000);
}

function scheduleParseCompletionCheck() {
  clearSettleTimeout();
  _settleTimeout = setTimeout(() => {
    _settleTimeout = null;
    // Vite/Rolldown can report moduleParsed for cached or internally loaded
    // modules that did not pass through this plugin's load hook. Completion is
    // therefore a subset check: every tracked load must have parsed; additional
    // parsed modules do not keep the barrier open.
    const parseCompleted =
      parseStartSet.size > 0 &&
      Array.from(parseStartSet).every((moduleId) => parseEndSet.has(moduleId));
    if (parseCompleted) _resolve?.(1);
  }, 0);
}

interface ModuleParseOptions {
  moduleParseTimeout: number;
  moduleParseIdleTimeout?: number;
  exposedModuleImports?: string[];
}

export default function (excludeFn: Function, options: ModuleParseOptions): Plugin[] {
  // Large builds can exceed a fixed total timeout while still making progress.
  // Default to an idle timeout so we only force-resolve after parsing stalls.
  const idleTimeout = options.moduleParseIdleTimeout ?? options.moduleParseTimeout;
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
      async buildStart() {
        resetParseState();
        if (idleTimeout) {
          resetIdleTimeout(idleTimeout);
        } else if (options.moduleParseTimeout) {
          setParseTimeout(options.moduleParseTimeout);
        }
        // Exposed modules are emitted as independent entry chunks rather than
        // children of the application's entry graph. Seed them up front so an
        // otherwise-complete entry cannot finalize shared export usage before
        // Rollup starts loading those expose entries.
        for (const importSource of options.exposedModuleImports || []) {
          const resolved = await this.resolve(importSource);
          if (resolved && !resolved.external && !excludeFn(resolved.id)) {
            parseStartSet.add(resolved.id);
          }
        }
      },
      load(id) {
        lastLoadedModule = id;
        if (excludeFn(id)) {
          return;
        }
        clearSettleTimeout();
        if (idleTimeout) resetIdleTimeout(idleTimeout);
        parseStartSet.add(id);
      },
    },
    {
      enforce: 'post',
      name: 'parseEnd',
      apply: 'build',
      moduleParsed(module) {
        clearSettleTimeout();
        const id = module.id;
        lastParsedModule = id;
        if (idleTimeout) {
          // Reset idle timer on every module — any activity means the build is still progressing.
          resetIdleTimeout(idleTimeout);
        }
        // Rollup reports moduleParsed for an importer before it necessarily
        // loads/parses that importer's dependencies. Seed the pending set from
        // the resolved graph now; otherwise an entry can make start/end sizes
        // equal and resolve parsePromise before child modules contribute shared
        // export usage.
        const parsedModule = module as typeof module & {
          importedIdResolutions?: Array<{ id: string; external?: boolean | 'absolute' }>;
          dynamicallyImportedIdResolutions?: Array<{
            id: string;
            external?: boolean | 'absolute';
          }>;
        };
        const addPendingResolutions = (
          resolutions: Array<{ id: string; external?: boolean | 'absolute' }> | undefined
        ) => {
          for (const resolution of resolutions || []) {
            if (!resolution.external && !excludeFn(resolution.id)) {
              parseStartSet.add(resolution.id);
            }
          }
        };
        addPendingResolutions(parsedModule.importedIdResolutions);
        addPendingResolutions(parsedModule.dynamicallyImportedIdResolutions);
        if (!excludeFn(id)) {
          parseEndSet.add(id);
        }
        scheduleParseCompletionCheck();
      },
      buildEnd() {
        _resolve?.(1);
      },
    },
  ];
}
export { parsePromise };
