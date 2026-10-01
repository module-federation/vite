import type { ModuleFederationOptions } from './normalizeModuleFederationOptions';

const MF_RUNTIME_ONLY = ['shareStrategy', 'runtimePlugins', 'manifest'] as const;

/** One warning per MF-runtime-only option the user set; import-map mode ignores them. */
export function getImportMapIgnoredOptionWarnings(options: ModuleFederationOptions): string[] {
  const warnings = MF_RUNTIME_ONLY.filter((key) => {
    const value = options[key];
    return Array.isArray(value) ? value.length > 0 : Boolean(value);
  }).map((key) => `experiments.importMap: \`${key}\` is ignored — the MF runtime is not used.`);

  const shared = options.shared && !Array.isArray(options.shared) ? options.shared : {};
  const versioned = Object.entries(shared)
    .filter(
      ([, c]) =>
        typeof c === 'object' && ('eager' in c || 'requiredVersion' in c || c.strictVersion)
    )
    .map(([key]) => key);
  if (versioned.length > 0) {
    warnings.push(
      `experiments.importMap: \`eager\` / \`requiredVersion\` / \`strictVersion\` on ${versioned.join(', ')} ` +
        'is ignored — the host provides the only copy.'
    );
  }
  return warnings;
}
