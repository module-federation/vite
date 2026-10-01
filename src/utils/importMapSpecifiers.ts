/** File a remote emits next to its entries, read by the host to build its import map. */
export const IMPORT_MAP_MANIFEST_FILE = 'importmap-manifest.json';

/** Contract between an import-map remote and its host. */
export interface ImportMapManifest {
  name: string;
  mode: 'importmap';
  /** Public URL prefix the remote's files are served from. */
  publicPath: string;
  /** Expose key → emitted entry file, e.g. `{ "./Button": "Button.js" }`. */
  exposes: Record<string, string>;
}

/**
 * Pure naming helpers shared by the import-map host and remote plugins.
 *
 * The contract between a host and a remote in import-map mode is just names:
 * - a remote expose `./Button` is emitted as the fixed-name entry `Button.js`;
 * - the host maps the bare specifier `<remoteName>/Button` to that file's URL;
 * - every shared key (e.g. `react`, `@scope/lib/sub`) is left as a bare import
 *   by remotes and resolved by the host's import map.
 */

/** `./a/b` → `a/b`, `.` → `index` (an expose key mapped to its fixed entry name, without `.js`). */
export function exposeEntryName(exposeKey: string): string {
  if (exposeKey === '.' || exposeKey === './') return 'index';
  return exposeKey.replace(/^\.\//, '');
}

/** Bare specifier the host uses for a remote expose: `remote` for `.`, `remote/sub` otherwise. */
export function remoteSpecifier(remoteName: string, exposeKey: string): string {
  const entry = exposeEntryName(exposeKey);
  return entry === 'index' ? remoteName : `${remoteName}/${entry}`;
}

/**
 * The shared key that owns `id`: an exact match, or the longest key that `id` is a
 * subpath of (`lodash-es/debounce` → `lodash-es`). Returns `undefined` when no key
 * owns it. Used to detect imports of an unshared subpath of a shared package.
 */
export function sharedKeyOwning(id: string, sharedKeys: readonly string[]): string | undefined {
  let owner: string | undefined;
  for (const key of sharedKeys) {
    if (id !== key && !id.startsWith(`${key}/`)) continue;
    if (!owner || key.length > owner.length) owner = key;
  }
  return owner;
}

/** Filesystem-safe chunk name for a shared key: `@scope/lib/sub` → `scope-lib-sub`. */
export function sharedChunkName(sharedKey: string): string {
  return sharedKey.replace(/^@/, '').replace(/[^\w-]+/g, '-');
}
