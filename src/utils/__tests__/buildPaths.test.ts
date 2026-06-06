import { describe, expect, it } from 'vitest';
import { rebaseImport } from '../buildPaths';

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
});
