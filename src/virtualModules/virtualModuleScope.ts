import { createHash } from 'node:crypto';
import { MF_OWNER_INFIX } from '../utils/VirtualModule';
import type { NormalizedModuleFederationOptions } from '../utils/normalizeModuleFederationOptions';

export function getVirtualModuleScopeKey(
  options: Pick<NormalizedModuleFederationOptions, 'internalName' | 'filename'>
): string {
  return `${options.internalName}__${options.filename}`.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function compareConfigValues(a: unknown, b: unknown): number {
  const serializedA = JSON.stringify(a);
  const serializedB = JSON.stringify(b);
  return serializedA < serializedB ? -1 : serializedA > serializedB ? 1 : 0;
}

function stableConfigValue(value: unknown, ancestors = new WeakSet<object>()): unknown {
  if (typeof value === 'function') return value.toString();
  if (!value || typeof value !== 'object') return value;
  if (value instanceof Date) return { type: 'Date', value: value.toISOString() };
  if (value instanceof RegExp) return { type: 'RegExp', source: value.source, flags: value.flags };
  if (ancestors.has(value)) return '__circular__';
  ancestors.add(value);
  let result: unknown;
  if (value instanceof Map) {
    const entries = [...value.entries()].map(([key, item]) => [
      stableConfigValue(key, ancestors),
      stableConfigValue(item, ancestors),
    ]);
    entries.sort(compareConfigValues);
    result = { type: 'Map', entries };
  } else if (value instanceof Set) {
    const values = [...value].map((item) => stableConfigValue(item, ancestors));
    values.sort(compareConfigValues);
    result = { type: 'Set', values };
  } else {
    result = Array.isArray(value)
      ? value.map((item) => stableConfigValue(item, ancestors))
      : Object.fromEntries(
          Object.entries(value)
            .filter(([key]) => key !== 'implementation')
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([key, item]) => [key, stableConfigValue(item, ancestors)])
        );
  }
  ancestors.delete(value);
  return result;
}

function hashConfig(value: unknown): bigint {
  const identity = JSON.stringify(stableConfigValue(value));
  return BigInt(`0x${createHash('sha256').update(identity).digest('hex').slice(0, 12)}`);
}

// The `filename` of the first instance in this process that got each owner id.
const ownerIdFilenames = new Map<bigint, string | undefined>();

export function getFederationScopeKey(
  options: Pick<NormalizedModuleFederationOptions, 'internalName'> &
    Partial<NormalizedModuleFederationOptions>
): string {
  // `filename` often changes on every build (`remoteEntry.<hash>.js`), so it only enters the
  // key when it is the one thing that tells two instances in this process apart.
  const { filename, ...identity } = options;
  let ownerId = hashConfig(identity);
  if (!ownerIdFilenames.has(ownerId)) ownerIdFilenames.set(ownerId, filename);
  else if (ownerIdFilenames.get(ownerId) !== filename) ownerId = hashConfig(options);
  return `${options.internalName}${MF_OWNER_INFIX}${ownerId}`;
}
