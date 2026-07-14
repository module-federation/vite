import { describe, expect, it } from 'vitest';
import { createCodePositionMap } from '../codePositionMap';

describe('createCodePositionMap', () => {
  it('keeps exports after one-line JSX closing tags in code', () => {
    const source =
      'export function A(){return <div></div>} export function B(){return <span></span>}';
    const positions = createCodePositionMap(source);

    expect(positions[source.indexOf('export')]).toBe(true);
    expect(positions[source.lastIndexOf('export')]).toBe(true);
  });

  it('masks export-like text in comments, strings, and regular expressions', () => {
    const source =
      '// export const commentValue = 1\nconst text = "export const stringValue = 1"; const matcher = /export const regexValue/;';
    const positions = createCodePositionMap(source);

    expect(positions[source.indexOf('export')]).toBe(false);
    expect(positions[source.indexOf('export', source.indexOf('"'))]).toBe(false);
    expect(positions[source.lastIndexOf('export')]).toBe(false);
  });

  it('does not confuse a less-than comparison followed by a regex with JSX', () => {
    const source = 'const matches = value < /export const phantom/; export const real = 1;';
    const positions = createCodePositionMap(source);

    expect(positions[source.indexOf('export')]).toBe(false);
    expect(positions[source.lastIndexOf('export')]).toBe(true);
  });
});
