export interface SharedOptimizerPlanSource {
  entries?: string | readonly string[];
}

export interface SharedOptimizerPlanInput {
  user: SharedOptimizerPlanSource;
  generated?: SharedOptimizerPlanSource;
  defaultEntries: readonly string[];
}

export interface SharedOptimizerPlan {
  entries?: string[];
}

function normalizeEntries(entries: string | readonly string[] | undefined): string[] {
  if (entries === undefined) return [];
  return typeof entries === 'string' ? [entries] : [...entries];
}

function uniqueInOrder(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function createEffectiveEntries(
  userEntries: string | readonly string[] | undefined,
  generatedEntries: string | readonly string[] | undefined,
  defaultEntries: readonly string[]
): string[] | undefined {
  const generated = normalizeEntries(generatedEntries);

  if (userEntries !== undefined) {
    return uniqueInOrder([...normalizeEntries(userEntries), ...generated]);
  }

  if (generated.length === 0) return undefined;

  return uniqueInOrder([...defaultEntries, ...generated]);
}

// include/exclude are left to Vite: since 5.1 its optimizer config hash
// dedupes and sorts them itself.
export function createSharedOptimizerPlan({
  user,
  generated,
  defaultEntries,
}: SharedOptimizerPlanInput): SharedOptimizerPlan {
  const entries = createEffectiveEntries(user.entries, generated?.entries, defaultEntries);

  return entries === undefined ? {} : { entries };
}
