import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createEsbuildReactMixedModeGuard,
  createRolldownReactMixedModeGuard,
  patchReactDevelopmentRuntime,
} from '../pluginReactMixedModeGuard';

const unsafe = 'return null === dispatcher ? null : dispatcher.getOwner();';

describe('React mixed-mode guard', () => {
  it.each([
    'react.development.js',
    'react-jsx-runtime.development.js',
    'react-jsx-dev-runtime.development.js',
  ])('guards %s', (filename) => {
    const id = `/repo/node_modules/react/cjs/${filename}`;
    const result = patchReactDevelopmentRuntime(unsafe, id);

    expect(result).toContain('typeof dispatcher?.getOwner === "function"');
    expect(result).not.toContain(unsafe);
  });

  it('ignores production and non-React modules', () => {
    expect(
      patchReactDevelopmentRuntime(
        unsafe,
        '/repo/node_modules/react/cjs/react-jsx-runtime.production.js'
      )
    ).toBeUndefined();
    expect(
      patchReactDevelopmentRuntime(unsafe, '/repo/node_modules/other/cjs/react.development.js')
    ).toBeUndefined();
  });

  it('exposes the guard as a Rolldown transform', () => {
    const plugin = createRolldownReactMixedModeGuard();
    const result = plugin.transform(
      unsafe,
      '/repo/node_modules/react/cjs/react-jsx-runtime.development.js'
    );

    expect(result).toContain('typeof dispatcher?.getOwner === "function"');
  });

  it('exposes the guard as an esbuild onLoad hook', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'mf-react-guard-'));
    const reactCjs = path.join(root, 'node_modules/react/cjs');
    const runtime = path.join(reactCjs, 'react-jsx-runtime.development.js');
    mkdirSync(reactCjs, { recursive: true });
    writeFileSync(runtime, unsafe);

    try {
      let onLoad: ((args: { path: string }) => any) | undefined;
      createEsbuildReactMixedModeGuard().setup({
        onLoad(_options: unknown, handler: typeof onLoad) {
          onLoad = handler;
        },
      });

      expect(onLoad).toBeDefined();
      const result = onLoad?.({ path: runtime });
      expect(result?.contents).toContain('typeof dispatcher?.getOwner === "function"');
      expect(result?.loader).toBe('js');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
