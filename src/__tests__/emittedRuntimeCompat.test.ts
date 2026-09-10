import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCodePositionMap } from '../utils/codePositionMap';

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

// Modules whose generated strings become browser-executed code.
const BROWSER_EMITTING_MODULES = [
  'index.ts',
  'plugins/hmr/react.ts',
  'plugins/hmr/vue.ts',
  'plugins/pluginAddEntry.ts',
  'plugins/pluginDevRemoteHmr.ts',
  'plugins/pluginExternalRuntimeCore.ts',
  'plugins/pluginProxyRemoteEntry.ts',
  'plugins/pluginReactMixedModeGuard.ts',
  'plugins/pluginRemoteNamedExports.ts',
  'plugins/pluginVarRemoteEntry.ts',
  'utils/bundleHelpers.ts',
  'utils/packageUtils.ts',
  'utils/reactIsland.ts',
  'utils/serializeRuntimeOptions.ts',
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
  { name: 'Array.prototype.at', since: 'ES2022', pattern: /\.at\s*\(/g },
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
  { name: 'Promise.withResolvers', since: 'ES2024', pattern: /\bPromise\.withResolvers\s*\(/g },
];

type TemplateChunk = { text: string; line: number };

/**
 * Collect every string and template-literal chunk in `source`, excluding
 * `${...}` expressions. Regex locations come from the shared source scanner so
 * backticks inside regexes cannot corrupt the lightweight template walk.
 */
function collectRuntimeStringChunks(source: string): TemplateChunk[] {
  const chunks: TemplateChunk[] = [];
  const codePositions = createCodePositionMap(source);
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
      if (stack.length === 0 && c === '/' && !codePositions[i]) {
        i++;
        while (i < source.length && !codePositions[i]) i++;
        continue;
      }
      if (c === "'" || c === '"') {
        const quote = c;
        const startLine = line;
        let text = '';
        i++;
        while (i < source.length && source[i] !== quote) {
          if (source[i] === '\\') {
            text += source.slice(i, i + 2);
            i += 2;
            continue;
          }
          if (source[i] === '\n') line++;
          text += source[i];
          i++;
        }
        chunks.push({ text, line: startLine });
        i++;
        continue;
      }
    }

    if (c === '\\' && inTemplateText()) {
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

    if (inTemplateText()) (top() as { text: string }).text += c;
    i++;
  }

  return chunks;
}

function findViolations(relativePath: string) {
  const source = readFileSync(path.join(REPO_SRC, relativePath), 'utf8');
  const violations: string[] = [];

  for (const chunk of collectRuntimeStringChunks(source)) {
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

    const chunks = collectRuntimeStringChunks(sample);
    expect(chunks).toHaveLength(1);
    expect(POST_BASELINE_APIS[0].pattern.test(chunks[0].text)).toBe(true);
  });

  it('ignores ${} expressions, which are build-time code', () => {
    const sample = 'const code = `before ${Object.hasOwn(a, b) ? `yes` : `no`} after`;';
    const chunks = collectRuntimeStringChunks(sample);
    const combined = chunks.map((c) => c.text).join('|');

    expect(combined).not.toContain('Object.hasOwn');
    expect(combined).toContain('before ');
    expect(combined).toContain(' after');
  });

  it('detects .at() calls with non-literal indexes', () => {
    const sample = 'export const code = `const last = items.at(index);`;';
    const chunks = collectRuntimeStringChunks(sample);

    expect(POST_BASELINE_APIS[1].pattern.test(chunks[0].text)).toBe(true);
  });

  it('scans emitted code assembled from quoted strings', () => {
    const sample = `export const code = ['Object.hasOwn(cache, key)'].join('\\n');`;
    const combined = collectRuntimeStringChunks(sample)
      .map((chunk) => chunk.text)
      .join('|');

    expect(combined).toContain('Object.hasOwn');
  });

  it('does not treat backticks inside regexes as templates', () => {
    const sample = [
      'const templateToken = /[`]/;',
      'const buildTimeOnly = Object.hasOwn(config, "value");',
      'export const code = `safe`;',
    ].join('\n');
    const combined = collectRuntimeStringChunks(sample)
      .map((chunk) => chunk.text)
      .join('|');

    expect(combined).not.toContain('Object.hasOwn');
    expect(combined).toContain('safe');
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
