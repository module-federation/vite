import { describe, expect, it } from 'vitest';
import { isIdentifierReferenced, resolveProxyAlias } from '../src/utils/bundleHelpers';

describe('isIdentifierReferenced', () => {
  it.each(['$8', '$', '$1', '$$0'])('finds `%s` at the start of an identifier', (name) => {
    expect(isIdentifierReferenced(name, `var n=j3,e=${name},r=PS;`)).toBe(true);
  });

  it.each(['An', 'd6', 'N4', 'require$$0', 'commonjsGlobal$1'])(
    'still finds the ordinary name `%s`',
    (name) => {
      expect(isIdentifierReferenced(name, `const o=${name}.createElement("div");`)).toBe(true);
    }
  );

  it('does not match a longer identifier that merely contains the name', () => {
    expect(isIdentifierReferenced('$8', 'const x=$80;')).toBe(false);
    expect(isIdentifierReferenced('$', 'const x=$foo;')).toBe(false);
    expect(isIdentifierReferenced('r', 'const x=react;')).toBe(false);
  });

  it('does not match when the name is only a suffix of another identifier', () => {
    expect(isIdentifierReferenced('$8', 'const x=a$8;')).toBe(false);
    expect(isIdentifierReferenced('o', 'const x=foo;')).toBe(false);
  });

  it('reports an absent name as unreferenced', () => {
    expect(isIdentifierReferenced('$8', 'console.log(other);')).toBe(false);
  });
});

describe('resolveProxyAlias', () => {
  // The `\b` check reported a minified `$8` binding unused, so the import was
  // rebound to the proxy's export name and its references were left dangling —
  // a clean build that threw `ReferenceError: $8 is not defined` in the browser.
  it.each(['$8', '$', '$1'])(
    'keeps the `%s` alias when it is referenced in the code body',
    (local) => {
      const fullImport = `import{r as ${local},c as Zg}from"./proxy-react.mjs_commonjs-proxy-abc.js";`;
      const code = `${fullImport}var n=j3,e=${local},r=PS;t.exports=r(${local},tI);`;

      const result = resolveProxyAlias({ imported: 'r', local }, 'l', code, fullImport);

      expect(result.local).toBe(local);
    }
  );

  it('still restores proxyLocal when a `$`-prefixed alias is genuinely unused', () => {
    const fullImport = `import{r as $8}from"./proxy-abc.js"`;
    const code = `${fullImport};console.log(somethingElse);`;

    const result = resolveProxyAlias({ imported: 'r', local: '$8' }, 'l', code, fullImport);

    expect(result.local).toBe('l');
  });

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

    const first = rewriteImport(
      firstImport,
      { imported: 'a', local: 'first$1' },
      'o',
      './proxy-a.js'
    );
    const second = rewriteImport(
      secondImport,
      { imported: 'b', local: 'second$1' },
      'o',
      './proxy-b.js'
    );

    expect(first.local).toBe('o');
    expect(second.local).toBe('second$1');
  });
});
