import { describe, expect, it } from 'vitest';
import { injectEntryScript, rewriteEntryScripts, sanitizeDevEntryPath } from '../htmlEntryUtils';

const INIT_SRC = '/__mf__virtual/hostAutoInit.js';

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
