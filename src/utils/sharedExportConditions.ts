const DEFAULT_CLIENT_EXPORT_CONDITIONS = ['browser', 'import', 'module', 'default'];
const DEFAULT_NODE_SSR_EXPORT_CONDITIONS = ['node', 'import', 'module', 'default'];
const DEFAULT_WEBWORKER_SSR_EXPORT_CONDITIONS = [
  'worker',
  'browser',
  'import',
  'module',
  'default',
];
// Vite expands this sentinel immediately before package resolution. Shared
// export scanning uses its own resolver, so normalize it at this boundary.
const VITE_DEV_PROD_CONDITION = 'development|production';

type SharedExportConditionOptions = {
  environmentConditions?: readonly string[];
  isProduction: boolean;
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

function resolveViteModeCondition(conditions: readonly string[], isProduction: boolean): string[] {
  const modeCondition = isProduction ? 'production' : 'development';
  return [
    ...new Set(
      conditions.map((condition) =>
        condition === VITE_DEV_PROD_CONDITION ? modeCondition : condition
      )
    ),
  ];
}

export function getSharedExportConditions({
  environmentConditions,
  isProduction,
  isSsr,
  rootConditions,
  ssrConditions,
  ssrTarget = 'node',
}: SharedExportConditionOptions): string[] {
  if (environmentConditions !== undefined) {
    return resolveViteModeCondition(
      appendConditions(environmentConditions, ['import', 'default']),
      isProduction
    );
  }

  const defaultConditions = isSsr
    ? ssrTarget === 'webworker'
      ? DEFAULT_WEBWORKER_SSR_EXPORT_CONDITIONS
      : DEFAULT_NODE_SSR_EXPORT_CONDITIONS
    : DEFAULT_CLIENT_EXPORT_CONDITIONS;
  const configuredConditions = isSsr ? (ssrConditions ?? rootConditions) : rootConditions;

  if (configuredConditions !== undefined) {
    return resolveViteModeCondition(
      appendConditions(configuredConditions, defaultConditions),
      isProduction
    );
  }
  return [...defaultConditions];
}

// The `react-server` resolve condition marks environments whose React build
// has no state hooks. The share-cache bucket selection and the flavor guard
// both key off this single predicate so they can never disagree.
export function isReactServerConditions(conditions?: readonly string[]): boolean {
  return Boolean(conditions?.includes('react-server'));
}
