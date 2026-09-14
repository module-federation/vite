import { describe, expect, it } from 'vitest';
import {
  applyUserResolveDependencies,
  markFederationResolveDependencies,
  rememberUserResolveDependencies,
  unwrapUserResolveDependencies,
} from '../modulePreloadPolicy';

describe('modulePreloadPolicy', () => {
  const dropWrappers = (_file: string, deps: string[]) =>
    deps.filter((dep) => !dep.includes('__loadRemote__'));

  it('returns the list untouched when the user configured nothing', () => {
    rememberUserResolveDependencies(undefined);
    expect(applyUserResolveDependencies('index.html', ['a.js', 'b.js'], 'html')).toEqual([
      'a.js',
      'b.js',
    ]);
  });

  it('runs a list through the user function with the host it belongs to', () => {
    const calls: unknown[] = [];
    rememberUserResolveDependencies((file, deps, context) => {
      calls.push([file, context]);
      return dropWrappers(file, deps);
    });
    expect(
      applyUserResolveDependencies(
        'remoteEntry.js',
        ['assets/virtualExposes.js', 'assets/virtual_mf___app__loadRemote__x__loadRemote__.js'],
        'js'
      )
    ).toEqual(['assets/virtualExposes.js']);
    expect(calls).toEqual([['remoteEntry.js', { hostId: 'remoteEntry.js', hostType: 'js' }]]);
    rememberUserResolveDependencies(undefined);
  });

  it('sees the user function through the plugin wrapper of an earlier federation config', () => {
    const wrapper = markFederationResolveDependencies((_f, deps) => deps, dropWrappers);
    expect(unwrapUserResolveDependencies(wrapper)).toBe(dropWrappers);
    expect(
      unwrapUserResolveDependencies(
        markFederationResolveDependencies((_f, deps) => deps, undefined)
      )
    ).toBeUndefined();
    expect(unwrapUserResolveDependencies(dropWrappers)).toBe(dropWrappers);
  });
});
