/**
 * A deeply nested export used to verify that `export * from` re-exports
 * through directories are correctly resolved by the module federation plugin.
 *
 * Resolution path: index.tsx -> helpers/ -> search/ -> filter.ts
 */
export function createFilter<T>(items: T[], predicate: (item: T, query: string) => boolean) {
  return (query: string) => items.filter((item) => predicate(item, query));
}

export function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}
