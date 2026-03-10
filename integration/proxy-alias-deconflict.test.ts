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
});
