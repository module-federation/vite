import { describe, expect, it } from 'vitest';
import { setImmediate } from 'node:timers/promises';
import { readFile } from 'node:fs';
import { createSsrBuildGraph, SSR_BUILD_CONTEXT_KEY } from '../ssrBuildGraph';
import { sharedCacheHelperCode } from '../packageUtils';
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
        return current();
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
    expect(await read()).toBe(graph);
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

  it('preserves exact shared singleton objects and live export getters', async () => {
    const graph = await createSsrBuildGraph();
    const shared = { createElement() {} };
    const holder = globalThis as any;
    const previous = holder.__mf_module_cache__;
    holder.__mf_module_cache__ = { share: { 'default:react': shared } };
    try {
      let marker = 'v1';
      const exports = graph.wrapContainer({
        shared,
        get marker() {
          return marker;
        },
      });
      expect(exports.shared).toBe(shared);
      expect(exports.shared.createElement).toBe(shared.createElement);
      marker = 'v2';
      expect(exports.marker).toBe('v2');
    } finally {
      holder.__mf_module_cache__ = previous;
    }
  });

  it.skipIf(!global.gc)(
    'collects retired subscriptions after 100 replacements while held and in-flight exports remain live',
    async () => {
      const cache: any = {};
      const create = async () => {
        const graph = await createSsrBuildGraph();
        graph.registerExternal({ readFile });
        const exports = graph.run(() =>
          Function(
            'cache',
            'readFile',
            `${sharedCacheHelperCode}
        let value;
        __mfSubscribeSharedCache(cache, { canonical: 'default:test', aliases: [] }, next => value = next);
        return {
          read: () => value,
          frozen: Object.freeze({ read: (() => value).bind(null) }),
          wait: async gate => { await gate; return value; },
          builtin: () => new Date(),
          error: () => new Error('remote'),
          regexp: () => /remote/,
          nested: () => ({ props: { onClick: () => value } }),
          external: () => readFile,
        };
      `
          )(cache, readFile)
        );
        return graph.wrapContainer(exports) as {
          read(): unknown;
          frozen: { read(): unknown };
          wait(gate: Promise<void>): Promise<unknown>;
          builtin(): Date;
          error(): Error;
          regexp(): RegExp;
          nested(): { props: { onClick(): unknown } };
          external(): typeof readFile;
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
      let release!: () => void;
      let pending: Promise<unknown> | undefined = (await create()).wait(
        new Promise<void>((resolve) => {
          release = resolve;
        })
      );
      let current = await create();
      for (let index = 0; index < 100; index++) {
        current.builtin();
        current.error();
        current.regexp();
        expect(current.external()).toBe(readFile);
        current = await create();
      }
      await gc6();
      expect(cache[listenersKey][descriptor.canonical].size).toBe(4);
      const updated = 'updated';
      helpers().write(cache, descriptor, updated);
      expect(held()).toBe(updated);
      expect(nested()).toBe(updated);
      expect(current.read()).toBe(updated);
      release();
      await expect(pending).resolves.toBe(updated);
      pending = undefined;
      release = () => {};
      held = undefined;
      nested = undefined;
      await gc6();
      expect(cache[listenersKey][descriptor.canonical].size).toBe(1);
      expect(current.read()).toBe(updated);
    }
  );
});
