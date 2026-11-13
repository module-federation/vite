import { describe, expect, it, vi } from 'vitest';
import { setImmediate } from 'node:timers/promises';
import { readFile } from 'node:fs';
import { Module } from 'node:module';
import { EventEmitter } from 'node:events';
import { SourceTextModule } from 'node:vm';
import { createSsrBuildGraph, SSR_BUILD_CONTEXT_KEY } from '../ssrBuildGraph';
import { sharedCacheHelperCode } from '../packageUtils';
import { loadViaVmStrategy } from '../ssrVmStrategy';
import {
  getRuntimeInitBootstrapCode,
  getRuntimeInitPromiseBootstrapCode,
  getRuntimeInitResolveBootstrapCode,
} from '../../virtualModules/virtualRuntimeInitStatus';

const listenersKey = Symbol.for('module-federation.shared-cache-listeners');
const helpers = () =>
  Function(`${sharedCacheHelperCode}; return {
  subscribe: __mfSubscribeSharedCache, write: __mfWriteSharedCache
};`)();
const descriptor = { canonical: 'default:test', aliases: [] };

describe('managed SSR build graphs', () => {
  it('returns an idempotent unsubscribe outside managed loading', () => {
    const cache: any = {};
    let calls = 0;
    const helper = helpers();
    const unsubscribe = helper.subscribe(cache, descriptor, () => calls++);
    helper.write(cache, descriptor, {});
    expect(calls).toBe(1);
    unsubscribe();
    unsubscribe();
    helper.write(cache, descriptor, {});
    expect(calls).toBe(1);
    expect(cache[listenersKey][descriptor.canonical].size).toBe(0);
  });

  it('owns subscriptions and executes notifications in their graph', async () => {
    const graph = await createSsrBuildGraph();
    const cache: any = {};
    const listener = (value: unknown) => {
      expect((globalThis as any)[SSR_BUILD_CONTEXT_KEY].getStore()).toBe(graph);
      received = value;
    };
    let received;
    const unsubscribe = graph.run(() => helpers().subscribe(cache, descriptor, listener));
    const subscribers: Set<unknown> = cache[listenersKey][descriptor.canonical];
    expect(subscribers.size).toBe(1);
    expect(subscribers.has(listener)).toBe(false);
    const update = {};
    helpers().write(cache, descriptor, update);
    expect(received).toBe(update);
    unsubscribe();
    expect(subscribers.size).toBe(0);
  });

  it('shares owner init state within a graph and isolates the same owner across generations', async () => {
    const owner = `test-build-${Math.random()}`;
    const key = `__mf_init__${owner}__`;
    const first = await createSsrBuildGraph();
    const second = await createSsrBuildGraph();
    const promise = (graph: typeof first) =>
      graph.run(() =>
        Function(`${getRuntimeInitPromiseBootstrapCode(false, owner)}; return initPromise;`)()
      );
    const a = promise(first);
    expect(promise(first)).toBe(a);
    const b = promise(second);
    expect(b).not.toBe(a);
    const resolve = first.run(() =>
      Function(`${getRuntimeInitResolveBootstrapCode(false, owner)}; return initResolve;`)()
    );
    resolve('first');
    await expect(a).resolves.toBe('first');
    expect((globalThis as any)[key]).toBeUndefined();
    first.run(() => Function(getRuntimeInitBootstrapCode(false, owner))());
    expect(first.initStates.get(key).initPromise).toBe(a);
    expect((globalThis as any)[key]).toBeUndefined();
  });

  it('retains factories, extracted exports, constructors and asynchronous context', async () => {
    const graph = await createSsrBuildGraph();
    const current = () => (globalThis as any)[SSR_BUILD_CONTEXT_KEY].getStore();
    class Widget {
      constructor(readonly marker: string) {
        expect(current()).toBe(graph);
      }
      read() {
        return this.marker;
      }
    }
    const exports = {
      Widget,
      async read() {
        await Promise.resolve();
        expect(current()).toBe(graph);
        return 'async';
      },
    };
    const container = graph.wrapContainer({
      init() {
        expect(current()).toBe(graph);
      },
      async get() {
        expect(current()).toBe(graph);
        return () => exports;
      },
    });
    container.init();
    const factory = await container.get();
    const module = factory();
    const Extracted = module.Widget;
    const instance = new Extracted('old');
    expect(instance).toBeInstanceOf(Widget);
    expect(instance).toBeInstanceOf(Extracted);
    expect(instance.read()).toBe('old');
    const read = module.read;
    expect(await read()).toBe('async');
  });

  it('preserves frozen properties, private fields and returned object identity', async () => {
    const graph = await createSsrBuildGraph();
    const result = { marker: 'same object' };
    class PrivateWidget {
      #value = 'private';
      read() {
        return this.#value;
      }
    }
    const exports = graph.wrapContainer(
      Object.freeze({
        read: () => result,
        async readAsync() {
          return result;
        },
        PrivateWidget,
      })
    );
    const frozenRead = exports.read;
    expect(frozenRead()).toBe(result);
    expect(await exports.readAsync()).toBe(result);
    expect(new exports.PrivateWidget().read()).toBe('private');
    const regular = graph.wrapContainer({ PrivateWidget, read: () => result });
    expect(new regular.PrivateWidget().read()).toBe('private');
    expect(regular.read()).toBe(result);
  });

  it('preserves setters, fluent receivers and argument identity on exposed objects', async () => {
    const graph = await createSsrBuildGraph();
    class Counter {
      #value = 0;
      get value() {
        return this.#value;
      }
      set value(next) {
        this.#value = next;
      }
      self() {
        return this;
      }
      async selfAsync() {
        return this;
      }
    }
    const counter = new Counter();
    const object = {};
    const exports = graph.wrapContainer({
      counter,
      object,
      isSame: (argument: unknown) => argument === object,
      echo: (argument: unknown) => argument,
      map: new Map(),
    });
    exports.counter.value = 2;
    expect(exports.counter.value).toBe(2);
    expect(exports.counter.self()).toBe(exports.counter);
    expect(await exports.counter.selfAsync()).toBe(exports.counter);
    expect(exports.isSame(exports.object)).toBe(true);
    expect(exports.echo(exports.object)).toBe(exports.object);
    expect(exports.map.set('object', exports.object)).toBe(exports.map);
    expect(exports.map.get('object')).toBe(exports.object);
  });

  it.skipIf(!SourceTextModule)(
    'registers the resolved node:module facade as a host external',
    async () => {
      const graph = await createSsrBuildGraph();
      const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(`
      import { Module } from 'node:module';
      export const init = () => {};
      export const get = async () => () => ({ getModule: () => Module });
    `)
      );
      try {
        const container = graph.wrapContainer(
          await graph.run(() =>
            loadViaVmStrategy('http://localhost:5998/remoteEntry.ssr.js', {
              resolvedShared: {},
              shareScopeName: 'default',
              versionKey: 'external-facade',
              cacheContext: {},
            })
          )
        ) as any;
        const exports = (await container.get('./Module'))();
        expect(exports.getModule()).toBe(Module);
        expect(
          (globalThis as any)[Symbol.for('module-federation.vite.ssr-build-externals')].has(Module)
        ).toBe(true);
        expect(
          (globalThis as any)[Symbol.for('module-federation.vite.ssr-build-export-owners')].get(
            Module
          )
        ).toBeUndefined();
      } finally {
        fetch.mockRestore();
      }
    }
  );

  it.skipIf(!SourceTextModule)(
    'keeps host constructors returned by VM createRequire outside graph ownership',
    async () => {
      const graph = await createSsrBuildGraph();
      const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(`
      import { createRequire } from 'node:module';
      const require = createRequire(import.meta.url);
      const { EventEmitter } = require('node:events');
      export const init = () => {};
      export const get = async () => () => ({ EventEmitter });
    `)
      );
      try {
        const container = graph.wrapContainer(
          await graph.run(() =>
            loadViaVmStrategy('http://localhost:5996/remoteEntry.ssr.js', {
              resolvedShared: {},
              shareScopeName: 'default',
              versionKey: 'external-require',
              cacheContext: {},
            })
          )
        ) as any;
        const exports = (await container.get('./Events'))();
        expect(exports.EventEmitter).toBe(EventEmitter);
        expect(new exports.EventEmitter()).toBeInstanceOf(EventEmitter);
        expect(
          (globalThis as any)[Symbol.for('module-federation.vite.ssr-build-export-owners')].get(
            EventEmitter
          )
        ).toBeUndefined();
      } finally {
        fetch.mockRestore();
      }
    }
  );

  it('preserves exact shared singleton objects and live export getters', async () => {
    const graph = await createSsrBuildGraph();
    const symbol = Symbol('shared-method');
    const shared = { createElement() {}, [symbol]() {} };
    const holder = globalThis as any;
    const previous = holder.__mf_module_cache__;
    holder.__mf_module_cache__ = { share: { 'default:react': shared } };
    try {
      let marker = 'v1';
      const exports = graph.wrapContainer({
        shared,
        symbolMethod: shared[symbol],
        hostArray: Array,
        get marker() {
          return marker;
        },
      });
      expect(exports.shared).toBe(shared);
      expect(exports.hostArray).toBe(Array);
      expect(exports.shared.createElement).toBe(shared.createElement);
      expect(exports.symbolMethod).toBe(shared[symbol]);
      marker = 'v2';
      expect(exports.marker).toBe('v2');
    } finally {
      holder.__mf_module_cache__ = previous;
    }
  });

  it('runs frozen containers, nested methods and returned callbacks in their graph', async () => {
    const graph = await createSsrBuildGraph();
    const cache: any = {};
    const owner = `frozen-lazy-${Math.random()}`;
    const lazy = Function(
      'cache',
      `${getRuntimeInitResolveBootstrapCode(false, owner)}
      ${sharedCacheHelperCode}
      __mfSubscribeSharedCache(cache, { canonical: 'default:frozen', aliases: [] }, () => {});
      return __mfResolveState;
    `
    );
    const frozen = Object.freeze({
      run: () => lazy(cache),
      get lazyValue() {
        return lazy(cache);
      },
    });
    const container = graph.wrapContainer(
      Object.freeze({
        init: () => undefined,
        get: async () => {
          lazy(cache);
          return () => Object.freeze({ nested: frozen, returned: () => frozen });
        },
      })
    );
    const exports = (await container.get())();
    exports.nested.run();
    exports.returned().run();
    void exports.nested.lazyValue;
    expect(graph.initStates.size).toBe(1);
    expect((globalThis as any)[`__mf_init__${owner}__`]).toBeUndefined();
    expect(Object.isFrozen(exports)).toBe(true);
    expect(Object.isFrozen(exports.nested)).toBe(true);
    expect(Reflect.set(exports.nested, 'run', () => {})).toBe(false);
    const subscribers =
      cache[Symbol.for('module-federation.shared-cache-listeners')]['default:frozen'];
    expect(subscribers.size).toBe(4);
  });

  it('preserves custom prototypes on readonly arrays and functions', async () => {
    const graph = await createSsrBuildGraph();
    class CustomArray extends Array<unknown> {}
    const array = Object.freeze(new CustomArray(() => 'array'));
    const functionPrototype = { marker: 'custom' };
    const fn = Object.assign(function () {}, { run: () => 'function' });
    Object.setPrototypeOf(fn, functionPrototype);
    Object.freeze(fn);
    const exports = graph.wrapContainer({ array, fn });
    expect(Array.isArray(exports.array)).toBe(true);
    expect(exports.array).toBeInstanceOf(CustomArray);
    expect(Object.getPrototypeOf(exports.array)).toBe(CustomArray.prototype);
    expect(Object.getPrototypeOf(exports.fn)).toBe(functionPrototype);
    expect(exports.fn.run()).toBe('function');
  });

  it.skipIf(!SourceTextModule)(
    'keeps VM lazy imports from frozen methods in the managed graph',
    async () => {
      const graph = await createSsrBuildGraph();
      const owner = `vm-frozen-${Math.random()}`;
      const cacheKey = `__${owner}`;
      const holder = globalThis as any;
      holder[cacheKey] = {};
      const sources: Record<string, string> = {
        'http://localhost:5997/entry.ssr.js': `export const container = Object.freeze({
        init() {}, get: async () => {
          await import('./lazy.js');
          return () => ({ nested: Object.freeze({ run: () => import('./nested.js') }) });
        }
      });`,
      };
      for (const name of ['lazy', 'nested'])
        sources[`http://localhost:5997/${name}.js`] = `
      ${getRuntimeInitResolveBootstrapCode(false, `${owner}-${name}`)}
      ${sharedCacheHelperCode}
      __mfSubscribeSharedCache(globalThis[${JSON.stringify(cacheKey)}], { canonical: 'default:frozen', aliases: [] }, () => {});
    `;
      const fetch = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async (url) => new Response(sources[String(url)]));
      try {
        const namespace = (await graph.run(() =>
          loadViaVmStrategy('http://localhost:5997/entry.ssr.js', {
            resolvedShared: {},
            shareScopeName: 'default',
            versionKey: owner,
            cacheContext: {},
          })
        )) as any;
        const container = graph.wrapContainer(namespace.container);
        const exports = (await container.get())();
        await exports.nested.run();
        expect(graph.initStates.size).toBe(2);
        for (const name of ['lazy', 'nested'])
          expect(holder[`__mf_init__${owner}-${name}__`]).toBeUndefined();
        expect(
          holder[cacheKey][Symbol.for('module-federation.shared-cache-listeners')]['default:frozen']
            .size
        ).toBe(2);
      } finally {
        fetch.mockRestore();
        delete holder[cacheKey];
      }
    }
  );

  it.skipIf(!global.gc)(
    'collects retired subscriptions after 100 replacements while held and in-flight exports remain live',
    async () => {
      const cache: any = {};
      const runtime = { hook() {} };
      const symbol = Symbol.for('graph-returned-callback');
      const externalSymbol = Symbol('external');
      const symbolExternal = () => {};
      const create = async () => {
        const graph = await createSsrBuildGraph();
        graph.registerExternal({ readFile });
        graph.registerExternal({ [externalSymbol]: symbolExternal });
        const exports = graph.run(() =>
          Function(
            'cache',
            'readFile',
            'runtime',
            'symbolExternal',
            `${sharedCacheHelperCode}
        let value;
        __mfSubscribeSharedCache(cache, { canonical: 'default:test', aliases: [] }, next => value = next);
        return {
          init: async () => runtime,
          read: () => value,
          frozen: Object.freeze({ read: (() => value).bind(null) }),
          wait: async gate => { await gate; return value; },
          builtin: () => new Date(),
          error: () => new Error('remote'),
          regexp: () => /remote/,
          nested: () => ({ props: { onClick: () => value } }),
          symbolCallback: () => ({ [Symbol.for('graph-returned-callback')]: () => value }),
          external: () => readFile,
          externalSymbol: () => symbolExternal,
        };
      `
          )(cache, readFile, runtime, symbolExternal)
        );
        return graph.wrapContainer(exports) as {
          read(): unknown;
          init(): Promise<typeof runtime>;
          frozen: { read(): unknown };
          wait(gate: Promise<void>): Promise<unknown>;
          builtin(): Date;
          error(): Error;
          regexp(): RegExp;
          nested(): { props: { onClick(): unknown } };
          external(): typeof readFile;
          externalSymbol(): typeof symbolExternal;
          symbolCallback(): Record<symbol, () => unknown>;
        };
      };
      const gc6 = async () => {
        for (let index = 0; index < 6; index++) {
          await setImmediate();
          global.gc!({ type: 'major', execution: 'sync' });
          await setImmediate();
        }
      };
      let held: (() => unknown) | undefined = (await create()).frozen.read;
      let nested: (() => unknown) | undefined = (await create()).nested().props.onClick;
      let heldSymbol: (() => unknown) | undefined = (await create()).symbolCallback()[symbol];
      let release!: () => void;
      let pending: Promise<unknown> | undefined = (await create()).wait(
        new Promise<void>((resolve) => {
          release = resolve;
        })
      );
      let current = await create();
      for (let index = 0; index < 100; index++) {
        expect(await current.init()).toBe(runtime);
        current.builtin();
        current.error();
        current.regexp();
        expect(current.external()).toBe(readFile);
        expect(current.externalSymbol()).toBe(symbolExternal);
        current = await create();
      }
      await gc6();
      expect(
        (globalThis as any)[Symbol.for('module-federation.vite.ssr-build-export-owners')].get(
          runtime.hook
        )
      ).toBeUndefined();
      expect(cache[listenersKey][descriptor.canonical].size).toBe(5);
      const updated = 'updated';
      helpers().write(cache, descriptor, updated);
      expect(held()).toBe(updated);
      expect(nested()).toBe(updated);
      expect(heldSymbol()).toBe(updated);
      expect(current.read()).toBe(updated);
      release();
      await expect(pending).resolves.toBe(updated);
      pending = undefined;
      release = () => {};
      held = undefined;
      nested = undefined;
      heldSymbol = undefined;
      await gc6();
      expect(cache[listenersKey][descriptor.canonical].size).toBe(1);
      expect(current.read()).toBe(updated);
    }
  );
});
