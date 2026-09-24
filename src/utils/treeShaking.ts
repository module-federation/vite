import { getImportAnalysis } from './importAnalysis';
import type {
  NormalizedModuleFederationOptions,
  NormalizedShared,
  ShareItem,
} from './normalizeModuleFederationOptions';
import { normalizePathForImport } from './buildPaths';
import { getSharedRequest } from './sharedKeyMatcher';

type SharedSourceMatcher = (
  source: string,
  shared: NormalizedShared
) => string | undefined | Promise<string | undefined>;

type TreeShakingExportRecord = {
  requiresFullBundle: boolean;
  usedExports: Set<string>;
};

/**
 * `unknown` means that analysis has not observed this concrete request yet.
 * `full` is deliberately distinct from an empty export list: the module was
 * consumed as a namespace, for side effects, or through another form that
 * cannot safely be represented by a subset of its exports.
 */
export type TreeShakingExportUsage =
  | { kind: 'unknown' }
  | { kind: 'full' }
  | { kind: 'exports'; usedExports: string[] };

export function shouldAnalyzeSharedExports(shareItem?: ShareItem) {
  return !!(
    shareItem &&
    (shareItem.shareConfig.treeShaking || shareItem.shareConfig.import === false)
  );
}

type RecordTreeShakingExports = (
  sharedKey: string,
  exports: readonly string[],
  request?: string
) => void;
type MarkTreeShakingPackageUnsafe = (sharedKey: string, request?: string) => void;

/**
 * Analysis is scoped by both the configured share key and the concrete module
 * request. A prefix share such as `lodash/` may materialize separate wrappers
 * for `lodash/get` and `lodash/debounce`; combining those export sets would
 * generate invalid wrappers and defeat per-subpath tree shaking.
 */
interface TreeShakingState {
  inferredUsage: Map<string, Map<string, TreeShakingExportRecord>>;
  buildMode: boolean;
}

const legacyTreeShakingState: TreeShakingState = {
  inferredUsage: new Map(),
  buildMode: false,
};
const treeShakingStates = new WeakMap<NormalizedModuleFederationOptions, TreeShakingState>();

function getTreeShakingState(options?: NormalizedModuleFederationOptions) {
  if (!options) return legacyTreeShakingState;
  let state = treeShakingStates.get(options);
  if (!state) {
    state = { inferredUsage: new Map(), buildMode: false };
    treeShakingStates.set(options, state);
  }
  return state;
}

export function setTreeShakingBuildMode(
  enabled: boolean,
  options?: NormalizedModuleFederationOptions
) {
  getTreeShakingState(options).buildMode = enabled;
}

export function resetTreeShakingExports(options?: NormalizedModuleFederationOptions) {
  getTreeShakingState(options).inferredUsage.clear();
}

function getOrCreateExportRecord(
  sharedKey: string,
  request: string,
  options?: NormalizedModuleFederationOptions
): TreeShakingExportRecord {
  const inferredUsage = getTreeShakingState(options).inferredUsage;
  let byRequest = inferredUsage.get(sharedKey);
  if (!byRequest) {
    byRequest = new Map();
    inferredUsage.set(sharedKey, byRequest);
  }

  let record = byRequest.get(request);
  if (!record) {
    record = { requiresFullBundle: false, usedExports: new Set<string>() };
    byRequest.set(request, record);
  }
  return record;
}

export function recordTreeShakingExports(
  sharedKey: string,
  exports: readonly string[],
  request = sharedKey,
  options?: NormalizedModuleFederationOptions
) {
  const record = getOrCreateExportRecord(sharedKey, request, options);
  exports.forEach((name) => record.usedExports.add(name));
}

export function markTreeShakingPackageUnsafe(
  sharedKey: string,
  request = sharedKey,
  options?: NormalizedModuleFederationOptions
) {
  getOrCreateExportRecord(sharedKey, request, options).requiresFullBundle = true;
}

function getExportRecords(
  sharedKey: string | undefined,
  request: string,
  options?: NormalizedModuleFederationOptions
) {
  const inferredUsage = getTreeShakingState(options).inferredUsage;
  if (sharedKey) {
    const records = inferredUsage.get(sharedKey);
    const wildcard = records?.get('*');
    const exact = records?.get(request);
    return [wildcard, exact === wildcard ? undefined : exact].filter(
      (record): record is TreeShakingExportRecord => !!record
    );
  }

  const records: TreeShakingExportRecord[] = [];
  inferredUsage.forEach((byRequest, configuredKey) => {
    const wildcard = byRequest.get('*');
    const exact = byRequest.get(request);
    const configuredRequest = getSharedRequest(configuredKey, options?.shared?.[configuredKey]);
    const keyBase = configuredRequest.endsWith('/')
      ? configuredRequest.slice(0, -1)
      : configuredRequest;
    const requestMatchesConfiguredKey = request === keyBase || request.startsWith(`${keyBase}/`);
    if (wildcard && requestMatchesConfiguredKey) records.push(wildcard);
    if (exact && exact !== wildcard) records.push(exact);
  });
  return records;
}

/**
 * Return the analyzed requirement for one concrete shared request.
 *
 * Callers that know the configured share key should pass it explicitly. The
 * fallback lookup across keys keeps aliases/backwards-compatible callers
 * working, while still keeping each concrete request's exports isolated.
 */
export function getSharedExportUsage(
  request: string,
  shareItem?: ShareItem,
  sharedKey?: string,
  options?: NormalizedModuleFederationOptions
): TreeShakingExportUsage | undefined {
  const treeShaking = shareItem?.shareConfig.treeShaking;
  if (!shouldAnalyzeSharedExports(shareItem) || !getTreeShakingState(options).buildMode) {
    return undefined;
  }

  const records = getExportRecords(sharedKey, request, options);
  if (records.some((record) => record.requiresFullBundle)) return { kind: 'full' };

  const configured = treeShaking?.usedExports ?? [];
  const result = new Set(configured);
  records.forEach((record) => record.usedExports.forEach((name) => result.add(name)));

  if (result.size > 0) {
    return { kind: 'exports', usedExports: [...result].sort() };
  }
  return records.length > 0 ? { kind: 'exports', usedExports: [] } : { kind: 'unknown' };
}

export function getTreeShakingExportUsage(
  request: string,
  shareItem?: ShareItem,
  sharedKey?: string,
  options?: NormalizedModuleFederationOptions
): TreeShakingExportUsage | undefined {
  if (!shareItem?.shareConfig.treeShaking) return undefined;
  return getSharedExportUsage(request, shareItem, sharedKey, options);
}

/**
 * Record consumer imports against this instance's sharing configuration.
 * Generated wrappers do not contribute consumer usage. If parsing fails,
 * every share enabled for analysis requires all of its exports.
 */
export async function collectTreeShakingImports(
  code: string,
  id: string,
  shared: NormalizedShared,
  findSharedKey: SharedSourceMatcher,
  record: RecordTreeShakingExports,
  markUnsafe: MarkTreeShakingPackageUnsafe,
  analysis = getImportAnalysis(shared)
): Promise<void> {
  const normalizedId = normalizePathForImport(id);
  if (
    normalizedId.includes('__prebuild__') ||
    normalizedId.includes('__loadShare__') ||
    normalizedId.includes('__mf_tree_shaking_graph__')
  ) {
    return;
  }

  const imports = analysis.analyze(code);
  if (imports === null) {
    Object.entries(shared).forEach(([sharedKey, shareItem]) => {
      if (shouldAnalyzeSharedExports(shareItem)) markUnsafe(sharedKey, '*');
    });
    return;
  }

  const pending: Promise<void>[] = [];
  const withSharedSource = (source: string, use: (key: string) => void) => {
    const apply = (key: string | undefined) => {
      if (key && shouldAnalyzeSharedExports(shared[key])) use(key);
    };
    const key = findSharedKey(source, shared);
    if (key instanceof Promise) pending.push(key.then(apply));
    else apply(key);
  };
  for (const { source, names } of imports) {
    withSharedSource(source, (key) => {
      if (names === null) markUnsafe(key, source);
      else record(key, names, source);
    });
  }
  await Promise.all(pending);
}
