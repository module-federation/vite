import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fetchWithTimeout } from './fetchWithTimeout';
import { type ImportMapManifest, remoteSpecifier } from './importMapSpecifiers';
import type { RemoteObjectConfig } from './normalizeModuleFederationOptions';

const isUrl = (location: string) => /^https?:\/\//.test(location);

/** Reads a remote's `importmap-manifest.json` from a URL or a path (relative to `root`). */
export async function readImportMapManifest(
  location: string,
  root: string
): Promise<ImportMapManifest> {
  const source = isUrl(location)
    ? await (await fetchWithTimeout(location)).text()
    : await readFile(path.resolve(root, location), 'utf8');
  const manifest = JSON.parse(source) as Partial<ImportMapManifest>;
  if (manifest.mode !== 'importmap') {
    throw new Error(
      `Remote manifest at ${location} is not an import-map manifest. ` +
        'Build the remote with `experiments: { importMap: true }`.'
    );
  }
  return manifest as ImportMapManifest;
}

/** URL of an expose's entry: the remote's `publicPath`, resolved against a manifest URL. */
export function remoteEntryUrl(
  manifest: ImportMapManifest,
  file: string,
  location: string
): string {
  const base = manifest.publicPath.replace(/\/?$/, '/');
  return isUrl(location) ? new URL(file, new URL(base, location)).href : base + file;
}

/** Import-map entries for every expose of every configured remote. */
export async function collectRemoteImports(
  remotes: Record<string, RemoteObjectConfig>,
  root: string
): Promise<Record<string, string>> {
  const imports: Record<string, string> = {};
  for (const [alias, remote] of Object.entries(remotes)) {
    const manifest = await readImportMapManifest(remote.entry, root);
    for (const [exposeKey, file] of Object.entries(manifest.exposes)) {
      imports[remoteSpecifier(alias, exposeKey)] = remoteEntryUrl(manifest, file, remote.entry);
    }
  }
  return imports;
}
