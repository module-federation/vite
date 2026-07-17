import { describe, expect, it } from 'vitest';
import VirtualModule from '../../utils/VirtualModule';
import {
  normalizeModuleFederationOptions,
  type ShareItem,
} from '../../utils/normalizeModuleFederationOptions';
import {
  getLoadShareModulePath,
  getPreBuildLibImportId,
  getTreeShakingSharedProviderImportId,
  writeLoadShareModule,
  writePreBuildLibPath,
} from '../virtualShared_preBuild';
import { generateRemoteEntry } from '../virtualRemoteEntry';
import { getRuntimeInitStatusImportId, writeRuntimeInitStatus } from '../virtualRuntimeInitStatus';
import { recordTreeShakingExports, setTreeShakingBuildMode } from '../../utils/treeShaking';

function makeOptions() {
  return normalizeModuleFederationOptions({
    name: 'same-name-host',
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
    const optionsB = makeOptions();
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
    const optionsB = makeOptions();
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
    const optionsB = makeOptions();
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

  it('does not combine tree-shaking providers across federation instances', () => {
    const optionsA = makeOptions();
    const optionsB = makeOptions();
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
