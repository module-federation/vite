import { resolve } from 'path';
import { describe, expect, it } from 'vitest';
import type { ModuleFederationOptions } from '../src/utils/normalizeModuleFederationOptions';
import { buildFixture, FIXTURES } from './helpers/build';
import { parseManifest } from './helpers/matchers';

const CSS_BASE_MF_OPTIONS = {
  name: 'cssRemote',
  filename: 'remoteEntry.js',
  exposes: {
    './widget': resolve(FIXTURES, 'css-remote', 'exposed-module.js'),
  },
  manifest: true,
  dts: false,
} satisfies Partial<ModuleFederationOptions>;

interface ManifestExpose {
  id: string;
  name: string;
  path: string;
  assets: {
    js: { sync: string[]; async: string[] };
    css: { sync: string[]; async: string[] };
  };
}

describe('css manifest', () => {
  it('tracks CSS and JS assets under the correct expose', async () => {
    const output = await buildFixture({
      fixture: 'css-remote',
      mfOptions: CSS_BASE_MF_OPTIONS,
    });
    const manifest = parseManifest(output) as Record<string, unknown>;
    expect(manifest).toBeDefined();
    expect(manifest).toHaveProperty('exposes');

    const exposes = manifest.exposes as ManifestExpose[];
    const widget = exposes.find((e) => e.name === 'widget');
    expect(widget).toBeDefined();

    const allCssFiles = [...widget!.assets.css.sync, ...widget!.assets.css.async];
    expect(allCssFiles.length).toBeGreaterThanOrEqual(1);
    for (const file of allCssFiles) {
      expect(file).toMatch(/\.css$/);
    }

    const allJsFiles = [...widget!.assets.js.sync, ...widget!.assets.js.async];
    expect(allJsFiles.length).toBeGreaterThanOrEqual(1);
    for (const file of allJsFiles) {
      expect(file).toMatch(/\.js$/);
    }
  });

  it('adds CSS to all exposes when bundleAllCSS is enabled', async () => {
    const output = await buildFixture({
      fixture: 'css-remote',
      mfOptions: { ...CSS_BASE_MF_OPTIONS, bundleAllCSS: true },
    });
    const manifest = parseManifest(output) as Record<string, unknown>;
    expect(manifest).toBeDefined();

    const exposes = manifest.exposes as ManifestExpose[];
    expect(exposes.length).toBeGreaterThanOrEqual(1);

    for (const expose of exposes) {
      const cssCount = expose.assets.css.sync.length + expose.assets.css.async.length;
      expect(
        cssCount,
        `expose "${expose.name}" should have at least one CSS asset`
      ).toBeGreaterThanOrEqual(1);
    }
  });
});
