import { describe, expect, it } from 'vitest';
import {
  addUsedShares,
  generateLocalSharedImportMap,
  generatePendingSharesCode,
  getUsedShares,
} from '../virtualRemoteEntry';
import { normalizeModuleFederationOptions } from '../../utils/normalizeModuleFederationOptions';

describe('virtualRemoteEntry aliased shared dependencies', () => {
  it('publishes an aliased share under its runtime shareKey', () => {
    const options = normalizeModuleFederationOptions({
      name: 'alias-host',
      shared: {
        'my-alias': {
          import: 'react',
          request: 'react',
          shareKey: 'react',
          singleton: true,
        },
      },
    });

    const code = generateLocalSharedImportMap(options);

    expect(code).toMatch(/"react": \{\s*name: "react"/);
    expect(code).not.toMatch(/"my-alias": \{\s*name:/);
    expect(getUsedShares(options)).toEqual(new Set());
  });

  it('resolves a canonical alias when generating pending preload wrappers', () => {
    const options = normalizeModuleFederationOptions({
      name: 'alias-preload-host',
      shared: {
        'my-react': {
          import: 'react',
          request: 'react',
          shareKey: 'react',
        },
      },
    });
    addUsedShares('react', options);

    const code = generatePendingSharesCode('build', options);

    expect(code).toContain('const __mfPendingShareImports = [["react", () => import("');
    expect(code).toContain('loadShare__react');
  });

  it('derives a concrete runtime shareKey for a prefix request', () => {
    const options = normalizeModuleFederationOptions({
      name: 'prefix-host',
      shared: {
        'my-lodash/': {
          import: 'lodash',
          request: 'lodash/',
          shareKey: 'lodash/',
        },
      },
    });
    addUsedShares('lodash/debounce', options);

    const code = generateLocalSharedImportMap(options);

    expect(code).toContain('"lodash/debounce":');
  });

  it('uses a trailing-slash config key as the default request prefix', () => {
    const options = normalizeModuleFederationOptions({
      name: 'default-prefix-host',
      shared: {
        'my-lodash/': {
          import: 'lodash',
          shareKey: 'lodash/',
        },
      },
    });
    addUsedShares('my-lodash/debounce', options);

    const code = generateLocalSharedImportMap(options);

    expect(code).toContain('"lodash/debounce":');
  });

  it('does not materialize an alias prefix as a bare runtime share', () => {
    const options = normalizeModuleFederationOptions({
      name: 'aliased-prefix-host',
      shared: {
        'my-lodash': {
          import: 'lodash',
          request: 'lodash/',
          shareKey: 'lodash/',
        },
      },
    });
    addUsedShares('lodash/debounce', options);

    const code = generateLocalSharedImportMap(options);

    expect(code).toContain('"lodash/debounce":');
    expect(code).not.toMatch(/"lodash\/": \{/);
  });
});
