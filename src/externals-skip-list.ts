export const externalsSkipList = new Set(['tslib']);

export function filterExternals(deps: string[]): string[] {
  return deps.filter((d) => !externalsSkipList.has(d));
}
