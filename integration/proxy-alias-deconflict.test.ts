import { describe, expect, it } from 'vitest';
import { resolveProxyAlias } from '../src/utils/bundleHelpers';

describe('resolveProxyAlias', () => {
  it('keeps b.local when it is referenced in the code body', () => {
    const fullImport = `import{r as commonjsGlobal$1}from"./proxy-abc.js"`;
    const code = `${fullImport};console.log(commonjsGlobal$1);`;

    const result = resolveProxyAlias(
      { imported: 'r', local: 'commonjsGlobal$1' },
      'commonjsGlobal',
      code,
      fullImport
    );

    expect(result.local).toBe('commonjsGlobal$1');
  });

  it('restores proxyLocal when b.local is NOT referenced in the code body', () => {
    const fullImport = `import{r as require$0}from"./proxy-abc.js"`;
    const code = `${fullImport};console.log(require$$0);`;

    const result = resolveProxyAlias(
      { imported: 'r', local: 'require$0' },
      'require$$0',
      code,
      fullImport
    );

    expect(result.local).toBe('require$$0');
  });

  it('escapes special regex characters in b.local (e.g. $$)', () => {
    const fullImport = `import{r as require$$0}from"./proxy-abc.js"`;
    const code = `${fullImport};console.log(require$$0);`;

    const result = resolveProxyAlias(
      { imported: 'r', local: 'require$$0' },
      'require$$0',
      code,
      fullImport
    );

    expect(result.local).toBe('require$$0');
  });

  it('returns proxyLocal when b.local only appears in the import statement', () => {
    const fullImport = `import{r as mangledName}from"./proxy-abc.js"`;
    const code = `${fullImport};console.log(originalName);`;

    const result = resolveProxyAlias(
      { imported: 'r', local: 'mangledName' },
      'originalName',
      code,
      fullImport
    );

    expect(result.local).toBe('originalName');
  });

  it('preserves imported field unchanged', () => {
    const fullImport = `import{myExport as renamed}from"./proxy.js"`;
    const code = `${fullImport};console.log(original);`;

    const result = resolveProxyAlias(
      { imported: 'myExport', local: 'renamed' },
      'original',
      code,
      fullImport
    );

    expect(result.imported).toBe('myExport');
  });

  it('keeps rewritten locals unique across multiple proxy imports', () => {
    const firstImport = `import{a as first$1}from"./proxy-a.js"`;
    const secondImport = `import{b as second$1}from"./proxy-b.js"`;
    const code = `${firstImport};${secondImport};console.log(app);`;
    const claimedLocals = new Set(['first$1', 'second$1']);

    claimedLocals.delete('first$1');
    const first = resolveProxyAlias(
      { imported: 'a', local: 'first$1' },
      'o',
      code,
      firstImport,
      claimedLocals
    );
    claimedLocals.add(first.local);
    claimedLocals.delete('second$1');
    const second = resolveProxyAlias(
      { imported: 'b', local: 'second$1' },
      'o',
      code,
      secondImport,
      claimedLocals
    );

    expect(first.local).toBe('o');
    expect(second.local).toBe('second$1');
  });

  it('does not reuse proxyLocal across separate proxy files in one chunk', () => {
    const firstImport = `import{a as first$1}from"./proxy-a.js"`;
    const secondImport = `import{b as second$1}from"./proxy-b.js"`;
    let code = `${firstImport};${secondImport};console.log(app);`;
    const claimedLocals = new Set<string>();

    const rewriteImport = (
      fullImport: string,
      binding: { imported: string; local: string },
      proxyLocal: string,
      importPath: string
    ) => {
      const resolved = resolveProxyAlias(binding, proxyLocal, code, fullImport, claimedLocals);
      claimedLocals.add(resolved.local);
      code = code.replace(
        fullImport,
        `import{${binding.imported} as ${resolved.local}}from"${importPath}";`
      );
      return resolved;
    };

    const first = rewriteImport(firstImport, { imported: 'a', local: 'first$1' }, 'o', './proxy-a.js');
    const second = rewriteImport(secondImport, { imported: 'b', local: 'second$1' }, 'o', './proxy-b.js');

    expect(first.local).toBe('o');
    expect(second.local).toBe('second$1');
  });
});
