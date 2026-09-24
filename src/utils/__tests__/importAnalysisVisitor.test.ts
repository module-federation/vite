import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VisitorObject } from 'vite';
import { getImportAnalysis } from '../importAnalysis';

const visitor = vi.hoisted(() => ({ enabled: true, available: false, calls: 0 }));

vi.mock('vite', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vite')>();
  visitor.available = typeof actual.Visitor === 'function';
  const Visitor = visitor.available
    ? class extends actual.Visitor {
        constructor(handlers: VisitorObject) {
          super(handlers);
          visitor.calls++;
        }
      }
    : undefined;
  return {
    ...actual,
    get Visitor() {
      return visitor.enabled ? Visitor : undefined;
    },
  };
});

beforeEach(() => {
  visitor.enabled = true;
  visitor.calls = 0;
});

const modules = [
  {
    name: 'default, named and aliased imports and re-exports',
    code: `import Default, { value as local } from 'first';
      export { other as publicName, default as PublicDefault } from 'second';`,
  },
  {
    name: 'namespace imports, star exports and side effects',
    code: `import * as ns from 'namespace';
      export * from 'all';
      export * as exportedNamespace from 'exported-namespace';
      import 'side-effect';
      import {} from 'empty-import';
      export /* comment */ {} from 'empty-export';`,
  },
  {
    name: 'nested dynamic imports and require calls',
    code: `async function load() {
        await import(\`dynamic\`);
        return require('commonjs');
      }
      class Example {
        value = () => import('field');
        method() { return require('method'); }
      }`,
  },
  {
    name: 'string-named exports and import attributes',
    code: `import { "custom-name" as name } from 'quoted';
      export { "custom-name" as publicName } from 'quoted-export';
      import { value } from 'attributes' with { type: 'javascript' };`,
  },
  {
    name: 'strings and comments containing import syntax',
    code: `// import 'comment';
      const text = "require('string')";
      const pattern = /import\\('regex'\\)/;
      const template = \`import('template')\`;
      import { real } from 'real';`,
  },
];

describe('optional AST visitor', () => {
  it.each(modules)('matches the existing walker for $name', ({ code }) => {
    visitor.enabled = false;
    const expected = getImportAnalysis({}).analyze(code);
    expect(expected).not.toBeNull();
    expect(visitor.calls).toBe(0);

    visitor.enabled = true;
    expect(getImportAnalysis({}).analyze(code)).toEqual(expected);
    expect(visitor.calls).toBe(visitor.available ? 1 : 0);
  });

  it('does not walk again when import analysis is cached', () => {
    const analysis = getImportAnalysis({});
    const code = 'import { value } from "library";';
    analysis.analyze(code);
    analysis.analyze(code);
    expect(visitor.calls).toBe(visitor.available ? 1 : 0);
  });

  it.skipIf(!visitor.available)(
    'retries deep expressions without retaining partial results',
    () => {
      const code = `import { before } from 'first';
      const expression = ${Array(10_000).fill('value').join(' + ')};
      import { after } from 'last';`;
      expect(getImportAnalysis({}).analyze(code)).toEqual([
        { source: 'first', usedExports: ['before'] },
        { source: 'last', usedExports: ['after'] },
      ]);
      expect(visitor.calls).toBe(1);
    }
  );
});
