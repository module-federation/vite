import { describe, expect, it } from 'vitest';
import { isAbsoluteUrl, rebaseImport, resolveHashPlaceholderFileName } from '../buildPaths';

describe('rebaseImport', () => {
  it('strips dir prefix from absolute path and makes relative', () => {
    expect(rebaseImport('/static/js/hostInit.js', 'static/js/')).toBe('./hostInit.js');
  });

  it('strips dir prefix from bare path and makes relative', () => {
    expect(rebaseImport('static/js/hostInit.js', 'static/js/')).toBe('./hostInit.js');
  });

  it('climbs up for relative path without dir prefix', () => {
    expect(rebaseImport('./src/main.tsx', 'assets/')).toBe('../src/main.tsx');
  });

  it('climbs up for absolute path without dir prefix', () => {
    expect(rebaseImport('/src/main.tsx', 'assets/')).toBe('../src/main.tsx');
  });

  it('climbs up for bare path without dir prefix', () => {
    expect(rebaseImport('src/main.tsx', 'assets/')).toBe('../src/main.tsx');
  });

  it('returns unchanged path when dir is empty', () => {
    expect(rebaseImport('./static/js/hostInit.js', '')).toBe('./static/js/hostInit.js');
  });

  it('does not rebase https:// absolute URLs', () => {
    expect(rebaseImport('https://cdn.example.com/hostInit.js', 'static/js/')).toBe(
      'https://cdn.example.com/hostInit.js'
    );
  });

  it('does not rebase http:// absolute URLs', () => {
    expect(rebaseImport('http://localhost:3000/hostInit.js', 'static/js/')).toBe(
      'http://localhost:3000/hostInit.js'
    );
  });

  it('does not rebase protocol-relative URLs', () => {
    expect(rebaseImport('//cdn.example.com/hostInit.js', 'static/js/')).toBe(
      '//cdn.example.com/hostInit.js'
    );
  });

  it('does not rebase data: URIs', () => {
    expect(rebaseImport('data:text/javascript;base64,ZnVuY3Rpb24oKXt9', 'static/js/')).toBe(
      'data:text/javascript;base64,ZnVuY3Rpb24oKXt9'
    );
  });

  it('does not rebase blob: URIs', () => {
    expect(rebaseImport('blob:https://example.com/uuid', 'static/js/')).toBe(
      'blob:https://example.com/uuid'
    );
  });

  it('strips dir prefix when path starts with / + dir', () => {
    expect(rebaseImport('/static/js/hostInit-abc.js', 'static/js/')).toBe('./hostInit-abc.js');
  });
});

describe('isAbsoluteUrl', () => {
  it('detects https://', () => {
    expect(isAbsoluteUrl('https://example.com/file.js')).toBe(true);
  });

  it('detects http://', () => {
    expect(isAbsoluteUrl('http://localhost/file.js')).toBe(true);
  });

  it('detects protocol-relative //', () => {
    expect(isAbsoluteUrl('//cdn.example.com/file.js')).toBe(true);
  });

  it('detects data: URIs', () => {
    expect(isAbsoluteUrl('data:text/javascript,export{}')).toBe(true);
  });

  it('detects blob: URIs', () => {
    expect(isAbsoluteUrl('blob:https://example.com/uuid')).toBe(true);
  });

  it('does not match relative paths', () => {
    expect(isAbsoluteUrl('./hostInit.js')).toBe(false);
    expect(isAbsoluteUrl('/static/js/hostInit.js')).toBe(false);
    expect(isAbsoluteUrl('static/js/hostInit.js')).toBe(false);
  });
});

describe('resolveHashPlaceholderFileName', () => {
  it('returns names without a placeholder unchanged', () => {
    expect(resolveHashPlaceholderFileName('remoteEntry.js')).toBe('remoteEntry.js');
    expect(resolveHashPlaceholderFileName('assets/remoteEntry.js')).toBe('assets/remoteEntry.js');
  });

  it('strips the placeholder along with its separator', () => {
    expect(resolveHashPlaceholderFileName('remoteEntry-[hash].js')).toBe('remoteEntry.js');
    expect(resolveHashPlaceholderFileName('remoteEntry.[hash].js')).toBe('remoteEntry.js');
    expect(resolveHashPlaceholderFileName('remoteEntry_[hash].js')).toBe('remoteEntry.js');
  });

  it('supports sized placeholders', () => {
    expect(resolveHashPlaceholderFileName('remote-entry-[hash:8].js')).toBe('remote-entry.js');
  });

  it('appends .js when stripping leaves no extension', () => {
    expect(resolveHashPlaceholderFileName('remoteEntry-[hash]')).toBe('remoteEntry.js');
    expect(resolveHashPlaceholderFileName('mf-[hash:8]')).toBe('mf.js');
  });

  it('treats a dotted directory as a directory, not an extension', () => {
    expect(resolveHashPlaceholderFileName('assets/v1.2/remoteEntry-[hash]')).toBe(
      'assets/v1.2/remoteEntry.js'
    );
    expect(resolveHashPlaceholderFileName('static/js.v2/mf-[hash:8]')).toBe('static/js.v2/mf.js');
  });

  it('is stable across repeated calls (global regex lastIndex)', () => {
    for (let i = 0; i < 3; i++) {
      expect(resolveHashPlaceholderFileName('remoteEntry-[hash].js')).toBe('remoteEntry.js');
    }
  });
});
