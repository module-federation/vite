import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getPackageDetectionCwd, setPackageDetectionCwd } from '../../utils/packageUtils';
import { isSharedPackageRuntimeDependency } from '../pluginProxySharedModule_preBuild';

describe('isSharedPackageRuntimeDependency', () => {
  let root: string;
  let previousCwd: string;

  function write(relativePath: string, content: string) {
    const file = path.join(root, relativePath);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }

  beforeEach(() => {
    previousCwd = getPackageDetectionCwd();
    root = realpathSync(mkdtempSync(path.join(tmpdir(), 'mf-vite-runtime-dependency-')));
    write('package.json', JSON.stringify({ name: 'app', dependencies: { ui: 'workspace:*' } }));
    // Only subpath exports: the package root cannot be resolved, so it is found
    // through pnpm's node_modules link rather than at its real path.
    write(
      'packages/ui/package.json',
      JSON.stringify({
        name: 'ui',
        exports: { './button': './button.js', './card': './card.js' },
        dependencies: { bridge: 'workspace:*' },
      })
    );
    write('packages/ui/button.js', 'export const button = 1;');
    write('packages/ui/card.js', "export { bridge } from 'bridge';");
    mkdirSync(path.join(root, 'node_modules'));
    symlinkSync('../packages/ui', path.join(root, 'node_modules/ui'), 'dir');
    setPackageDetectionCwd(root);
  });

  afterEach(() => {
    setPackageDetectionCwd(previousCwd);
    rmSync(root, { recursive: true, force: true });
  });

  it('scans the entry of a symlinked workspace package instead of its whole manifest (#1565)', () => {
    // `bridge` is declared by the package but imported only by the card entry.
    expect(isSharedPackageRuntimeDependency('ui/button', 'bridge')).toBe(false);
    expect(isSharedPackageRuntimeDependency('ui/card', 'bridge')).toBe(true);
  });
});
