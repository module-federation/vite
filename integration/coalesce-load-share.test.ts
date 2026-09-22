import { resolve } from 'path';
import type { Rollup } from 'vite';
import { describe, expect, it, vi } from 'vitest';
import type { ModuleFederationOptions } from '../src/utils/normalizeModuleFederationOptions';
import { isRollupChunk } from './helpers/assertions';
import { buildFixture, FIXTURES } from './helpers/build';

// react-dom/client and react/jsx-runtime both require react, so two of these
// three fallbacks statically import another share's wrapper.
const SHARED = {
  react: { singleton: true, requiredVersion: '^19.2.4' },
  'react/jsx-runtime': { singleton: true, requiredVersion: '^19.2.4' },
  'react-dom/client': { singleton: true, requiredVersion: '^19.2.4' },
} satisfies ModuleFederationOptions['shared'];

const SHARE_COUNT = Object.keys(SHARED).length;

function buildRemote(shared: object = SHARED) {
  return buildFixture({
    fixture: 'react-skew-remote',
    mfOptions: {
      name: 'coalesceRemote',
      filename: 'remoteEntry.js',
      exposes: { './Module': resolve(FIXTURES, 'react-skew-remote', 'exposed-module.js') },
      shareStrategy: 'loaded-first',
      shared,
      dts: false,
    },
  });
}

// A host consumes the same shares without exposing anything, so its wrappers
// hold the local payload as a static import instead of a lazy fallback.
function buildHost() {
  return buildFixture({
    fixture: 'react-skew-host',
    mfOptions: {
      name: 'coalesceHost',
      remotes: {
        remote: { name: 'remote', entry: 'https://example.com/remoteEntry.js', type: 'module' },
      },
      hostInitInjectLocation: 'html',
      shareStrategy: 'loaded-first',
      shared: SHARED,
      dts: false,
    },
  });
}

const chunksOf = (output: Rollup.RollupOutput) => output.output.filter(isRollupChunk);
const wrapperChunks = (output: Rollup.RollupOutput) =>
  chunksOf(output).filter((chunk) => chunk.name.includes('loadShare'));

// The merged chunk is named for the owning instance plus this suffix.
const MERGED_SUFFIX = '__loadShare__shared';
const isMerged = (chunk: { name: string }) => chunk.name.endsWith(MERGED_SUFFIX);

// A string literal from the shared-cache helper block: unlike the helper
// identifiers, the bundler cannot rename it, so it counts copies reliably.
const HELPER_MARKER = 'module-federation.shared-cache-listeners';
const helperCopies = (output: Rollup.RollupOutput) =>
  wrapperChunks(output).reduce((n, chunk) => n + chunk.code.split(HELPER_MARKER).length - 1, 0);

describe('loadShare wrapper coalescing', () => {
  it('replaces the per-share wrapper chunks with one, helpers included once', async () => {
    const output = await buildRemote();

    expect(wrapperChunks(output)).toHaveLength(1);
    expect(wrapperChunks(output).every(isMerged)).toBe(true);
    expect(helperCopies(output)).toBe(1);
  });

  it('keeps eager wrappers in their own chunk', async () => {
    const output = await buildRemote({
      ...SHARED,
      'react-dom/client': { singleton: true, requiredVersion: '^19.2.4', eager: true },
    });
    const names = wrapperChunks(output).map((chunk) =>
      isMerged(chunk) ? MERGED_SUFFIX : chunk.name
    );

    expect(names.sort()).toEqual([MERGED_SUFFIX, 'loadShare-eager']);
  });

  it('leaves the local fallbacks in their own lazily imported chunks', async () => {
    const output = await buildRemote();
    const [merged] = wrapperChunks(output);

    expect(Object.keys(merged.modules).filter((id) => id.includes('__prebuild__'))).toEqual([]);
    expect(merged.imports.filter((file) => file.includes('__prebuild__'))).toEqual([]);
    expect(merged.dynamicImports.filter((file) => file.includes('__prebuild__'))).not.toEqual([]);
  });

  it('leaves a wrapper that statically imports its fallback out of the merged chunk', async () => {
    const output = await buildHost();

    expect(wrapperChunks(output)).not.toEqual([]);
    expect(wrapperChunks(output).filter(isMerged)).toEqual([]);
  });

  it('judges each wrapper by its owning instance, whichever instance chunks it', async () => {
    // Only the last instance's chunking callback survives in the output
    // options, so the remote's wrappers are named by the host-like instance,
    // whose own wrappers hold a static payload import and never merge.
    const output = await buildFixture({
      fixture: 'react-skew-remote',
      mfOptions: [
        {
          name: 'mixedRemote',
          filename: 'mixedRemote.js',
          exposes: { './Module': resolve(FIXTURES, 'react-skew-remote', 'exposed-module.js') },
          shareStrategy: 'loaded-first',
          shared: SHARED,
          dts: false,
        },
        {
          name: 'mixedHost',
          filename: 'mixedHost.js',
          remotes: {
            remote: { name: 'remote', entry: 'https://example.com/remoteEntry.js', type: 'module' },
          },
          hostInitInjectLocation: 'html',
          shareStrategy: 'loaded-first',
          shared: SHARED,
          dts: false,
        },
      ],
    });
    const merged = wrapperChunks(output).filter(isMerged);

    expect(merged.map((chunk) => chunk.name.includes('mixedRemote'))).toEqual([true]);
    expect(merged.some((chunk) => chunk.name.includes('mixedHost'))).toBe(false);
  });

  it('adds no static import cycle to the chunk graph', async () => {
    const output = await buildRemote();
    const byFileName = new Map(chunksOf(output).map((chunk) => [chunk.fileName, chunk]));
    const seen = new Set<string>();

    // Static edges only: a dynamic import cannot close a chunk cycle.
    const walk = (fileName: string, stack: string[]): void => {
      if (stack.includes(fileName)) {
        throw new Error(`static import cycle: ${[...stack, fileName].join(' -> ')}`);
      }
      if (seen.has(fileName)) return;
      seen.add(fileName);
      for (const imported of byFileName.get(fileName)?.imports ?? []) {
        walk(imported, [...stack, fileName]);
      }
    };

    for (const chunk of chunksOf(output)) walk(chunk.fileName, []);
  });

  it('gives each federation instance in one build its own merged chunk', async () => {
    const output = await buildFixture({
      fixture: 'react-skew-remote',
      mfOptions: ['instanceA', 'instanceB'].map((name) => ({
        name,
        filename: `${name}.js`,
        exposes: { './Module': resolve(FIXTURES, 'react-skew-remote', 'exposed-module.js') },
        shareStrategy: 'loaded-first' as const,
        shared: SHARED,
        dts: false,
      })),
    });

    // Sharing one chunk would make one instance's wrappers wait on the other's.
    expect(wrapperChunks(output).filter(isMerged)).toHaveLength(2);
  });

  it('keeps the wrappers away from user codeSplitting groups', async () => {
    const output = await buildFixture({
      fixture: 'react-skew-remote',
      mfOptions: {
        name: 'coalesceRemote',
        filename: 'remoteEntry.js',
        exposes: { './Module': resolve(FIXTURES, 'react-skew-remote', 'exposed-module.js') },
        shared: SHARED,
        dts: false,
      },
      viteConfig: {
        build: {
          rolldownOptions: {
            output: {
              codeSplitting: {
                groups: [{ name: 'vendor', test: /node_modules|__loadShare__/, priority: 100 }],
              },
            },
          },
          rollupOptions: {
            output: {
              manualChunks: (id: string) => (id.includes('node_modules') ? 'vendor' : undefined),
            },
          },
        },
      } as never,
    });

    expect(wrapperChunks(output).filter(isMerged)).toHaveLength(1);
  });

  // Options that change the wrapper's shape, the bootstrap, or the linked runtime.
  it.each([
    ['host init injected into the entry', { hostInitInjectLocation: 'entry' as const }],
    ['an external runtime', { experiments: { externalRuntime: true } }],
    ['a custom share scope', { shareScope: 'custom' }],
    ['every CSS asset bundled', { bundleAllCSS: true }],
    ['a var remote entry', { varFilename: 'varRemoteEntry.js' }],
    [
      'every share kind at once',
      {
        shared: {
          react: { singleton: true, requiredVersion: '^19.2.4' },
          'react/jsx-runtime': { singleton: true, requiredVersion: '^19.2.4', eager: true },
          'react-dom/client': {
            singleton: true,
            requiredVersion: '^19.2.4',
            treeShaking: { mode: 'runtime-infer' as const },
          },
          'host-only-dep': { singleton: true, import: false, suppressMissingImportWarning: true },
        },
      },
    ],
  ])('keeps the fallbacks lazy with %s', async (_label, overrides) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const output = await buildFixture({
        fixture: 'react-skew-remote',
        mfOptions: {
          name: 'coalesceRemote',
          filename: 'remoteEntry.js',
          exposes: { './Module': resolve(FIXTURES, 'react-skew-remote', 'exposed-module.js') },
          shareStrategy: 'loaded-first',
          shared: SHARED,
          dts: false,
          ...overrides,
        },
      });

      for (const merged of wrapperChunks(output).filter(isMerged)) {
        expect(Object.keys(merged.modules).filter((id) => id.includes('__prebuild__'))).toEqual([]);
      }
      expect(
        warn.mock.calls
          .map(([message]) => (typeof message === 'string' ? message : ''))
          .filter((message) => message.includes('merged into the loadShare chunk'))
      ).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it('never warns that a fallback reached the merged chunk', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await Promise.all([buildRemote(), buildHost()]);
      const messages = warn.mock.calls
        .map(([message]) => (typeof message === 'string' ? message : ''))
        .filter((message) => message.includes('merged into the loadShare chunk'));

      // The eligibility rule should make the guard unreachable.
      expect(messages).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });
});
