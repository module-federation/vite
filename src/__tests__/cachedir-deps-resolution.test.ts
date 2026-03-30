import { describe, expect, it, vi, beforeEach } from 'vitest';
import path from 'pathe';

/**
 * Unit tests for the depsDir resolution logic in the
 * module-federation-dev-await-shared-init transform.
 *
 * The transform checks `id.includes(depsDir)` to decide whether to
 * inject top-level awaits for shared module init functions. When a
 * custom cacheDir is configured, the deps directory moves and the
 * hardcoded '.vite/deps/' check would miss these files (#566).
 */

// Simulate the configResolved logic
function resolveDepsDir(cacheDir: string | undefined, root: string): string {
  if (cacheDir) {
    const resolved = path.isAbsolute(cacheDir)
      ? cacheDir
      : path.resolve(root, cacheDir);
    // normalizePath returns forward slashes on all platforms
    return path.join(resolved, 'deps') + '/';
  }
  return path.join(root, 'node_modules', '.vite', 'deps') + '/';
}

describe('depsDir resolution', () => {
  const root = '/project';

  it('uses default path when no cacheDir is set', () => {
    const result = resolveDepsDir(undefined, root);
    expect(result).toBe('/project/node_modules/.vite/deps/');
  });

  it('resolves relative custom cacheDir', () => {
    const result = resolveDepsDir('.vite/_custom_', root);
    expect(result).toBe('/project/.vite/_custom_/deps/');
  });

  it('resolves absolute custom cacheDir', () => {
    const result = resolveDepsDir('/tmp/vite-cache', root);
    expect(result).toBe('/tmp/vite-cache/deps/');
  });

  it('resolves nested relative cacheDir', () => {
    const result = resolveDepsDir('node_modules/.vite/_myapp_static_', root);
    expect(result).toBe('/project/node_modules/.vite/_myapp_static_/deps/');
  });

  it('default path matches typical Vite deps location', () => {
    const result = resolveDepsDir(undefined, '/app');
    const typicalFile = '/app/node_modules/.vite/deps/react.js';
    expect(typicalFile.includes(result)).toBe(true);
  });

  it('custom path matches Vite deps with custom cacheDir', () => {
    const result = resolveDepsDir('node_modules/.cache/vite', '/app');
    const typicalFile = '/app/node_modules/.cache/vite/deps/react.js';
    expect(typicalFile.includes(result)).toBe(true);
  });

  it('custom path does NOT match default deps location', () => {
    const result = resolveDepsDir('.vite/_custom_', '/app');
    const defaultFile = '/app/node_modules/.vite/deps/react.js';
    expect(defaultFile.includes(result)).toBe(false);
  });
});
