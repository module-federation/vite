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

  it('reports only actual comment ranges, preserving the original position map', () => {
    const source =
      'export/* block\ncomment */const text = "/* literal */", template = `// literal`, pattern = /[/*]/; // line\nexport { text };';
    const comments: string[] = [];
    const positions = createCodePositionMap(source, (start, end) => {
      comments.push(source.slice(start, end));
    });

    expect(comments).toEqual(['/* block\ncomment */', '// line']);
    expect(positions).toEqual(createCodePositionMap(source));
  });

  it.each([
    ['single quotes', "const text = `${`'`}`;"],
    ['double quotes', 'const text = `${`"`}`;'],
    ['multiple nesting levels', "const text = `${`${`'`}`}`;"],
    ['object braces', 'const text = `${({ value: `"` }).value}`;'],
    ['regex braces', 'const text = `${/}/.test("}") ? `"` : ""}`;'],
    ['block comments', 'const text = `${/* } */ `"`}`;'],
    ['line comments', 'const text = `${// }\n`"`}`;'],
  ])('keeps exports after nested template expressions containing %s', (_name, prefix) => {
    const source = `${prefix} export const answer = 1;`;
    const positions = createCodePositionMap(source);

    expect(positions[source.indexOf('export')]).toBe(true);
    expect(positions.slice(prefix.indexOf('`'), prefix.lastIndexOf('`') + 1)).not.toContain(true);
  });

  it('masks export-like text inside nested templates', () => {
    const source = "const text = `${`'export const phantom = 1'`}`; export const answer = 1;";
    const positions = createCodePositionMap(source);

    expect(positions[source.indexOf('export')]).toBe(false);
    expect(positions[source.lastIndexOf('export')]).toBe(true);
  });

  it.each([
    'if (true)',
    'if ((check(true)))',
    'if /* condition */ (true)',
    'while (false)',
    'for (; false;)',
    'for (const item of [])',
    'for await (const item of [])',
  ])('preserves exports after a template containing a regex following %s', (condition) => {
    const prefix = 'const text = `${ (async () => { ' + condition + ' /"/.test("x"); })() }`;';
    const source = `${prefix} export const answer = 1;`;
    const positions = createCodePositionMap(source);

    expect(positions[source.indexOf('export')]).toBe(true);
    expect(positions.slice(prefix.indexOf('`'), prefix.lastIndexOf('`') + 1)).not.toContain(true);
  });

  it.each(['check()', '(value)', 'object.if()', 'object?.while()', 'object./* method */for()'])(
    'keeps division after %s distinct from a regex',
    (expression) => {
      const source = `const value = ${expression} / divisor; export const answer = value / 2;`;
      const positions = createCodePositionMap(source);

      expect(positions[source.indexOf('export')]).toBe(true);
      expect(positions[source.indexOf('/ divisor')]).toBe(true);
    }
  );
});
