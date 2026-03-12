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

  it('sanitizes initSrc with protocol prefix', () => {
    const html = '<body><script type="module" src="/src/main.js"></script></body>';
    const result = inlineEntryScripts(html, 'file:///home/user/project/init.js');
    expect(result).toContain(`await import("//home/user/project/init.js")`);
  });

  it('sanitizes initSrc with backslashes', () => {
    const html = '<body><script type="module" src="/src/main.js"></script></body>';
    const result = inlineEntryScripts(html, 'C:\\Users\\project\\init.js');
    expect(result).toContain(`await import("/Users/project/init.js")`);
  });
});

describe('sanitizeDevEntryPath', () => {
  it('returns path unchanged when no protocol prefix', () => {
    expect(sanitizeDevEntryPath('/src/main.js')).toBe('/src/main.js');
  });

  it('strips protocol prefix', () => {
    expect(sanitizeDevEntryPath('file:///home/user/init.js')).toBe('//home/user/init.js');
  });

  it('converts backslashes to forward slashes', () => {
    expect(sanitizeDevEntryPath('C:\\Users\\project\\init.js')).toBe('/Users/project/init.js');
  });
});
