import { readFileSync } from 'node:fs';
import { findModuleImportDescriptors, getScannableModuleSource } from './htmlEntryUtils';

interface ResolveContext {
  resolve(source: string, importer?: string): Promise<{ id?: string } | null | undefined>;
}

interface ModuleEdges {
  remotes: string[];
  staticImports: string[];
  dynamicImports: string[];
}

export type RemoteDependencyCache = Map<string, Promise<ModuleEdges>>;

function collectImportSources(code: string): Array<{ source: string; dynamic: boolean }> {
  const sources = new Map<string, boolean>();

  for (const { source, kind, syntax, typeOnly } of findModuleImportDescriptors(code)) {
    if (syntax !== 'import' || typeOnly) continue;
    const dynamic = kind === 'dynamic';
    sources.set(source, (sources.get(source) ?? true) && dynamic);
  }

  return Array.from(sources, ([source, dynamic]) => ({ source, dynamic })).sort((a, b) =>
    a.source.localeCompare(b.source)
  );
}

export function shouldScanResolvedImport(id: string): boolean {
  if (!id || id.includes('\0')) return false;
  if (id.includes('/node_modules/') || id.includes('\\node_modules\\')) return false;
  return /\.(?:[cm]?[jt]sx?|vue|svelte)(?:\?|$)/.test(id);
}

async function readModuleEdges(
  ctx: ResolveContext,
  id: string,
  isRemoteImport: (source: string) => boolean
): Promise<ModuleEdges> {
  let code: string;
  try {
    code = getScannableModuleSource(id, readFileSync(id, 'utf8'));
  } catch {
    return { remotes: [], staticImports: [], dynamicImports: [] };
  }

  const edges: ModuleEdges = { remotes: [], staticImports: [], dynamicImports: [] };
  for (const { source, dynamic } of collectImportSources(code)) {
    if (isRemoteImport(source)) {
      if (!dynamic) edges.remotes.push(source);
      continue;
    }

    // Value-style type imports (`import { JsonValue } from 'type-fest'`) never reach the bundler,
    // and Vite throws for packages without a runtime entry or a missing `exports` subpath. An
    // import that cannot be resolved cannot be a remote.
    let resolved: { id?: string } | null | undefined;
    try {
      resolved = await ctx.resolve(source, id);
    } catch {
      continue;
    }
    if (resolved?.id && shouldScanResolvedImport(resolved.id)) {
      (dynamic ? edges.dynamicImports : edges.staticImports).push(resolved.id);
    }
  }
  return edges;
}

/**
 * Static remote imports in the module graph rooted at `id`: the remotes whose
 * bindings must be ready before the graph is used. `followDynamicImports: false`
 * stops at local `import()` boundaries, which wait for their own remotes.
 */
export async function collectRemoteDependencies(
  ctx: ResolveContext,
  id: string,
  isRemoteImport: (source: string) => boolean,
  { followDynamicImports = true, cache = new Map() as RemoteDependencyCache } = {}
): Promise<string[]> {
  const dependencies = new Set<string>();
  const seen = new Set<string>();
  const pending = [id];

  while (pending.length) {
    const current = pending.pop()!;
    if (seen.has(current) || !shouldScanResolvedImport(current)) continue;
    seen.add(current);

    let edges = cache.get(current);
    if (!edges) {
      edges = readModuleEdges(ctx, current, isRemoteImport);
      cache.set(current, edges);
    }
    const { remotes, staticImports, dynamicImports } = await edges;
    for (const remote of remotes) dependencies.add(remote);
    pending.push(...staticImports);
    if (followDynamicImports) pending.push(...dynamicImports);
  }

  return Array.from(dependencies).sort();
}
