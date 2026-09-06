import { describe, expect, it } from 'vitest';
import {
  findModuleImportDescriptors,
  findModuleImportSources,
  getScannableModuleSource,
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

  it('ignores type-only imports', () => {
    expect(
      findModuleImportSources(`
        import type { RemoteType } from 'remote/type';
        export type { ExportedType } from 'remote/export-type';
        import { value } from 'remote/runtime';
        const lazy = import('remote/lazy');
      `)
    ).toEqual(['remote/runtime', 'remote/lazy']);
  });

  it('finds a namespace import after a comment mentioning an import', () => {
    expect(
      findModuleImportDescriptors(`
        // Static import of the entry remote.
        import * as remote from 'remote/namespace';
      `)
    ).toEqual([{ kind: 'static', syntax: 'import', source: 'remote/namespace', typeOnly: false }]);
  });
});

describe('findModuleImportDescriptors', () => {
  it('treats an imported runtime binding named type as a value import', () => {
    expect(findModuleImportDescriptors(`import { type as value } from 'remote/value';`)).toEqual([
      { kind: 'static', syntax: 'import', source: 'remote/value', typeOnly: false },
    ]);
  });

  it.each([`import type from 'remote/value';`, `import type, { value } from 'remote/value';`])(
    'treats a default runtime binding named type as a value import',
    (source) => {
      expect(findModuleImportDescriptors(source)).toEqual([
        { kind: 'static', syntax: 'import', source: 'remote/value', typeOnly: false },
      ]);
    }
  );

  it('separates runtime imports from type-only imports', () => {
    expect(
      findModuleImportDescriptors(`
        import type DefaultType from 'remote/default-type';
        import type { RemoteType } from 'remote/type';
        import type * as RemoteTypes from 'remote/namespace-type';
        export type { ExportedType } from 'remote/export-type';
        export { type NamedType } from 'remote/named-type';
        import { value } from 'remote/value';
        import 'remote/side-effect';
        const lazy = import('remote/lazy');
      `)
    ).toEqual([
      { kind: 'static', syntax: 'import', source: 'remote/default-type', typeOnly: true },
      { kind: 'static', syntax: 'import', source: 'remote/type', typeOnly: true },
      { kind: 'static', syntax: 'import', source: 'remote/namespace-type', typeOnly: true },
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

  it('does not let comments change the classification of an import', () => {
    expect(
      findModuleImportDescriptors(`
        import type /* comment */, { value } from 'remote/runtime';
        import { type/* comment */Foo } from 'remote/type';
        import { value } from /* comment */ 'remote/comment-before-source';
      `)
    ).toEqual([
      {
        kind: 'static',
        syntax: 'import',
        source: 'remote/runtime',
        typeOnly: false,
      },
      {
        kind: 'static',
        syntax: 'import',
        source: 'remote/type',
        typeOnly: true,
      },
      {
        kind: 'static',
        syntax: 'import',
        source: 'remote/comment-before-source',
        typeOnly: false,
      },
    ]);
  });

  it('does not span multiple statements when classifying re-exports', () => {
    expect(
      findModuleImportDescriptors(`
        export type Local = string;
        export { value } from 'remote/value';
        import Legacy = require('remote/legacy');
        import { other } from 'remote/other';
        export * from 'remote/star';
        export * as ns from 'remote/namespace';
        export type * from 'remote/type-star';
      `)
    ).toEqual([
      {
        kind: 'static',
        syntax: 'import',
        source: 'remote/value',
        typeOnly: false,
      },
      {
        kind: 'static',
        syntax: 'import',
        source: 'remote/other',
        typeOnly: false,
      },
      {
        kind: 'static',
        syntax: 'import',
        source: 'remote/star',
        typeOnly: false,
      },
      {
        kind: 'static',
        syntax: 'import',
        source: 'remote/namespace',
        typeOnly: false,
      },
      {
        kind: 'static',
        syntax: 'import',
        source: 'remote/type-star',
        typeOnly: true,
      },
      {
        kind: 'dynamic',
        syntax: 'require',
        source: 'remote/legacy',
        typeOnly: false,
      },
    ]);
  });

  it('does not invent imports from `from` inside strings or trailing comments', () => {
    expect(
      findModuleImportDescriptors(`
        export const text = " from 'fake-package'";
        export const value = 1; // from 'fake-package'
        export const escaped = 'it\\'s'; import { real } from 'remote/real';
      `)
    ).toEqual([
      {
        kind: 'static',
        syntax: 'import',
        source: 'remote/real',
        typeOnly: false,
      },
    ]);
  });

  it('finds dynamic imports with options or comments before the source', () => {
    expect(
      findModuleImportDescriptors(`
        import('remote/json', { with: { type: 'json' } });
        import /* comment */ ('remote/commented');
      `)
    ).toEqual([
      {
        kind: 'dynamic',
        syntax: 'import',
        source: 'remote/json',
        typeOnly: false,
      },
      {
        kind: 'dynamic',
        syntax: 'import',
        source: 'remote/commented',
        typeOnly: false,
      },
    ]);
  });

  it('finds imports in minified code without whitespace', () => {
    expect(
      findModuleImportDescriptors(
        `import{a}from"remote/a";import*as b from"remote/b";export{c}from"remote/c";export*from"remote/d";import"remote/e";import("remote/f")`
      ).map(({ source }) => source)
    ).toEqual(['remote/a', 'remote/b', 'remote/c', 'remote/d', 'remote/f', 'remote/e']);
  });

  it('ignores member accesses named import or require', () => {
    expect(
      findModuleImportDescriptors(`loader.import('remote/member'); ctx.require('remote/member');`)
    ).toEqual([]);
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

describe('getScannableModuleSource', () => {
  it('returns plain modules unchanged', () => {
    const code = `import 'remote/plain';`;
    expect(getScannableModuleSource('/src/entry.ts', code)).toBe(code);
  });

  it.each(['/src/App.vue', '/src/App.svelte', '/src/App.vue?vue&type=script'])(
    'only scans script blocks of %s',
    (id) => {
      const source = getScannableModuleSource(
        id,
        `<template><p>import 'remote/template'</p><!-- import 'remote/html-comment' --></template>
<script setup lang="ts">import { a } from 'remote/setup';</script>
<script>import 'remote/plain';</script>
<style>/* import 'remote/style' */ .x { content: "import 'remote/css'" }</style>`
      );
      expect(findModuleImportSources(source)).toEqual(['remote/setup', 'remote/plain']);
    }
  );

  it('closes a script block at an end tag carrying whitespace or attributes', () => {
    expect(
      findModuleImportSources(
        getScannableModuleSource(
          '/src/App.svelte',
          `<script>import 'remote/a';</script\t\n bar>\n<p>import 'remote/template'</p>\n<script>import 'remote/b';</script >`
        )
      )
    ).toEqual(['remote/a', 'remote/b']);
  });

  it('returns nothing for a component without script blocks', () => {
    expect(getScannableModuleSource('/src/App.vue', `<template><p>import 'x'</p></template>`)).toBe(
      ''
    );
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

  it.each([
    '<script type="module" src="/external/external.js" vite-ignore></script>',
    '<script vite-ignore="" src="/external/external.js" type="module"></script>',
  ])('preserves vite-ignore script tags', (script) => {
    const result = rewriteEntryScripts(script, (src) => `/proxy?entry=${encodeURIComponent(src)}`);
    expect(result).toBe(script);
  });

  it('does not confuse similarly named attributes with vite-ignore', () => {
    const html = '<script type="module" src="/src/main.js" data-vite-ignore="true"></script>';
    const result = rewriteEntryScripts(html, (src) => `/proxy?entry=${encodeURIComponent(src)}`);
    expect(result).toContain('src="/proxy?entry=%2Fsrc%2Fmain.js"');
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

  it.each(['<head lang="en">', '<HEAD>', '<head data-capo>'])(
    'injects into a non-exact head tag (%s)',
    (headTag) => {
      const html = `<html>${headTag}</head><body></body></html>`;
      const result = injectEntryScript(html, INIT_SRC);
      expect(result).toContain(
        `${headTag}<script type="module" src="/__mf__virtual/hostAutoInit.js"></script>`
      );
    }
  );

  it('does not treat a header element as a head tag', () => {
    const html = '<html><header></header><body></body></html>';
    expect(injectEntryScript(html, INIT_SRC)).toBe(html);
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
