import { describe, expect, it } from 'vitest';
import { getSharedRequest, getSharedRuntimeKey } from '../sharedKeyMatcher';

describe('shared key helpers', () => {
  it('keeps request matching separate from the runtime share key', () => {
    const shareItem = {
      name: 'my-react',
      shareConfig: { request: 'react', shareKey: 'react' },
    };

    expect(getSharedRequest('my-react', shareItem)).toBe('react');
    expect(getSharedRuntimeKey('react', shareItem)).toBe('react');
    expect(getSharedRuntimeKey('my-react', shareItem)).toBe('react');
  });

  it('maps concrete prefix requests to concrete runtime keys', () => {
    const shareItem = {
      name: 'my-lodash/',
      shareConfig: { request: 'lodash/', shareKey: 'shared/' },
    };

    expect(getSharedRuntimeKey('lodash/debounce', shareItem)).toBe('shared/debounce');
  });

  it('maps the bare base of a prefix request to a concrete runtime key', () => {
    const aliased = { name: 'my-lodash', shareConfig: { request: 'lodash/', shareKey: 'shared/' } };
    expect(getSharedRuntimeKey('lodash', aliased)).toBe('shared');

    const plain = { name: 'react/', shareConfig: {} };
    expect(getSharedRuntimeKey('react', plain)).toBe('react');
    expect(getSharedRuntimeKey('react/jsx-runtime', plain)).toBe('react/jsx-runtime');
  });

  it('defaults the runtime key to the property name for a non-prefix alias', () => {
    const shareItem = { name: 'my-react', shareConfig: { request: 'react' } };
    expect(getSharedRuntimeKey('react', shareItem)).toBe('my-react');
    expect(getSharedRuntimeKey('my-react', shareItem)).toBe('my-react');
  });

  it('does not collapse an implicit package subpath into its root key', () => {
    expect(
      getSharedRuntimeKey('lit/decorators.js', {
        name: 'lit',
        shareConfig: {},
      })
    ).toBe('lit/decorators.js');
  });
});
