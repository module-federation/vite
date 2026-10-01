import type { ModuleFederationOptions } from './normalizeModuleFederationOptions';

/**
 * Options that only drive the Module Federation runtime and have no effect in import-map
 * mode. Returns one human-readable warning per option the user actually set, so silently
 * ignored config doesn't look like it works.
 */
export function getImportMapIgnoredOptionWarnings(options: ModuleFederationOptions): string[] {
  const warnings: string[] = [];
  const ignored = (what: string, why: string) =>
    warnings.push(`experiments.importMap: ${what} is ignored — ${why}.`);

  if (options.shareStrategy)
    ignored('`shareStrategy`', 'shared dependencies come from the import map');
  if (options.runtimePlugins?.length) ignored('`runtimePlugins`', 'the MF runtime is not used');
  if (options.manifest) ignored('`manifest`', 'remotes emit importmap-manifest.json instead');

  const shared = options.shared && !Array.isArray(options.shared) ? options.shared : {};
  const versioned = Object.entries(shared)
    .filter(([, config]) => typeof config === 'object' && config !== null)
    .filter(([, config]) => {
      const share = config as {
        eager?: boolean;
        requiredVersion?: unknown;
        strictVersion?: boolean;
      };
      return (
        share.eager !== undefined || share.requiredVersion !== undefined || share.strictVersion
      );
    })
    .map(([key]) => key);
  if (versioned.length > 0) {
    ignored(
      `\`eager\` / \`requiredVersion\` / \`strictVersion\` on ${versioned.join(', ')}`,
      'there is no version negotiation; the host provides the only copy'
    );
  }
  return warnings;
}
