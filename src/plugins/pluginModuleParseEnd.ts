/**
 * Dynamic shared modules, such as "react/" and "react-dom/", can only be parsed during the build process;
 * This plugin allows me to wait until all modules are built, and then expose them together.
 */
import type { Plugin } from 'vite';
import { mfWarn } from '../utils/logger';

type ParseCompletion =
  | { complete: true; reason: 'graph-complete' }
  | {
      complete: false;
      reason: 'initial' | 'timeout' | 'idle-timeout' | 'build-end';
    };

/**
 * Additional quiet window granted when the only outstanding modules were seeded
 * speculatively from `importedIds`. Quiescence is the only available signal
 * that such an id is an external the graph will never load, and there is no
 * event for it — any load/parse activity cancels this timer, so it elapses only
 * after the whole graph has gone silent for far longer than the settle
 * debounce below.
 */
const SPECULATIVE_SETTLE_TIMEOUT = 250;

export function createModuleParseController() {
  return {
    resolve: null as ((value: ParseCompletion) => void) | null,
    parseTimeout: null as ReturnType<typeof setTimeout> | null,
    settleTimeout: null as ReturnType<typeof setTimeout> | null,
    speculativeTimeout: null as ReturnType<typeof setTimeout> | null,
    parsePromise: Promise.resolve<ParseCompletion>({
      complete: false,
      reason: 'initial',
    }),
    parseStartSet: new Set<string>(),
    parseEndSet: new Set<string>(),
    // One discard warning per build, however many shared consumers ask for the
    // analysis after the barrier gave up.
    discardWarned: false,
    // Ids seeded from `importedIds` that have not been observed in the load
    // hook or `moduleParsed` yet. Under Rolldown these can be external ids,
    // which never load and would otherwise stall the barrier forever.
    speculativeSet: new Set<string>(),
    lastLoadedModule: '',
    lastParsedModule: '',
  };
}

type ModuleParseController = ReturnType<typeof createModuleParseController>;

function clearParseTimeout(controller: ModuleParseController) {
  if (controller.parseTimeout) {
    clearTimeout(controller.parseTimeout);
    controller.parseTimeout = null;
  }
}

function clearSettleTimeout(controller: ModuleParseController) {
  if (controller.settleTimeout) {
    clearTimeout(controller.settleTimeout);
    controller.settleTimeout = null;
  }
  if (controller.speculativeTimeout) {
    clearTimeout(controller.speculativeTimeout);
    controller.speculativeTimeout = null;
  }
}

function resetParseState(controller: ModuleParseController) {
  clearParseTimeout(controller);
  clearSettleTimeout(controller);
  controller.parseStartSet = new Set();
  controller.parseEndSet = new Set();
  controller.speculativeSet = new Set();
  controller.discardWarned = false;
  controller.lastLoadedModule = '';
  controller.lastParsedModule = '';
  controller.parsePromise = new Promise<ParseCompletion>((resolve) => {
    controller.resolve = (result) => {
      clearParseTimeout(controller);
      clearSettleTimeout(controller);
      resolve(result);
    };
  });
}

function setParseTimeout(controller: ModuleParseController, timeout: number) {
  if (!controller.parseTimeout) {
    controller.parseTimeout = setTimeout(() => {
      mfWarn(`Parse timeout (${timeout}s) - forcing resolve`);
      controller.resolve?.({ complete: false, reason: 'timeout' });
    }, timeout * 1000);
  }
}

function resetIdleTimeout(controller: ModuleParseController, timeout: number) {
  clearParseTimeout(controller);
  controller.parseTimeout = setTimeout(() => {
    const pendingModules = Array.from(controller.parseStartSet).filter(
      (moduleId) => !controller.parseEndSet.has(moduleId)
    );
    mfWarn(
      `moduleParseIdleTimeout: no module activity for ${timeout}s, forcing resolve. ` +
        'Some shared/remote dependencies may be missing. Consider increasing moduleParseIdleTimeout.' +
        ` Tracked modules: ${controller.parseEndSet.size}/${controller.parseStartSet.size}.` +
        (controller.lastLoadedModule ? ` Last loaded: ${controller.lastLoadedModule}.` : '') +
        (controller.lastParsedModule ? ` Last parsed: ${controller.lastParsedModule}.` : '') +
        (pendingModules.length ? ` Pending modules: ${pendingModules.slice(0, 10).join(', ')}` : '')
    );
    controller.resolve?.({ complete: false, reason: 'idle-timeout' });
  }, timeout * 1000);
}

function getUnparsedIds(controller: ModuleParseController): string[] {
  return Array.from(controller.parseStartSet).filter(
    (moduleId) => !controller.parseEndSet.has(moduleId)
  );
}

function scheduleParseCompletionCheck(controller: ModuleParseController) {
  clearSettleTimeout(controller);
  // Give Rollup/Vite a short scheduling window to load child modules after
  // parsing an importer. Some environments report moduleParsed before the
  // child load, without exposing resolution metadata on the module object.
  controller.settleTimeout = setTimeout(() => {
    controller.settleTimeout = null;
    // Vite/Rolldown can report moduleParsed for cached or internally loaded
    // modules that did not pass through this plugin's load hook. Completion is
    // therefore a subset check: every tracked load must have parsed; additional
    // parsed modules do not keep the barrier open.
    const unparsedIds = getUnparsedIds(controller);
    if (unparsedIds.length === 0) {
      if (controller.parseStartSet.size > 0) {
        controller.resolve?.({ complete: true, reason: 'graph-complete' });
      }
      return;
    }
    // A speculatively seeded id that never reaches the load hook cannot be a
    // module this build will parse — Rolldown reports external ids through
    // `importedIds` with a ModuleInfo and no `isExternal` marker, so they are
    // indistinguishable at seed time. Grant one longer quiet window before
    // giving up on them; dropping them at the settle debounce would discard
    // children that #994 deliberately waits for.
    if (!unparsedIds.every((moduleId) => controller.speculativeSet.has(moduleId))) {
      return;
    }
    controller.speculativeTimeout = setTimeout(() => {
      controller.speculativeTimeout = null;
      const stillUnparsed = getUnparsedIds(controller);
      if (
        stillUnparsed.length === 0 ||
        !stillUnparsed.every((moduleId) => controller.speculativeSet.has(moduleId))
      ) {
        return;
      }
      for (const moduleId of stillUnparsed) {
        controller.parseStartSet.delete(moduleId);
        controller.speculativeSet.delete(moduleId);
      }
      if (controller.parseStartSet.size > 0) {
        controller.resolve?.({ complete: true, reason: 'graph-complete' });
      }
    }, SPECULATIVE_SETTLE_TIMEOUT);
  }, 10);
}

interface ModuleParseOptions {
  moduleParseTimeout: number;
  moduleParseIdleTimeout?: number;
  exposedModuleImports?: string[];
}

function getConfiguredInputImports(input: unknown): string[] {
  if (typeof input === 'string') return [input];
  if (Array.isArray(input))
    return input.filter((entry): entry is string => typeof entry === 'string');
  if (!input || typeof input !== 'object') return [];
  return Object.values(input).filter((entry): entry is string => typeof entry === 'string');
}

export default function (
  excludeFn: Function,
  options: ModuleParseOptions,
  controller = createModuleParseController()
): Plugin[] {
  // Large builds can exceed a fixed total timeout while still making progress.
  // Default to an idle timeout so we only force-resolve after parsing stalls.
  const idleTimeout = options.moduleParseIdleTimeout ?? options.moduleParseTimeout;
  let configuredInputImports: string[] = [];
  return [
    {
      enforce: 'pre',
      name: 'parseStart',
      apply: 'build',
      configResolved(config) {
        const buildOptions = config.build as typeof config.build & {
          rolldownOptions?: { input?: unknown };
        };
        configuredInputImports = getConfiguredInputImports(
          buildOptions.rollupOptions.input ?? buildOptions.rolldownOptions?.input
        );
      },
      async buildStart() {
        resetParseState(controller);
        if (idleTimeout) {
          resetIdleTimeout(controller, idleTimeout);
        } else if (options.moduleParseTimeout) {
          setParseTimeout(controller, options.moduleParseTimeout);
        }
        // Exposed modules and explicit Rollup inputs can be scheduled
        // independently. Seed every known entry before loading starts so one
        // fast entry cannot finalize shared export usage ahead of the others.
        const entryImports = new Set([
          ...(options.exposedModuleImports || []),
          ...configuredInputImports,
        ]);
        for (const importSource of entryImports) {
          const resolved = await this.resolve(importSource);
          if (resolved && !resolved.external && !excludeFn(resolved.id)) {
            controller.parseStartSet.add(resolved.id);
          }
        }
      },
      load(id) {
        controller.lastLoadedModule = id;
        if (excludeFn(id)) {
          return;
        }
        clearSettleTimeout(controller);
        if (idleTimeout) resetIdleTimeout(controller, idleTimeout);
        // Reaching the load hook proves the id is a real module, not an
        // external the graph will never parse.
        controller.speculativeSet.delete(id);
        controller.parseStartSet.add(id);
      },
    },
    {
      enforce: 'post',
      name: 'parseEnd',
      apply: 'build',
      moduleParsed(module) {
        clearSettleTimeout(controller);
        const id = module.id;
        controller.lastParsedModule = id;
        if (idleTimeout) {
          // Reset idle timer on every module — any activity means the build is still progressing.
          resetIdleTimeout(controller, idleTimeout);
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
              controller.parseStartSet.add(resolution.id);
            }
          }
        };
        const addPendingIds = (ids: string[] | undefined) => {
          for (const pendingId of ids || []) {
            const moduleInfo = this.getModuleInfo(pendingId);
            // Only seed modules the bundler has admitted into the graph;
            // unresolved/unknown ids remain covered by the load hook or make
            // the completion result conservative. Rollup omits ModuleInfo for
            // externals, but Rolldown returns a stub for them with no
            // `isExternal` marker, so treat these seeds as speculative until
            // the load hook confirms them.
            if (moduleInfo && !excludeFn(pendingId)) {
              if (
                !controller.parseStartSet.has(pendingId) &&
                !controller.parseEndSet.has(pendingId)
              ) {
                controller.speculativeSet.add(pendingId);
              }
              controller.parseStartSet.add(pendingId);
            }
          }
        };
        addPendingResolutions(parsedModule.importedIdResolutions);
        addPendingResolutions(parsedModule.dynamicallyImportedIdResolutions);
        if (parsedModule.importedIdResolutions === undefined) {
          addPendingIds(module.importedIds);
        }
        if (parsedModule.dynamicallyImportedIdResolutions === undefined) {
          addPendingIds(module.dynamicallyImportedIds);
        }
        controller.speculativeSet.delete(id);
        if (!excludeFn(id)) {
          controller.parseEndSet.add(id);
        }
        scheduleParseCompletionCheck(controller);
      },
      buildEnd() {
        controller.resolve?.({ complete: false, reason: 'build-end' });
      },
    },
  ];
}
