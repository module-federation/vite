import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectRemoteImports, readImportMapManifest, remoteEntryUrl } from '../importMapManifest';
import type { ImportMapManifest } from '../importMapSpecifiers';
import type { RemoteObjectConfig } from '../normalizeModuleFederationOptions';

const manifest = (publicPath: string): ImportMapManifest => ({
  name: 'remote',
  mode: 'importmap',
  publicPath,
  exposes: { '.': 'index.js', './Button': 'Button.js' },
});

function writeManifest(contents: unknown): { root: string; file: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'mf-importmap-'));
  writeFileSync(path.join(root, 'importmap-manifest.json'), JSON.stringify(contents));
  return { root, file: 'importmap-manifest.json' };
}

describe('importMap manifest', () => {
  it('resolves entry URLs from the remote publicPath', () => {
    expect(remoteEntryUrl(manifest('/remote/'), 'Button.js', './dist/m.json')).toBe(
      '/remote/Button.js'
    );
    expect(remoteEntryUrl(manifest('https://cdn.example.com/r'), 'Button.js', './m.json')).toBe(
      'https://cdn.example.com/r/Button.js'
    );
    expect(
      remoteEntryUrl(
        manifest('/r/'),
        'Button.js',
        'https://cdn.example.com/x/importmap-manifest.json'
      )
    ).toBe('https://cdn.example.com/r/Button.js');
  });

  it('rejects a manifest from a non-import-map build', async () => {
    const { root, file } = writeManifest({ name: 'remote', exposes: {} });
    await expect(readImportMapManifest(file, root)).rejects.toThrow(
      /experiments: \{ importMap: true \}/
    );
  });

  it('maps every remote expose to its entry URL', async () => {
    const { root, file } = writeManifest(manifest('/remote/'));
    const remotes = {
      remote: { name: 'remote', entry: file } as RemoteObjectConfig,
    };
    expect(await collectRemoteImports(remotes, root)).toEqual({
      remote: '/remote/index.js',
      'remote/Button': '/remote/Button.js',
    });
  });
});
