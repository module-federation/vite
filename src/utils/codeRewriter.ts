const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export interface SourceMapLike {
  version: 3;
  sources: string[];
  sourcesContent: string[];
  names: string[];
  mappings: string;
}

interface Replacement {
  start: number;
  end: number;
  content: string;
}

interface AppliedReplacement extends Replacement {
  generatedStart: number;
  generatedEnd: number;
}

export class CodeRewriter {
  private replacements: Replacement[] = [];

  constructor(private readonly original: string) {}

  overwrite(start: number, end: number, content: string): void {
    if (start < 0 || end < start || end > this.original.length) {
      throw new Error(`Invalid overwrite range: ${start}-${end}`);
    }

    this.replacements.push({ start, end, content });
  }

  toString(): string {
    return applyReplacements(this.original, this.getSortedReplacements()).code;
  }

  generateMap(source = ''): SourceMapLike {
    const { code, replacements } = applyReplacements(this.original, this.getSortedReplacements());

    return {
      version: 3,
      sources: [source],
      sourcesContent: [this.original],
      names: [],
      mappings: generateLineMappings(code, this.original, replacements),
    };
  }

  private getSortedReplacements(): Replacement[] {
    return [...this.replacements].sort((a, b) => a.start - b.start || a.end - b.end);
  }
}

export function createSourceMap(code: string, source = ''): SourceMapLike {
  return {
    version: 3,
    sources: [source],
    sourcesContent: [code],
    names: [],
    mappings: generateLineMappings(code, code, []),
  };
}

function applyReplacements(original: string, replacements: Replacement[]) {
  let code = '';
  let cursor = 0;
  let delta = 0;
  const applied: AppliedReplacement[] = [];

  for (const replacement of replacements) {
    if (replacement.start < cursor) {
      throw new Error('Overlapping overwrite ranges are not supported');
    }

    code += original.slice(cursor, replacement.start);

    const generatedStart = replacement.start + delta;
    code += replacement.content;
    const generatedEnd = generatedStart + replacement.content.length;

    applied.push({ ...replacement, generatedStart, generatedEnd });
    cursor = replacement.end;
    delta += replacement.content.length - (replacement.end - replacement.start);
  }

  code += original.slice(cursor);

  return { code, replacements: applied };
}

function generateLineMappings(
  generated: string,
  original: string,
  replacements: AppliedReplacement[]
): string {
  const generatedLineStarts = getLineStarts(generated);
  const originalLineStarts = getLineStarts(original);
  let previousOriginalLine = 0;
  let previousOriginalColumn = 0;
  let mappings = '';

  generatedLineStarts.forEach((generatedOffset, lineIndex) => {
    if (lineIndex > 0) mappings += ';';

    const originalOffset = generatedOffsetToOriginalOffset(generatedOffset, replacements);
    const originalLine = findLine(originalLineStarts, originalOffset);
    const originalColumn = originalOffset - originalLineStarts[originalLine];

    mappings += encodeSegment([
      0,
      0,
      originalLine - previousOriginalLine,
      originalColumn - previousOriginalColumn,
    ]);
    previousOriginalLine = originalLine;
    previousOriginalColumn = originalColumn;
  });

  return mappings;
}

function generatedOffsetToOriginalOffset(
  offset: number,
  replacements: AppliedReplacement[]
): number {
  let delta = 0;

  for (const replacement of replacements) {
    if (offset < replacement.generatedStart) break;
    if (offset < replacement.generatedEnd) return replacement.start;
    delta += replacement.content.length - (replacement.end - replacement.start);
  }

  return offset - delta;
}

function getLineStarts(code: string): number[] {
  const starts = [0];

  for (let i = 0; i < code.length; i++) {
    if (code.charCodeAt(i) === 10) starts.push(i + 1);
  }

  return starts;
}

function findLine(lineStarts: number[], offset: number): number {
  let low = 0;
  let high = lineStarts.length - 1;

  while (low <= high) {
    const mid = (low + high) >> 1;
    if (lineStarts[mid] <= offset) low = mid + 1;
    else high = mid - 1;
  }

  return Math.max(0, high);
}

function encodeSegment(values: number[]): string {
  return values.map(encodeVlq).join('');
}

function encodeVlq(value: number): string {
  let vlq = value < 0 ? (-value << 1) + 1 : value << 1;
  let encoded = '';

  do {
    let digit = vlq & 31;
    vlq >>>= 5;
    if (vlq > 0) digit |= 32;
    encoded += BASE64_CHARS[digit];
  } while (vlq > 0);

  return encoded;
}
