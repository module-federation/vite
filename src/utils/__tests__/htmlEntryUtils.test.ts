import { describe, expect, it } from 'vitest';
import {
  findModuleImportDescriptors,
  findModuleImportSources,
  injectEntryScript,
  rewriteEntryScripts,
  sanitizeDevEntryPath,
} from '../htmlEntryUtils';

const INIT_SRC = '/__mf__virtual/hostAutoInit.js';

describe('findModuleImportSources', () => {
  it('finds static, dynamic, side-effect, and re-export sources', () => {
    expect(
      findModuleImportSources(`
        import { app } from 'remote/App';
        import 'setup';
        export { value } from "remote/value";
        const lazy = import('remote/lazy');
      `)
    ).toEqual(['remote/App', 'remote/value', 'remote/lazy', 'setup']);
  });

  it('ignores import-looking text in comments and strings', () => {
    expect(
      findModuleImportSources(`
        // import { fake } from 'commented';
        const text = "import('string-value')";
        import { real } from 'remote';
      `)
    ).toEqual(['remote']);
  });
});

describe('findModuleImportDescriptors', () => {
  it('separates runtime imports from type-only imports', () => {
    expect(
      findModuleImportDescriptors(`
        import type { RemoteType } from 'remote/type';
        export type { ExportedType } from 'remote/export-type';
        export { type NamedType } from 'remote/named-type';
        import { value } from 'remote/value';
        import 'remote/side-effect';
        const lazy = import('remote/lazy');
      `)
    ).toEqual([
      { kind: 'static', syntax: 'import', source: 'remote/type', typeOnly: true },
      { kind: 'static', syntax: 'import', source: 'remote/export-type', typeOnly: true },
      { kind: 'static', syntax: 'import', source: 'remote/named-type', typeOnly: true },
      { kind: 'static', syntax: 'import', source: 'remote/value', typeOnly: false },
      { kind: 'dynamic', syntax: 'import', source: 'remote/lazy', typeOnly: false },
      { kind: 'static', syntax: 'import', source: 'remote/side-effect', typeOnly: false },
    ]);
  });

  it('keeps CommonJS require calls as dynamic descriptors', () => {
    expect(findModuleImportDescriptors(`const value = require('remote/commonjs');`)).toEqual([
      { kind: 'dynamic', syntax: 'require', source: 'remote/commonjs', typeOnly: false },
    ]);
  });

  it('ignores import-looking text in comments and strings', () => {
    expect(
      findModuleImportDescriptors(`
        // import { fake } from 'remote/comment';
        const text = "import('remote/string')";
        const expression = /import 'remote-import'/;
        import 'remote/real';
      `)
    ).toEqual([{ kind: 'static', syntax: 'import', source: 'remote/real', typeOnly: false }]);
  });
});

describe('rewriteEntryScripts', () => {
  it('rewrites a module script tag to a proxy src', () => {
    const html = '<html><body><script type="module" src="/src/main.js"></script></body></html>';
    const result = rewriteEntryScripts(html, (src) => `/proxy?entry=${encodeURIComponent(src)}`);
    expect(result).toContain(`<script type="module" src="/proxy?entry=%2Fsrc%2Fmain.js"></script>`);
  });

  it('preserves @vite/client script tag', () => {
    const html =
      '<head><script type="module" src="/@vite/client"></script></head>' +
      '<body><script type="module" src="/src/main.js"></script></body>';
    const result = rewriteEntryScripts(html, (src) => `/proxy?entry=${encodeURIComponent(src)}`);
    expect(result).toContain('src="/@vite/client"');
    expect(result).toContain(`src="/proxy?entry=%2Fsrc%2Fmain.js"`);
  });

  it('handles multiple entry scripts', () => {
    const html =
      '<body>' +
      '<script type="module" src="/src/app1.js"></script>' +
      '<script type="module" src="/src/app2.js"></script>' +
      '</body>';
    const result = rewriteEntryScripts(html, (src) => `/proxy?entry=${encodeURIComponent(src)}`);
    expect(result).toContain(`src="/proxy?entry=%2Fsrc%2Fapp1.js"`);
    expect(result).toContain(`src="/proxy?entry=%2Fsrc%2Fapp2.js"`);
  });

  it('skips inline module scripts without src attribute', () => {
    const html =
      '<head><script type="module" src="/@vite/client"></script></head>' +
      '<body><script type="module">console.log("inline")</script>' +
      '<script type="module" src="/src/main.js"></script></body>';
    const result = rewriteEntryScripts(html, (src) => `/proxy?entry=${encodeURIComponent(src)}`);
    expect(result).toContain('<script type="module">console.log("inline")</script>');
    expect(result).toContain(`src="/proxy?entry=%2Fsrc%2Fmain.js"`);
    expect(result).toContain('src="/@vite/client"');
  });

  it('returns html unchanged when no entry scripts exist', () => {
    const html = '<html><head></head><body></body></html>';
    expect(rewriteEntryScripts(html, (src) => src)).toBe(html);
  });

  it('handles single-quoted src attributes', () => {
    const html = "<body><script type='module' src='/src/main.js'></script></body>";
    const result = rewriteEntryScripts(html, (src) => `/proxy?entry=${encodeURIComponent(src)}`);
    expect(result).toContain(`src="/proxy?entry=%2Fsrc%2Fmain.js"`);
  });
});

describe('injectEntryScript', () => {
  it('falls back to separate script tag when no entry scripts exist', () => {
    const html = '<html><head></head><body></body></html>';
    const result = injectEntryScript(html, INIT_SRC);
    expect(result).toContain(
      `<head><script type="module" src="/__mf__virtual/hostAutoInit.js"></script>`
    );
  });
});

describe('sanitizeDevEntryPath', () => {
  it('returns path unchanged when no protocol prefix', () => {
    expect(sanitizeDevEntryPath('/src/main.js')).toBe('/src/main.js');
  });

  it('passes through paths without backslashes', () => {
    expect(sanitizeDevEntryPath('/node_modules/__mf__virtual/init.js')).toBe(
      '/node_modules/__mf__virtual/init.js'
    );
  });

  it('converts backslashes to forward slashes', () => {
    expect(sanitizeDevEntryPath('/node_modules\\__mf__virtual\\init.js')).toBe(
      '/node_modules/__mf__virtual/init.js'
    );
  });
});
