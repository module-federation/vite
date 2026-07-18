import type { UserConfig } from 'vite';
import type { NormalizedModuleFederationOptions } from './normalizeModuleFederationOptions';

type RuntimeCapabilityOption = 'disableRemote' | 'disableShared' | 'disableSnapshot';
type DefineConfig = NonNullable<UserConfig['define']>;

const RUNTIME_CAPABILITIES = [
  {
    option: 'disableRemote',
    define: 'FEDERATION_OPTIMIZE_NO_REMOTE',
  },
  {
    option: 'disableShared',
    define: 'FEDERATION_OPTIMIZE_NO_SHARED',
  },
  {
    option: 'disableSnapshot',
    define: 'FEDERATION_OPTIMIZE_NO_SNAPSHOT_PLUGIN',
  },
] as const satisfies ReadonlyArray<{
  option: RuntimeCapabilityOption;
  define: string;
}>;

type RuntimeCapabilityDefineOptions = {
  defaultDisableSnapshot?: boolean;
  onConflict?: (message: string) => void;
};

function isEquivalentBooleanDefine(value: unknown, expected: boolean): boolean {
  return String(value) === JSON.stringify(expected);
}

export function applyRuntimeCapabilityDefines(
  define: DefineConfig,
  options: NormalizedModuleFederationOptions,
  { defaultDisableSnapshot, onConflict }: RuntimeCapabilityDefineOptions = {}
): void {
  for (const capability of RUNTIME_CAPABILITIES) {
    const explicitValue = options[capability.option];
    const desiredValue =
      capability.option === 'disableSnapshot'
        ? (explicitValue ?? defaultDisableSnapshot)
        : explicitValue;

    if (desiredValue === undefined) continue;

    if (!(capability.define in define)) {
      define[capability.define] = JSON.stringify(desiredValue);
      continue;
    }

    if (
      explicitValue !== undefined &&
      !isEquivalentBooleanDefine(define[capability.define], explicitValue)
    ) {
      onConflict?.(
        `${capability.define} define (${define[capability.define]}) differs from ${capability.option} option (${explicitValue}). The existing define will not be overridden.`
      );
    }
  }
}

export function getRuntimeCapabilityConfigurationWarnings(
  options: NormalizedModuleFederationOptions
): string[] {
  const warnings: string[] = [];

  if (options.disableRemote && Object.keys(options.remotes).length > 0) {
    warnings.push(
      'disableRemote is true, but remotes are configured. Remote loading will be unavailable at runtime.'
    );
  }

  if (options.disableShared && Object.keys(options.shared).length > 0) {
    warnings.push(
      'disableShared is true, but shared dependencies are configured. Shared dependency loading will be unavailable at runtime.'
    );
  }

  return warnings;
}
