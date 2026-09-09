import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guard for the JavaScript baseline of the code we *emit*.
 *
 * The virtual modules below are generated as source strings and shipped into
 * the consumer's browser bundle. Vite does not transpile them against the
 * consumer's build targets, so an API that is too new here breaks their app at
 * runtime with no build-time warning — see the `Object.hasOwn` revert in #1251.
 *
 * The emitted code currently sits at ES2021 (`??=` / `||=`), so anything newer
 * than that is rejected. This is a floor, not an aspiration: if the baseline is
 * ever raised deliberately, move BASELINE and the pattern list together.
 *
 * SSR generators are exempt — their output is imported by Node on the server,
 * never by a browser, which is why `AggregateError` is fine in the SSR entry.
 */
const BASELINE = 'ES2021';

const REPO_SRC = path.resolve(__dirname, '..');

// Modules whose template literals become browser-executed code.
const BROWSER_EMITTING_MODULES = [
  'utils/packageUtils.ts',
  'virtualModules/virtualExposes.ts',
  'virtualModules/virtualRemoteEntry.ts',
  'virtualModules/virtualRemotes.ts',
  'virtualModules/virtualRuntimeInitStatus.ts',
  'virtualModules/virtualShared_preBuild.ts',
];

// Deliberately Node-only, listed so the exemption is a decision rather than an omission.
const SSR_ONLY_MODULES = [
  'virtualModules/virtualExposesSSR.ts',
  'virtualModules/virtualRemoteEntrySSR.ts',
];

/**
 * APIs newer than the baseline. Matching on APIs rather than syntax keeps false
 * positives low; extend the list when a new one becomes reachable.
 */
const POST_BASELINE_APIS: { name: string; since: string; pattern: RegExp }[] = [
  { name: 'Object.hasOwn', since: 'ES2022', pattern: /\bObject\.hasOwn\s*\(/g },
  { name: 'Array.prototype.at', since: 'ES2022', pattern: /\.at\s*\(\s*-?\d/g },
  { name: 'structuredClone', since: 'ES2022', pattern: /\bstructuredClone\s*\(/g },
  { name: 'Array.prototype.findLast', since: 'ES2023', pattern: /\.findLast(?:Index)?\s*\(/g },
  {
    name: 'Array.prototype.toSorted/toReversed/toSpliced',
    since: 'ES2023',
    pattern: /\.to(?:Sorted|Reversed|Spliced)\s*\(/g,
  },
  {
    name: 'Object.groupBy / Map.groupBy',
    since: 'ES2024',
    pattern: /\b(?:Object|Map)\.groupBy\s*\(/g,
  },
  { name: 'Array.fromAsync', since: 'ES2024', pattern: /\bArray\.fromAsync\s*\(/g },
];

type TemplateChunk = { text: string; line: number };

/**
 * Collect the literal text of every template literal in `source`, excluding the
 * `${...}` expressions — those are build-time TypeScript, not emitted output.
 *
 * A regex cannot do this: template literals nest, and backticks appear inside
 * ordinary strings and comments. This walks the source with a small mode stack
 * instead, which is enough to keep `${}` interpolations out of the results.
 */
function collectTemplateChunks(source: string): TemplateChunk[] {
  const chunks: TemplateChunk[] = [];
  // Each template frame accumulates its literal text; each expression frame
  // tracks brace depth so the matching `}` returns us to the template.
  const stack: ({ kind: 'tpl'; text: string; line: number } | { kind: 'expr'; depth: number })[] =
    [];
  let line = 1;
  let i = 0;

  const top = () => stack[stack.length - 1];
  const inTemplateText = () => top()?.kind === 'tpl';

  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];

    if (c === '\n') line++;

    // Comments and quoted strings are skipped wholesale, but only when we are
    // not inside template text (where they are just characters).
    if (!inTemplateText()) {
      if (c === '/' && next === '/') {
        while (i < source.length && source[i] !== '\n') i++;
        continue;
      }
      if (c === '/' && next === '*') {
        i += 2;
        while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
          if (source[i] === '\n') line++;
          i++;
        }
        i += 2;
        continue;
      }
      if (c === "'" || c === '"') {
        const quote = c;
        i++;
        while (i < source.length && source[i] !== quote) {
          if (source[i] === '\\') i++;
          else if (source[i] === '\n') line++;
          i++;
        }
        i++;
        continue;
      }
    }

    if (c === '\\' && inTemplateText()) {
      // Keep escapes verbatim; they cannot open or close anything.
      const frame = top() as { kind: 'tpl'; text: string };
      frame.text += source.slice(i, i + 2);
      i += 2;
      continue;
    }

    if (c === '`') {
      if (inTemplateText()) {
        chunks.push({
          text: (top() as { text: string }).text,
          line: (top() as { line: number }).line,
        });
        stack.pop();
      } else {
        stack.push({ kind: 'tpl', text: '', line });
      }
      i++;
      continue;
    }

    if (inTemplateText() && c === '$' && next === '{') {
      stack.push({ kind: 'expr', depth: 1 });
      i += 2;
      continue;
    }

    if (top()?.kind === 'expr') {
      const frame = top() as { kind: 'expr'; depth: number };
      if (c === '{') frame.depth++;
      else if (c === '}') {
        frame.depth--;
        if (frame.depth === 0) stack.pop();
      }
      i++;
      continue;
    }

    if (inTemplateText()) {
      (top() as { text: string }).text += c;
    }
    i++;
  }

  return chunks;
}

function findViolations(relativePath: string) {
  const source = readFileSync(path.join(REPO_SRC, relativePath), 'utf8');
  const violations: string[] = [];

  for (const chunk of collectTemplateChunks(source)) {
    for (const { name, since, pattern } of POST_BASELINE_APIS) {
      pattern.lastIndex = 0;
      if (pattern.test(chunk.text)) {
        violations.push(`${relativePath}:~${chunk.line} uses ${name} (${since})`);
      }
    }
  }

  return violations;
}

describe(`emitted browser runtime stays at ${BASELINE}`, () => {
  it.each(BROWSER_EMITTING_MODULES)('%s emits no post-baseline API', (relativePath) => {
    expect(findViolations(relativePath)).toEqual([]);
  });

  it('detects a post-baseline API when one is introduced', () => {
    // Pins the detector itself, so a broken scanner cannot pass silently.
    const sample = [
      'export const code = `',
      '  const hit = Object.hasOwn(cache, key);',
      '  const safe = Object.prototype.hasOwnProperty.call(cache, key);',
      '`;',
    ].join('\n');

    const chunks = collectTemplateChunks(sample);
    expect(chunks).toHaveLength(1);
    expect(POST_BASELINE_APIS[0].pattern.test(chunks[0].text)).toBe(true);
  });

  it('ignores ${} expressions, which are build-time code', () => {
    const sample = 'const code = `before ${Object.hasOwn(a, b) ? `yes` : `no`} after`;';
    const chunks = collectTemplateChunks(sample);
    const combined = chunks.map((c) => c.text).join('|');

    expect(combined).not.toContain('Object.hasOwn');
    expect(combined).toContain('before ');
    expect(combined).toContain(' after');
  });

  it('keeps SSR generators out of the browser baseline', () => {
    // They run in Node, so newer APIs are legitimate there. Recorded as an
    // explicit exemption; AggregateError in the SSR entry is the current case.
    for (const relativePath of SSR_ONLY_MODULES) {
      expect(BROWSER_EMITTING_MODULES).not.toContain(relativePath);
      expect(() => readFileSync(path.join(REPO_SRC, relativePath), 'utf8')).not.toThrow();
    }
  });
});
