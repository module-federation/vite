import { describe, expect, it } from 'vitest';
import VirtualModule, { MF_OWNER_INFIX } from '../../utils/VirtualModule';
import { findSharedKey } from '../../plugins/pluginProxySharedModule_preBuild';
import { packageNameEncode } from '../../utils/packageUtils';
import {
  normalizeModuleFederationOptions,
  type NormalizedShared,
  type ShareItem,
} from '../../utils/normalizeModuleFederationOptions';
import {
  findCurrentLoadShareForStaleOwnerId,
  getLoadShareModulePath,
  getPreBuildLibImportId,
  getTreeShakingSharedProviderImportId,
  writeLoadShareModule,
  writePreBuildLibPath,
} from '../virtualShared_preBuild';
import { generateRemoteEntry } from '../virtualRemoteEntry';
import { generateRemotes } from '../virtualRemotes';
import { initVirtualModules } from '../index';
import {
  getRuntimeInitStatusImportId,
  getRuntimeRemoteAlias,
  writeRuntimeInitStatus,
} from '../virtualRuntimeInitStatus';
import { recordTreeShakingExports, setTreeShakingBuildMode } from '../../utils/treeShaking';
import { getFederationScopeKey } from '../virtualModuleScope';

function makeOptions(name = 'same-name-host', filename?: string) {
  return normalizeModuleFederationOptions({
    name,
    filename,
    shared: {},
  });
}

function makeShareItem(importValue: false | string): ShareItem {
  return {
    name: 'react',
    from: 'same-name-host',
    version: '19.1.0',
    scope: 'default',
    shareConfig: {
      import: importValue,
      singleton: true,
      requiredVersion: '^19.0.0',
    },
  };
}

describe('shared virtual module instance isolation', () => {
  it('keeps same-package generated modules owned by same-name federation instances', () => {
    const optionsA = makeOptions();
    const optionsB = makeOptions('same-name-host', 'secondaryRemoteEntry.js');
    const shareA = makeShareItem(false);
    const shareB = makeShareItem('react');

    writeLoadShareModule('react', shareA, 'build', false, optionsA);
    writePreBuildLibPath('react', shareA, optionsA);
    const loadShareA = getLoadShareModulePath('react', false, optionsA);
    const preBuildA = getPreBuildLibImportId('react', optionsA);
    const loadShareCodeA = VirtualModule.findById(loadShareA)?.code;

    writeLoadShareModule('react', shareB, 'build', false, optionsB);
    writePreBuildLibPath('react', shareB, optionsB);
    const loadShareB = getLoadShareModulePath('react', false, optionsB);
    const preBuildB = getPreBuildLibImportId('react', optionsB);

    expect(loadShareA).not.toBe(loadShareB);
    expect(preBuildA).not.toBe(preBuildB);
    expect(VirtualModule.findById(loadShareA)?.code).toBe(loadShareCodeA);
    expect(loadShareCodeA).toContain('was imported before federation bootstrap finished');
    expect(VirtualModule.findById(loadShareB)?.code).toContain('import * as __mfLocalShare');
  });

  it('uses a distinct build init barrier for each federation instance', () => {
    const optionsA = makeOptions();
    const optionsB = makeOptions('same-name-host', 'secondaryRemoteEntry.js');
    const share = makeShareItem(false);

    writeLoadShareModule('react', share, 'build', false, optionsA);
    writeLoadShareModule('react', share, 'build', false, optionsB);

    const runtimeInitA = getRuntimeInitStatusImportId(optionsA);
    const runtimeInitB = getRuntimeInitStatusImportId(optionsB);
    const codeA = VirtualModule.findById(getLoadShareModulePath('react', false, optionsA))?.code;
    const codeB = VirtualModule.findById(getLoadShareModulePath('react', false, optionsB))?.code;

    expect(runtimeInitA).not.toBe(runtimeInitB);
    expect(codeA).toContain(`__mf_init__${runtimeInitA}__`);
    expect(codeA).not.toContain(`__mf_init__${runtimeInitB}__`);
    expect(codeB).toContain(`__mf_init__${runtimeInitB}__`);
    expect(codeB).not.toContain(`__mf_init__${runtimeInitA}__`);
  });

  it('keeps runtime init ids stable for equivalent configs', () => {
    const optionsA = makeOptions('stable-host');
    const share = makeShareItem(false);
    writeLoadShareModule('react', share, 'serve', false, optionsA);
    getRuntimeInitStatusImportId(makeOptions('unrelated-host'));
    const optionsB = makeOptions('stable-host');
    writeLoadShareModule('react', share, 'serve', false, optionsB);

    expect(getRuntimeInitStatusImportId(optionsA)).toBe(getRuntimeInitStatusImportId(optionsB));
    expect(getLoadShareModulePath('react', false, optionsA)).toBe(
      getLoadShareModulePath('react', false, optionsB)
    );
  });

  it('normalizes non-JSON config values deterministically', () => {
    const makeTypedOptions = (reverse: boolean) => ({
      internalName: 'typed-host',
      runtime: {
        date: new Date('2026-01-02T03:04:05.000Z'),
        pattern: /remote-entry/gi,
        map: new Map(
          reverse
            ? [
                ['b', 2],
                ['a', 1],
              ]
            : [
                ['a', 1],
                ['b', 2],
              ]
        ),
        set: new Set(reverse ? ['b', 'a'] : ['a', 'b']),
      },
    });

    expect(getFederationScopeKey(makeTypedOptions(false))).toBe(
      getFederationScopeKey(makeTypedOptions(true))
    );
    expect(getFederationScopeKey(makeTypedOptions(false))).not.toBe(
      getFederationScopeKey({
        ...makeTypedOptions(false),
        runtime: { ...makeTypedOptions(false).runtime, pattern: /remote-entry/g },
      })
    );
  });

  it('uses the same scoped init barrier in serve loadShare and remoteEntry modules', () => {
    const options = makeOptions();
    const share = makeShareItem(false);
    writeLoadShareModule('react', share, 'serve', false, options);

    const runtimeInit = getRuntimeInitStatusImportId(options);
    const loadShareCode = VirtualModule.findById(
      getLoadShareModulePath('react', false, options)
    )?.code;
    const remoteEntryCode = generateRemoteEntry(options, 'virtual:exposes', 'serve');

    expect(loadShareCode).toContain(`__mf_init__${runtimeInit}__`);
    expect(remoteEntryCode).toContain(`__mf_init__${runtimeInit}__`);
  });

  it('keeps scoped SSR remotes separate from the host-init import identity', () => {
    const optionsA = makeOptions();
    const optionsB = makeOptions('same-name-host', 'secondaryRemoteEntry.js');
    const remotesA = [{ name: 'remote-a', entry: 'https://a.invalid/ssr.js', type: 'module' }];
    const remotesB = [{ name: 'remote-b', entry: 'https://b.invalid/ssr.js', type: 'module' }];

    writeRuntimeInitStatus('serve', true, 'virtual:host-init-a', optionsA, remotesA);
    writeRuntimeInitStatus('serve', true, 'virtual:host-init-b', optionsB, remotesB);
    const runtimeInitA = getRuntimeInitStatusImportId(optionsA);
    const runtimeInitB = getRuntimeInitStatusImportId(optionsB);
    const codeA = VirtualModule.findById(runtimeInitA)?.code;
    const codeB = VirtualModule.findById(runtimeInitB)?.code;

    expect(codeA).toContain('import("virtual:host-init-a")');
    expect(codeA).not.toContain(`import(${JSON.stringify(runtimeInitA)})`);
    expect(codeA).toContain('https://a.invalid/ssr.js');
    expect(codeA).not.toContain('https://b.invalid/ssr.js');
    expect(codeB).toContain('import("virtual:host-init-b")');
    expect(codeB).not.toContain(`import(${JSON.stringify(runtimeInitB)})`);
    expect(codeB).toContain('https://b.invalid/ssr.js');
    expect(codeB).not.toContain('https://a.invalid/ssr.js');
  });

  it('registers SSR remotes under the same scoped names generateRemotes loadRemote uses', () => {
    const options = normalizeModuleFederationOptions({
      name: 'ssr-host',
      remotes: {
        remote: {
          type: 'module',
          name: 'remote',
          entry: 'http://localhost:4174/remoteEntry.js',
          entryGlobalName: 'remote',
          shareScope: 'default',
        },
      },
    });

    initVirtualModules('serve', undefined, true, options);
    const initCode = VirtualModule.findById(getRuntimeInitStatusImportId(options))?.code ?? '';
    const remoteCode = generateRemotes('remote/App', 'serve', true, 'server', options);
    const aliased = getRuntimeRemoteAlias('remote', options);

    expect(remoteCode).toContain(`runtime.loadRemote(${JSON.stringify(`${aliased}/App`)})`);
    expect(remoteCode).toContain(`"name":${JSON.stringify(aliased)}`);
    expect(initCode).toContain(`"name":${JSON.stringify(aliased)}`);
    expect(initCode).not.toMatch(/"name":"remote"/);
    expect(remoteCode).not.toMatch(/"name":"remote"/);
  });

  it('does not combine tree-shaking providers across federation instances', () => {
    const optionsA = makeOptions();
    const optionsB = makeOptions('same-name-host', 'secondaryRemoteEntry.js');
    const shareA = makeShareItem('react');
    const shareB = makeShareItem('react');
    shareA.shareConfig.treeShaking = { mode: 'server-calc' };
    shareB.shareConfig.treeShaking = { mode: 'server-calc' };

    setTreeShakingBuildMode(true, optionsA);
    setTreeShakingBuildMode(true, optionsB);
    recordTreeShakingExports('react', ['createElement'], 'react', optionsA);
    recordTreeShakingExports('react', ['useState'], 'react', optionsB);
    writePreBuildLibPath('react', shareA, optionsA);
    writePreBuildLibPath('react', shareB, optionsB);

    const providerA = VirtualModule.findById(
      getTreeShakingSharedProviderImportId('react', optionsA)
    )?.code;
    const providerB = VirtualModule.findById(
      getTreeShakingSharedProviderImportId('react', optionsB)
    )?.code;

    expect(providerA).toContain('createElement as __mfTreeShaken_0');
    expect(providerA).not.toContain('useState as __mfTreeShaken_0');
    expect(providerB).toContain('useState as __mfTreeShaken_0');
    expect(providerB).not.toContain('createElement as __mfTreeShaken_0');
  });
});

function makePkgShareItem(pkg: string): ShareItem {
  return {
    name: pkg,
    from: 'stale-owner-host',
    version: '19.1.0',
    scope: 'default',
    shareConfig: {
      import: pkg,
      singleton: true,
      requiredVersion: '^19.0.0',
    },
  };
}

function makeShared(pkg: string): NormalizedShared {
  return { [pkg]: makePkgShareItem(pkg) } as NormalizedShared;
}

function toLegacyOwnerId(id: string, options: ReturnType<typeof makeOptions>) {
  return id.replace(
    `virtual:mf:${packageNameEncode(getFederationScopeKey(options))}`,
    `virtual:mf:${packageNameEncode(`${options.internalName}${MF_OWNER_INFIX}99`)}`
  );
}

// Numeric owner keys from older caches must resolve to the deterministic owner
// for the same instance, while other instances' ids stay isolated.
describe('stale owner loadShare resolution', () => {
  it('redirects loadShare ids minted by a previous generation of the same instance', () => {
    const currentGen = makeOptions('stale-owner-host');
    const shared = makeShared('react');

    writeLoadShareModule('react', shared['react'], 'serve', false, currentGen);
    const currentId = getLoadShareModulePath('react', false, currentGen);
    const staleId = toLegacyOwnerId(currentId, currentGen);
    expect(staleId).not.toBe(currentId);

    const healed = findCurrentLoadShareForStaleOwnerId(staleId, shared, findSharedKey, currentGen);
    expect(healed?.getImportId()).toBe(currentId);
  });

  it('redirects stale ids for encoded package subpaths', () => {
    const currentGen = makeOptions('stale-owner-host');
    const shared = makeShared('react-dom/client');

    writeLoadShareModule(
      'react-dom/client',
      shared['react-dom/client'],
      'serve',
      false,
      currentGen
    );
    const staleId = toLegacyOwnerId(
      getLoadShareModulePath('react-dom/client', false, currentGen),
      currentGen
    );

    const healed = findCurrentLoadShareForStaleOwnerId(staleId, shared, findSharedKey, currentGen);
    expect(healed?.getImportId()).toBe(
      getLoadShareModulePath('react-dom/client', false, currentGen)
    );
  });

  it('does not reclaim ids minted by a different federation instance', () => {
    const otherInstance = makeOptions('other-host');
    const currentGen = makeOptions('stale-owner-host');
    const shared = makeShared('react');

    writeLoadShareModule('react', shared['react'], 'serve', false, otherInstance);
    writeLoadShareModule('react', shared['react'], 'serve', false, currentGen);
    const foreignId = getLoadShareModulePath('react', false, otherInstance);

    expect(findCurrentLoadShareForStaleOwnerId(foreignId, shared, findSharedKey, currentGen)).toBe(
      undefined
    );
  });

  it('does not reclaim ids of instances whose name is a prefix of another', () => {
    // "host" is a prefix of "hostSecondary": slicing at __mf_owner__ must
    // compare the full instance name, not a startsWith match.
    const secondary = makeOptions('hostSecondary');
    const primary = makeOptions('host');
    const shared = makeShared('react');

    writeLoadShareModule('react', shared['react'], 'serve', false, secondary);
    writeLoadShareModule('react', shared['react'], 'serve', false, primary);
    const secondaryId = getLoadShareModulePath('react', false, secondary);

    expect(findCurrentLoadShareForStaleOwnerId(secondaryId, shared, findSharedKey, primary)).toBe(
      undefined
    );
  });

  it('does not resolve packages that are no longer shared', () => {
    const previousGen = makeOptions('stale-owner-host');
    const currentGen = makeOptions('stale-owner-host');

    writeLoadShareModule('react', makePkgShareItem('react'), 'serve', false, previousGen);
    const staleId = getLoadShareModulePath('react', false, previousGen);

    expect(
      findCurrentLoadShareForStaleOwnerId(staleId, makeShared('vue'), findSharedKey, currentGen)
    ).toBe(undefined);
  });

  it('ignores ids that are not loadShare virtual modules', () => {
    const currentGen = makeOptions('stale-owner-host');
    expect(
      findCurrentLoadShareForStaleOwnerId('react', makeShared('react'), findSharedKey, currentGen)
    ).toBe(undefined);
  });
});
