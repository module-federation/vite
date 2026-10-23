const REGEX_PREFIX_KEYWORDS = new Set([
  'await',
  'case',
  'delete',
  'in',
  'instanceof',
  'new',
  'return',
  'throw',
  'typeof',
  'void',
  'yield',
]);
const CONTROL_PAREN_KEYWORDS = new Set(['if', 'while', 'for', 'with', 'switch', 'catch']);

// The scanner tests every character, so ASCII is answered by char code and only
// other characters reach the equivalent Unicode regex.
function isWhitespace(char: string | undefined): boolean {
  if (char === undefined) return false;
  const code = char.charCodeAt(0);
  if (code < 128) return code === 32 || (code >= 9 && code <= 13);
  return /\s/.test(char);
}

function isAsciiLetter(code: number): boolean {
  return (code >= 97 && code <= 122) || (code >= 65 && code <= 90);
}

function isAsciiDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

function isIdentifierStart(char: string): boolean {
  const code = char.charCodeAt(0);
  if (code < 128) return isAsciiLetter(code) || code === 36 || code === 95;
  return /[$_\p{ID_Start}]/u.test(char);
}

function isIdentifierPart(char: string | undefined): boolean {
  if (char === undefined) return false;
  const code = char.charCodeAt(0);
  if (code < 128) return isAsciiLetter(code) || isAsciiDigit(code) || code === 36 || code === 95;
  return /[$_\u200C\u200D\p{ID_Continue}]/u.test(char);
}

function isRegexFlag(char: string | undefined): boolean {
  if (char === undefined) return false;
  const code = char.charCodeAt(0);
  if (code < 128) return isAsciiLetter(code) || isAsciiDigit(code) || code === 36 || code === 95;
  return /[$_\p{ID_Continue}]/u.test(char);
}

function isNumberPart(char: string | undefined): boolean {
  if (char === undefined) return false;
  const code = char.charCodeAt(0);
  return isAsciiLetter(code) || isAsciiDigit(code) || code === 95 || code === 46;
}

function isJsxClosingTagSlash(code: string, slashIndex: number): boolean {
  if (code[slashIndex - 1] !== '<') return false;

  let cursor = slashIndex + 1;
  while (isWhitespace(code[cursor])) cursor++;
  if (code[cursor] === '>') return true;

  const tagStart = cursor;
  while (/[-:.$_\u200C\u200D\p{ID_Continue}]/u.test(code[cursor] || '')) cursor++;
  if (cursor === tagStart) return false;
  while (isWhitespace(code[cursor])) cursor++;

  return code[cursor] === '>';
}

/** Mark comments, string/template literals, and regular expressions as non-code. */
export function createCodePositionMap(
  code: string,
  onComment?: (start: number, end: number) => void
): Uint8Array {
  const positions = new Uint8Array(code.length).fill(1);
  const mask = (start: number, end: number) => {
    positions.fill(0, start, end);
  };
  let canStartRegex = true;
  let pendingControlParen: string | undefined;
  const controlParens: boolean[] = [];
  let templateStart: number | undefined;
  const templateExpressions: { start: number; braceDepth: number }[] = [];

  for (let index = 0; index < code.length;) {
    const char = code[index];
    const next = code[index + 1];

    if (templateStart !== undefined) {
      if (char === '\\') {
        index += 2;
      } else if (char === '`') {
        mask(templateStart, ++index);
        templateStart = undefined;
        canStartRegex = false;
      } else if (char === '$' && next === '{') {
        templateExpressions.push({ start: templateStart, braceDepth: 0 });
        templateStart = undefined;
        canStartRegex = true;
        index += 2;
      } else {
        index++;
      }
      continue;
    }

    if (isWhitespace(char)) {
      index++;
      continue;
    }
    if (char === '/' && next === '/') {
      const start = index;
      index += 2;
      while (index < code.length && code[index] !== '\n' && code[index] !== '\r') index++;
      mask(start, index);
      onComment?.(start, index);
      continue;
    }
    if (char === '/' && next === '*') {
      const start = index;
      index += 2;
      while (index < code.length && !(code[index] === '*' && code[index + 1] === '/')) index++;
      index = Math.min(code.length, index + 2);
      mask(start, index);
      onComment?.(start, index);
      continue;
    }
    const controlKeyword = pendingControlParen;
    pendingControlParen = undefined;
    if (char === '`') {
      templateStart = index++;
      continue;
    }
    if (char === '"' || char === "'") {
      const quote = char;
      const start = index++;
      while (index < code.length) {
        if (code[index] === '\\') {
          index += 2;
          continue;
        }
        if (code[index] === quote) {
          index++;
          break;
        }
        index++;
      }
      mask(start, index);
      canStartRegex = false;
      continue;
    }
    if (char === '/' && canStartRegex && !isJsxClosingTagSlash(code, index)) {
      const start = index;
      let cursor = index + 1;
      let escaped = false;
      let inCharacterClass = false;
      let closed = false;
      for (; cursor < code.length; cursor++) {
        const regexChar = code[cursor];
        if (regexChar === '\n' || regexChar === '\r') break;
        if (escaped) {
          escaped = false;
          continue;
        }
        if (regexChar === '\\') {
          escaped = true;
          continue;
        }
        if (regexChar === '[') {
          inCharacterClass = true;
          continue;
        }
        if (regexChar === ']' && inCharacterClass) {
          inCharacterClass = false;
          continue;
        }
        if (regexChar === '/' && !inCharacterClass) {
          cursor++;
          while (isRegexFlag(code[cursor])) cursor++;
          closed = true;
          break;
        }
      }
      if (closed) {
        mask(start, cursor);
        index = cursor;
        canStartRegex = false;
        continue;
      }
    }
    if (isIdentifierStart(char)) {
      const start = index++;
      while (isIdentifierPart(code[index])) index++;
      const word = code.slice(start, index);
      if (CONTROL_PAREN_KEYWORDS.has(word)) {
        let previous = start - 1;
        while (previous >= 0 && (isWhitespace(code[previous]) || !positions[previous])) previous--;
        // A method named `if`/`while`/etc. still ends an expression when called.
        if (code[previous] !== '.') pendingControlParen = word;
      } else if (word === 'await' && controlKeyword === 'for') {
        pendingControlParen = controlKeyword;
      }
      canStartRegex = REGEX_PREFIX_KEYWORDS.has(word);
      continue;
    }
    if (isAsciiDigit(char.charCodeAt(0))) {
      index++;
      while (isNumberPart(code[index])) index++;
      canStartRegex = false;
      continue;
    }
    if ((char === '+' || char === '-') && next === char) {
      index += 2;
      continue;
    }
    if (char === '!' && next !== '=') {
      index++;
      continue;
    }
    const expression = templateExpressions.at(-1);
    if (expression && char === '{') {
      expression.braceDepth++;
    } else if (expression && char === '}') {
      if (expression.braceDepth === 0) {
        templateStart = expression.start;
        templateExpressions.pop();
        index++;
        continue;
      }
      expression.braceDepth--;
    }
    if (char === '(') {
      controlParens.push(controlKeyword !== undefined);
      canStartRegex = true;
    } else if (char === ')') {
      // A control condition is followed by a statement, which may start with a regex.
      canStartRegex = controlParens.pop() === true;
    } else if (char === ']' || char === '}') {
      canStartRegex = false;
    } else if (char !== '.') {
      canStartRegex = true;
    }
    index++;
  }

  // Keep an unterminated template or interpolation masked through EOF.
  const unfinishedTemplateStart = templateExpressions[0]?.start ?? templateStart;
  if (unfinishedTemplateStart !== undefined) mask(unfinishedTemplateStart, code.length);

  return positions;
}
