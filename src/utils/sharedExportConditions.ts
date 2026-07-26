const DEFAULT_CLIENT_EXPORT_CONDITIONS = ['browser', 'import', 'module', 'default'];
const DEFAULT_NODE_SSR_EXPORT_CONDITIONS = ['node', 'import', 'module', 'default'];
const DEFAULT_WEBWORKER_SSR_EXPORT_CONDITIONS = [
  'worker',
  'browser',
  'import',
  'module',
  'default',
];

type SharedExportConditionOptions = {
  environmentConditions?: readonly string[];
  isSsr: boolean;
  rootConditions?: readonly string[];
  ssrConditions?: readonly string[];
  ssrTarget?: 'node' | 'webworker';
};

function appendConditions(
  conditions: readonly string[],
  fallbackConditions: readonly string[]
): string[] {
  return [...new Set([...conditions, ...fallbackConditions])];
}

export function getSharedExportConditions({
  environmentConditions,
  isSsr,
  rootConditions,
  ssrConditions,
  ssrTarget = 'node',
}: SharedExportConditionOptions): string[] {
  if (environmentConditions !== undefined) {
    return appendConditions(environmentConditions, ['import', 'default']);
  }

  const defaultConditions = isSsr
    ? ssrTarget === 'webworker'
      ? DEFAULT_WEBWORKER_SSR_EXPORT_CONDITIONS
      : DEFAULT_NODE_SSR_EXPORT_CONDITIONS
    : DEFAULT_CLIENT_EXPORT_CONDITIONS;
  const configuredConditions = isSsr ? (ssrConditions ?? rootConditions) : rootConditions;

  if (configuredConditions !== undefined) {
    return appendConditions(configuredConditions, defaultConditions);
  }
  return [...defaultConditions];
}
