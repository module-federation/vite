import type { Plugin } from 'vite';
import { describe, expect, it } from 'vitest';
import { federation, type ModuleFederationPluginApi } from '../index';
import type { NormalizedModuleFederationOptions } from '../utils/normalizeModuleFederationOptions';
import { getHostAutoInitPath } from '../virtualModules/virtualRemoteEntry';
import { getUsedRemotesMap } from '../virtualModules/virtualRemotes';

function owner(name: string, entry = 'http://localhost:4174/remoteEntry.js') {
  return federation({
    name,
    remotes: { products: { type: 'module', name: 'products', entry } },
    dts: false,
  }).find((plugin) => plugin.name === 'module-federation-vite') as Plugin & {
    api: ModuleFederationPluginApi;
    _options: NormalizedModuleFederationOptions;
  };
}

describe('host bootstrap plugin API', () => {
  it('returns the original stable import ID without recording remote module usage', () => {
    const plugin = owner('bootstrap-api-host');
    const getId = plugin.api.moduleFederation.getHostInitImportId;
    const id = getId();

    expect(id).toBe(getHostAutoInitPath(plugin._options));
    expect(id).toMatch(/^virtual:mf:/);
    expect(getId()).toBe(id);
    expect(getUsedRemotesMap(plugin._options)).toEqual({});
  });

  it('keeps same-name plugin instances independent even with identical remote aliases', () => {
    const first = owner('same-bootstrap-host');
    const second = owner('same-bootstrap-host', 'http://localhost:4175/remoteEntry.js');
    const firstId = first.api.moduleFederation.getHostInitImportId();
    const secondId = second.api.moduleFederation.getHostInitImportId();

    expect(firstId).not.toBe(secondId);
    expect(first.api.moduleFederation.getHostInitImportId()).toBe(firstId);
    expect(secondId).toBe(getHostAutoInitPath(second._options));
    expect(getUsedRemotesMap(first._options)).toEqual({});
    expect(getUsedRemotesMap(second._options)).toEqual({});
  });

  it('does not advertise a runtime bootstrap for hostProvidesAllShared', () => {
    const plugins = federation({
      name: 'import-map-host',
      experiments: { hostProvidesAllShared: true },
      dts: false,
    });

    expect(plugins.some((plugin) => plugin.api?.moduleFederation)).toBe(false);
  });
});
