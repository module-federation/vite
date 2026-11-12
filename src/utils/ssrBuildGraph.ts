/** Shared with generated code; do not replace this carrier between loader copies. */
export const SSR_BUILD_CONTEXT_KEY = Symbol.for('module-federation.vite.ssr-build-context');

interface BuildContext {
  getStore(): SsrBuildGraph | undefined;
  run<T>(graph: SsrBuildGraph, callback: () => T): T;
  exit<T>(callback: () => T): T;
}

/** Process-owned import/cache promises must not inherit a remote's ALS store. */
export function withoutSsrBuildGraph<T>(callback: () => T): T {
  const context = (globalThis as any)[SSR_BUILD_CONTEXT_KEY] as BuildContext | undefined;
  return context ? context.exit(callback) : callback();
}

type Listener = (value: unknown) => void;
type Subscription = { listeners: Set<Listener>; dispatch: Listener };
const listenersKey = Symbol.for('module-federation.shared-cache-listeners');
const contextPromiseKey = Symbol.for('module-federation.vite.ssr-build-context-promise');
const ownershipKey = Symbol.for('module-federation.vite.ssr-build-export-owners');
const externalKey = Symbol.for('module-federation.vite.ssr-build-externals');
const ownerHolder = globalThis as typeof globalThis & {
  [ownershipKey]?: WeakMap<object, Set<SsrBuildGraph>>;
  [externalKey]?: WeakSet<object>;
};
const exportOwners = (ownerHolder[ownershipKey] ??= new WeakMap());
const externals = (ownerHolder[externalKey] ??= new WeakSet());
const finalizers = new FinalizationRegistry<Set<Subscription>>((subscriptions) => {
  for (const { listeners, dispatch } of subscriptions) listeners.delete(dispatch);
});

// Keep this scope separate from subscribe(): a process-global dispatcher must
// never capture the original listener, its module context, or its graph.
function weakDispatcher(graph: WeakRef<SsrBuildGraph>, id: number): Listener {
  return (value) => graph.deref()?.notify(id, value);
}

function isNativeFunction(value: unknown): boolean {
  return (
    typeof value === 'function' &&
    /\{\s*\[native code\]\s*\}$/.test(Function.prototype.toString.call(value)) &&
    !value.name.startsWith('bound ')
  );
}

function isShared(value: object): boolean {
  if (externals.has(value)) return true;
  for (const key of ['__mf_module_cache__', '__mf_module_cache_react_server__']) {
    const cache = (globalThis as Record<string, any>)[key]?.share;
    if (!cache) continue;
    for (const shared of Object.values(cache) as any[]) {
      for (const source of [shared, shared?.default]) {
        if (value === source) return true;
        if (!source || (typeof source !== 'object' && typeof source !== 'function')) continue;
        for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(source))) {
          if ('value' in descriptor && descriptor.value === value) return true;
        }
      }
    }
  }
  return false;
}

/** Host modules retain their identity and must never become remote owners. */
export function registerSsrBuildExternal<T>(value: T): T {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return value;
  const target = value as object;
  if (externals.has(target)) return value;
  externals.add(target);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(target))) {
    if ('value' in descriptor) registerSsrBuildExternal(descriptor.value);
  }
  return value;
}

/**
 * Owns generated state for one loaded remote generation. Loader caches own the
 * current graph; exported factories/functions/objects own it while in use.
 * Retiring a cache entry therefore never unsubscribes a still-live export.
 */
export class SsrBuildGraph {
  readonly initStates = new Map<string, any>();
  private readonly listeners = new Map<number, Listener>();
  private readonly subscriptions = new Set<Subscription>();
  private readonly wrappers = new WeakMap<object, object>();
  private readonly originals = new WeakMap<object, object>();
  private readonly owned = new WeakSet<object>();
  private nextListener = 0;

  constructor(private readonly context: BuildContext) {
    finalizers.register(this, this.subscriptions);
  }

  run<T>(callback: () => T): T {
    return this.context.run(this, callback);
  }

  registerExternal<T>(value: T): T {
    return registerSsrBuildExternal(value);
  }

  subscribe(cache: Record<PropertyKey, any>, canonical: string, listener: Listener): () => void {
    let table = cache[listenersKey];
    if (!table) {
      table = Object.create(null);
      Object.defineProperty(cache, listenersKey, { value: table });
    }
    const listeners: Set<Listener> = (table[canonical] ||= new Set());
    const id = this.nextListener++;
    const dispatch = weakDispatcher(new WeakRef(this), id);
    const subscription = { listeners, dispatch };
    this.listeners.set(id, listener);
    this.subscriptions.add(subscription);
    listeners.add(dispatch);
    return () => {
      listeners.delete(dispatch);
      this.listeners.delete(id);
      this.subscriptions.delete(subscription);
    };
  }

  notify(id: number, value: unknown): void {
    this.run(() => this.listeners.get(id)?.(value));
  }

  /** Container calls, factories and extracted exports all keep this graph alive. */
  wrapContainer<T>(container: T): T {
    return this.retain(container, 'container');
  }

  private own<T>(value: T): T {
    if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return value;
    const target = value as object;
    if (this.owned.has(target) || isShared(target)) return value;
    this.owned.add(target);
    if (typeof value === 'function') {
      // Native functions/prototypes have process lifetime and must never own
      // a remote graph merely because an exposed function returned a Date etc.
      if (isNativeFunction(value)) return value;
      let owners = exportOwners.get(target);
      if (!owners) exportOwners.set(target, (owners = new Set()));
      owners.add(this);
    }
    // Frozen export properties cannot be replaced by a proxy. Weak-key ownership
    // also keeps extracted original methods alive without mutating the export.
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(target))) {
      if ('value' in descriptor) this.own(descriptor.value);
      else {
        this.own(descriptor.get);
        this.own(descriptor.set);
      }
    }
    return value;
  }

  private retain<T>(
    value: T,
    mode: 'container' | 'init' | 'get' | 'factory' | 'export' = 'export',
    wrapNative = false
  ): T {
    if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return value;
    const target = value as object;
    if (isShared(target) || (!wrapNative && isNativeFunction(value))) return value;
    const existing = this.wrappers.get(target);
    if (existing) return existing as T;
    const graph = this;
    const proxy: object = new Proxy(target, {
      get(target, property, receiver) {
        const result = Reflect.get(target, property, graph.originals.get(receiver) ?? receiver);
        // Proxy invariants require frozen properties to retain their identity.
        const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
        if (
          descriptor &&
          !descriptor.configurable &&
          'value' in descriptor &&
          !descriptor.writable
        ) {
          return graph.own(result);
        }
        if (property === 'prototype') return result;
        const prototype = Object.getPrototypeOf(target);
        const nativeReceiver =
          typeof target !== 'function' &&
          prototype &&
          prototype !== Object.prototype &&
          isNativeFunction(prototype.constructor);
        return graph.retain(
          result,
          mode === 'container' && property === 'get'
            ? 'get'
            : mode === 'container' && property === 'init'
              ? 'init'
              : 'export',
          nativeReceiver
        );
      },
      set(target, property, value, receiver) {
        return graph.run(() =>
          Reflect.set(
            target,
            property,
            graph.originals.get(value) ?? value,
            graph.originals.get(receiver) ?? receiver
          )
        );
      },
      apply(target, receiver, args) {
        return graph.run(() => {
          const originalReceiver = graph.originals.get(receiver) ?? receiver;
          const originalArgs = args.map((argument) => graph.originals.get(argument) ?? argument);
          const result = Reflect.apply(target as Function, originalReceiver, originalArgs);
          // A pending invocation must keep the graph alive even if its caller
          // releases the function before the invocation settles.
          const retainResult = (resolved: unknown) => {
            // Federation init returns a process-owned runtime instance, not a
            // remote export. Its global hooks must never own this graph.
            if (mode === 'init') return resolved;
            if (resolved === originalReceiver) return receiver;
            const index = originalArgs.indexOf(resolved);
            if (index !== -1) return args[index];
            if (resolved && (typeof resolved === 'object' || typeof resolved === 'function')) {
              const wrapper = graph.wrappers.get(resolved);
              if (wrapper) return wrapper;
            }
            return mode === 'get'
              ? graph.retain(resolved, 'factory')
              : mode === 'factory'
                ? graph.retain(resolved)
                : graph.own(resolved);
          };
          if (result && typeof result.then === 'function') {
            return Promise.resolve(result).then(retainResult);
          }
          return retainResult(result);
        });
      },
      construct(target, args, newTarget): object {
        graph.own(target);
        return graph.run(() =>
          graph.own(
            Reflect.construct(
              target as Function,
              args.map((argument) => graph.originals.get(argument) ?? argument),
              newTarget === proxy ? (target as Function) : newTarget
            )
          )
        );
      },
    });
    this.wrappers.set(target, proxy);
    this.originals.set(proxy, target);
    return proxy as T;
  }
}

/** No static Node imports: the SSR loader remains safe to import in browsers. */
export async function createSsrBuildGraph(): Promise<SsrBuildGraph> {
  const holder = globalThis as typeof globalThis & {
    [SSR_BUILD_CONTEXT_KEY]?: BuildContext;
    [contextPromiseKey]?: Promise<BuildContext>;
  };
  if (!holder[SSR_BUILD_CONTEXT_KEY]) {
    holder[contextPromiseKey] ??= (async () => {
      const id = 'node:async_hooks';
      const { AsyncLocalStorage } = (await import(
        /* @vite-ignore */ id
      )) as typeof import('node:async_hooks');
      return (holder[SSR_BUILD_CONTEXT_KEY] ??= new AsyncLocalStorage<SsrBuildGraph>());
    })();
    await holder[contextPromiseKey];
  }
  return new SsrBuildGraph(holder[SSR_BUILD_CONTEXT_KEY]!);
}
