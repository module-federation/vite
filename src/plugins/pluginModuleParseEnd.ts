/**
 * Dynamic shared modules, such as the "react/" namespace prefix, can only be
 * parsed during the build process. Trailing-slash `react-dom/` keys collapse to
 * the package root after #1158, so they are not a dynamic prefix.
 * This plugin waits until all modules are built, then exposes them together.
 */
import type { Plugin } from 'vite';
import { mfWarn } from '../utils/logger';

type ParseCompletion =
  | { complete: true; reason: 'graph-complete' }
  | {
      complete: false;
      reason: 'initial' | 'timeout' | 'idle-timeout' | 'build-end';
    };

export function createModuleParseController() {
  return {
    resolve: null as ((value: ParseCompletion) => void) | null,
    parseTimeout: null as ReturnType<typeof setTimeout> | null,
    settleTimeout: null as ReturnType<typeof setTimeout> | null,
    parsePromise: Promise.resolve<ParseCompletion>({
      complete: false,
      reason: 'initial',
    }),
    parseStartSet: new Set<string>(),
    parseEndSet: new Set<string>(),
    // One discard warning per build, however many shared consumers ask for the
    // analysis after the barrier gave up.
    discardWarned: false,
    externalSet: new Set<string>(),
    // Ids already sent through `this.resolve` to determine externality, so each
    // one is probed at most once per build.
    resolutionProbed: new Set<string>(),
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
}

function resetParseState(controller: ModuleParseController) {
  clearParseTimeout(controller);
  clearSettleTimeout(controller);
  controller.parseStartSet = new Set();
  controller.parseEndSet = new Set();
  controller.externalSet = new Set();
  controller.resolutionProbed = new Set();
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
    const parseCompleted =
      controller.parseStartSet.size > 0 &&
      Array.from(controller.parseStartSet).every((moduleId) =>
        controller.parseEndSet.has(moduleId)
      );
    if (parseCompleted) {
      controller.resolve?.({ complete: true, reason: 'graph-complete' });
    }
  }, 10);
}

interface ModuleParseOptions {
  moduleParseTimeout: number;
  moduleParseIdleTimeout?: number;
  exposedModuleImports?: string[];
}

type ExternalOption =
  | string
  | RegExp
  | Array<string | RegExp>
  | ((source: string, importer: string | undefined, isResolved: boolean) => boolean | null | void);

function matchesExternal(
  external: ExternalOption | undefined,
  id: string,
  importer: string
): boolean {
  if (!external) return false;
  if (typeof external === 'function') return external(id, importer, true) === true;
  const entries = Array.isArray(external) ? external : [external];
  return entries.some((entry) => {
    if (typeof entry === 'string') return entry === id;
    entry.lastIndex = 0;
    return entry.test(id);
  });
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
  let configuredExternal: ExternalOption | undefined;
  return [
    {
      enforce: 'pre',
      name: 'parseStart',
      apply: 'build',
      configResolved(config) {
        const buildOptions = config.build as typeof config.build & {
          rolldownOptions?: { input?: unknown; external?: ExternalOption };
        };
        configuredInputImports = getConfiguredInputImports(
          buildOptions.rollupOptions.input ?? buildOptions.rolldownOptions?.input
        );
        configuredExternal =
          buildOptions.rollupOptions.external ?? buildOptions.rolldownOptions?.external;
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
        // Rolldown returns ModuleInfo stubs for externals and exposes no field
        // that separates them from modules the build has not loaded yet, so the
        // resolution has to be repeated. `this.resolve` replays the whole
        // resolveId chain, which means an external produced by a plugin ordered
        // before this one is still observed — watching our own resolveId hook
        // cannot see those, because resolution is first-wins.
        const probeExternal = (pendingId: string) => {
          if (typeof this.resolve !== 'function') return;
          if (controller.resolutionProbed.has(pendingId)) return;
          controller.resolutionProbed.add(pendingId);
          void this.resolve(pendingId, id, { skipSelf: true })
            .then((resolved) => {
              if (!resolved?.external) return;
              controller.externalSet.add(pendingId);
              controller.parseStartSet.delete(pendingId);
              // The dropped id may have been the last one the barrier waited on.
              scheduleParseCompletionCheck(controller);
            })
            .catch(() => {});
        };
        const addPendingIds = (ids: string[] | undefined) => {
          for (const pendingId of ids || []) {
            if (
              !this.getModuleInfo(pendingId) ||
              controller.externalSet.has(pendingId) ||
              matchesExternal(configuredExternal, pendingId, id) ||
              excludeFn(pendingId)
            ) {
              continue;
            }
            controller.parseStartSet.add(pendingId);
            // Until the resolution answers, the id keeps the barrier open —
            // waiting is the safe direction.
            if (!controller.parseEndSet.has(pendingId)) probeExternal(pendingId);
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
