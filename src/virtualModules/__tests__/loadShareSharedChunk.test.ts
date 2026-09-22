import { describe, expect, it } from 'vitest';
import {
  findEagerFallbacksInSharedChunk,
  getSharedChunkName,
  isSharedCacheHelpersId,
} from '../loadShareSharedChunk';

const SHARED_CHUNK = 'assets/app__mf_owner__7__loadShare__shared-abc123.js';
const SHARED_NAME = 'app__mf_owner__7__loadShare__shared';

const chunk = (over: Partial<{ name: string; imports: string[]; modules: object }> = {}) => ({
  type: 'chunk',
  name: SHARED_NAME,
  imports: [],
  modules: {},
  ...over,
});

describe('getSharedChunkName', () => {
  it('keeps the owning instance in the name so two instances never share a chunk', () => {
    const a = getSharedChunkName('\0virtual:mf:app__mf_owner__1__loadShare__react__loadShare__.js');
    const b = getSharedChunkName('\0virtual:mf:app__mf_owner__2__loadShare__react__loadShare__.js');

    expect(a).toBe('\0virtual:mf:app__mf_owner__1__loadShare__shared');
    expect(b).not.toBe(a);
  });

  it('names the helper module into the same chunk as the wrappers it serves', () => {
    const wrapper = '\0virtual:mf:app__mf_owner__1__loadShare__react__loadShare__.js';
    const helpers = '\0virtual:mf:app__mf_owner__1__mf_v__loadShareHelpers__mf_v__.js';

    expect(isSharedCacheHelpersId(helpers)).toBe(true);
    expect(getSharedChunkName(helpers)).toBe(getSharedChunkName(wrapper));
  });
});

describe('findEagerFallbacksInSharedChunk', () => {
  it('ignores a shared chunk that reaches its fallbacks only through import()', () => {
    const bundle = {
      [SHARED_CHUNK]: chunk({
        imports: ['assets/vite-preload-helper-abc123.js'],
        modules: { '\0virtual:mf:app__loadShare__react__loadShare__.js': {} },
      }),
      'assets/x__prebuild__react__prebuild__-abc123.js': chunk({
        name: 'x__prebuild__react__prebuild__',
      }),
    };

    expect(findEagerFallbacksInSharedChunk(bundle).size).toBe(0);
  });

  it('reports a fallback inlined into it', () => {
    const fallback = '\0virtual:mf:app__prebuild__react__prebuild__.js';
    const bundle = { [SHARED_CHUNK]: chunk({ modules: { [fallback]: {} } }) };

    expect([...findEagerFallbacksInSharedChunk(bundle)]).toEqual([[SHARED_CHUNK, [fallback]]]);
  });

  it('ignores a fallback chunk it merely imports', () => {
    // Rolldown hoists runtime helpers into whichever chunk first uses them, so
    // this edge exists with the experiment off too.
    const bundle = {
      [SHARED_CHUNK]: chunk({ imports: ['assets/x__prebuild__react__prebuild__-abc123.js'] }),
    };

    expect(findEagerFallbacksInSharedChunk(bundle).size).toBe(0);
  });

  it.each([
    ['an eager wrapper chunk', 'loadShare-eager'],
    // A share called `shared-lib` puts `__loadShare__shared` in its file name.
    ['a wrapper for a share named "shared-lib"', 'app__loadShare__shared_mf_2_lib__loadShare__'],
  ])('leaves %s alone', (_label, name) => {
    const bundle = {
      [`assets/${name}-abc123.js`]: chunk({
        name,
        imports: ['assets/x__prebuild__react__prebuild__.js'],
      }),
    };

    expect(findEagerFallbacksInSharedChunk(bundle).size).toBe(0);
  });
});
