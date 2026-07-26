type TypeArgumentScanState = {
  angleDepth: number;
  groupDepth: number;
  sawTypeComma: boolean;
};

type TypeArgumentScanAction = 'handled' | 'invalid' | 'closed' | undefined;

function getTypeArgumentStartContext(
  source: string,
  start: number
): { followsNamedExpression: boolean } | undefined {
  let previous = start - 1;
  while (previous >= 0 && /\s/.test(source[previous])) previous--;
  const previousChar = source[previous] || '';
  const followsNamedExpression = /[$_\u200C\u200D\p{ID_Continue})\]>]/u.test(previousChar);
  const startsStandaloneGeneric = previousChar !== '' && '=([{,:'.includes(previousChar);
  if (!followsNamedExpression && !startsStandaloneGeneric) return undefined;

  return { followsNamedExpression };
}

function updateTypeArgumentGroupDepth(
  char: string,
  state: TypeArgumentScanState
): TypeArgumentScanAction {
  if (char === '(' || char === '[' || char === '{') {
    state.groupDepth++;
    return 'handled';
  }
  if (char !== ')' && char !== ']' && char !== '}') return undefined;
  if (state.groupDepth === 0) return 'invalid';

  state.groupDepth--;
  return 'handled';
}

function updateTypeArgumentAngleDepth(
  source: string,
  index: number,
  state: TypeArgumentScanState
): TypeArgumentScanAction {
  const char = source[index];
  if (char === '<') {
    if (source[index + 1] === '=' || source[index + 1] === '<') return 'invalid';
    state.angleDepth++;
    return 'handled';
  }
  if (char !== '>') return undefined;
  if (source[index - 1] === '=' || source[index + 1] === '=') return 'handled';

  state.angleDepth--;
  return state.angleDepth === 0 ? 'closed' : 'handled';
}

function hasLikelyTypeArgumentFollower(
  source: string,
  end: number,
  codePositions: boolean[]
): boolean {
  let next = end + 1;
  while (next < source.length && (!codePositions[next] || /\s/.test(source[next]))) next++;
  if (next >= source.length || /[([.!?=;,)\]}:|&]/.test(source[next])) return true;

  const followingToken = source
    .slice(next)
    .match(/^[$_\p{ID_Start}][$_\u200C\u200D\p{ID_Continue}]*/u)?.[0];
  return followingToken === 'as' || followingToken === 'satisfies';
}

function isInvalidTypeArgumentTerminator(
  source: string,
  index: number,
  followsNamedExpression: boolean
): boolean {
  const char = source[index];
  return char === ';' || (char === '=' && source[index + 1] !== '>' && followsNamedExpression);
}

/**
 * Finds the end of a balanced, type-like angle-bracket range that contains a
 * comma. Ambiguous syntax returns `undefined` so callers can fail closed.
 */
export function findLikelyTypeArgumentEnd(
  source: string,
  start: number,
  codePositions: boolean[]
): number | undefined {
  const context = getTypeArgumentStartContext(source, start);
  if (!context) return undefined;

  const state: TypeArgumentScanState = {
    angleDepth: 1,
    groupDepth: 0,
    sawTypeComma: false,
  };

  for (let index = start + 1; index < source.length; index++) {
    if (!codePositions[index]) continue;
    const char = source[index];

    const groupAction = updateTypeArgumentGroupDepth(char, state);
    if (groupAction === 'invalid') return undefined;
    if (groupAction === 'handled') continue;

    const angleAction = updateTypeArgumentAngleDepth(source, index, state);
    if (angleAction === 'invalid') return undefined;
    if (angleAction === 'closed') {
      return state.sawTypeComma && hasLikelyTypeArgumentFollower(source, index, codePositions)
        ? index
        : undefined;
    }
    if (angleAction === 'handled') continue;

    if (char === ',' && state.groupDepth === 0) {
      state.sawTypeComma = true;
      continue;
    }
    if (
      state.angleDepth === 1 &&
      state.groupDepth === 0 &&
      isInvalidTypeArgumentTerminator(source, index, context.followsNamedExpression)
    ) {
      return undefined;
    }
  }

  return undefined;
}
