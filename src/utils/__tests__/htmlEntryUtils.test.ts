import { describe, expect, it } from 'vitest';
import { inlineEntryScripts, sanitizeDevEntryPath } from '../htmlEntryUtils';

const INIT_SRC = '/__mf__virtual/hostAutoInit.js';

describe('inlineEntryScripts', () => {
  it('inlines init import into a module script tag', () => {
    const html = '<html><body><script type="module" src="/src/main.js"></script></body></html>';
    const result = inlineEntryScripts(html, INIT_SRC);
    expect(result).toContain(
      `<script type="module">await import("/__mf__virtual/hostAutoInit.js");await import("/src/main.js");</script>`
    );
  });

  it('preserves @vite/client script tag', () => {
    const html =
      '<head><script type="module" src="/@vite/client"></script></head>' +
      '<body><script type="module" src="/src/main.js"></script></body>';
    const result = inlineEntryScripts(html, INIT_SRC);
    expect(result).toContain('src="/@vite/client"');
    expect(result).toContain(`await import("/src/main.js")`);
  });

  it('handles multiple entry scripts', () => {
    const html =
      '<body>' +
      '<script type="module" src="/src/app1.js"></script>' +
      '<script type="module" src="/src/app2.js"></script>' +
      '</body>';
    const result = inlineEntryScripts(html, INIT_SRC);
    expect(result).toContain(`await import("/src/app1.js")`);
    expect(result).toContain(`await import("/src/app2.js")`);
    expect(result).not.toContain('src="/src/app1.js"');
    expect(result).not.toContain('src="/src/app2.js"');
  });

  it('falls back to separate script tag when no entry scripts exist', () => {
    const html = '<html><head></head><body></body></html>';
    const result = inlineEntryScripts(html, INIT_SRC);
    expect(result).toContain(
      `<head><script type="module" src="/__mf__virtual/hostAutoInit.js"></script>`
    );
  });

  it('handles single-quoted src attributes', () => {
    const html = "<body><script type='module' src='/src/main.js'></script></body>";
    const result = inlineEntryScripts(html, INIT_SRC);
    expect(result).toContain(`await import("/src/main.js")`);
  });

  it('sanitizes initSrc with protocol prefix (already root-relative)', () => {
    const html = '<body><script type="module" src="/src/main.js"></script></body>';
    // devEntryPath is now built root-relative in pluginAddEntry; sanitize only normalizes slashes
    const result = inlineEntryScripts(html, '/node_modules/__mf__virtual/init.js');
    expect(result).toContain(`await import("/node_modules/__mf__virtual/init.js")`);
  });

  it('sanitizes initSrc with backslashes', () => {
    const html = '<body><script type="module" src="/src/main.js"></script></body>';
    const result = inlineEntryScripts(html, '/node_modules\\__mf__virtual\\init.js');
    expect(result).toContain(`await import("/node_modules/__mf__virtual/init.js")`);
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
