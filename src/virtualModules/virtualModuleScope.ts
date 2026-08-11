import type { NormalizedModuleFederationOptions } from '../utils/normalizeModuleFederationOptions';

export function getVirtualModuleScopeKey(
  options: Pick<NormalizedModuleFederationOptions, 'internalName' | 'filename'>
): string {
  return `${options.internalName}__${options.filename}`.replace(/[^a-zA-Z0-9_-]/g, '_');
}
