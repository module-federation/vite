import { describe, expect, it } from 'vitest';
import { federation } from '../index';

describe('module-federation-dev-await-shared-init', () => {
  it('patches optimized deps even when the chunk contains __esmMin helpers', () => {
    const plugin = federation({ name: 'host-app', shared: {} }).find(
      (entry) => entry.name === 'module-federation-dev-await-shared-init'
    );

    const code = [
      'import "/dep-a.js";',
      'import "/dep-b.js";',
      'const wrapped = (init_react__loadShare__abc(), __esmMin);',
    ].join('\n');

    const transformed = plugin!.transform!(
      code,
      '/project/node_modules/.vite/deps/react-dom_client.js'
    );

    expect(transformed).toContain('await init_react__loadShare__abc();');
  });

  it('does not patch the loadShare virtual module itself', () => {
    const plugin = federation({ name: 'host-app', shared: {} }).find(
      (entry) => entry.name === 'module-federation-dev-await-shared-init'
    );

    const code = [
      'import "/dep.js";',
      'const wrapped = (init_react__loadShare__abc(), __esmMin);',
    ].join('\n');

    const transformed = plugin!.transform!(
      code,
      '/project/node_modules/.vite/deps/react__loadShare__virtual.js'
    );

    expect(transformed).toBeUndefined();
  });
});
