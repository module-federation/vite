import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseAst } from 'rollup/parseAst';

const mockGetIsRolldown = vi.fn(() => true);
vi.mock('../../utils/packageUtils', () => ({
  getIsRolldown: (...args: any[]) => mockGetIsRolldown(...args),
}));

import { pluginRemoteNamedExports } from '../pluginRemoteNamedExports';

const OPTIONS = {
  remotes: {
    remoteApp: { external: ['remoteApp'], shareScope: 'default' },
    otherRemote: { external: ['otherRemote'], shareScope: 'default' },
  },
} as any;

function createContext(parseError = false) {
  return {
    meta: { rolldownVersion: '1.0.0' },
    parse(code: string) {
      if (parseError) throw new Error('Parse error');
      return parseAst(code);
    },
  };
}

async function transform(
  code: string,
  id = '/src/app.js',
  parseError = false,
  options = OPTIONS,
  command: 'serve' | 'build' = 'serve'
) {
  const plugin = pluginRemoteNamedExports(options);
  // Invoke the config hook to set the command (applyShared depends on it)
  if ((plugin as any).config) {
    (plugin as any).config({}, { command });
  }
  const ctx = createContext(parseError);
  const result = await (plugin as any).transform.call(ctx, code, id);
  return result?.code as string | undefined;
}

describe('pluginRemoteNamedExports', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── bail-out conditions ──────────────────────────────────────

  describe('bail-out', () => {
    it('skips when no remotes configured', async () => {
      const result = await transform(
        'import { foo } from "remoteApp/utils"',
        '/src/app.js',
        false,
        { remotes: {} } as any
      );
      expect(result).toBeUndefined();
    });

    it('skips non-JS files', async () => {
      const result = await transform('import { foo } from "remoteApp/utils"', '/src/styles.css');
      expect(result).toBeUndefined();
    });

    it('skips files that do not mention any remote', async () => {
      const result = await transform('import { foo } from "lodash"', '/src/app.js');
      expect(result).toBeUndefined();
    });

    it('skips federation internal modules (__loadRemote__)', async () => {
      const result = await transform(
        'import { foo } from "remoteApp/utils"',
        '/virtual/__loadRemote__remoteApp.js'
      );
      expect(result).toBeUndefined();
    });

    it('skips federation internal modules (__loadShare__)', async () => {
      const result = await transform(
        'import { foo } from "remoteApp/utils"',
        '/virtual/__loadShare__react.js'
      );
      expect(result).toBeUndefined();
    });
  });

  // ── static named imports (AST path) ─────────────────────────

  describe('static named imports', () => {
    it('rewrites named import', async () => {
      const result = await transform('import { foo } from "remoteApp/utils";');
      expect(result).toContain('import { __moduleExports as');
      expect(result).toContain('const { foo }');
      expect(result).not.toContain('import { foo }');
    });

    it('rewrites multiple named imports', async () => {
      const result = await transform('import { foo, bar, baz } from "remoteApp/utils";');
      expect(result).toContain('__moduleExports');
      expect(result).toContain('const { foo, bar, baz }');
    });

    it('rewrites aliased import', async () => {
      const result = await transform('import { foo as myFoo } from "remoteApp/utils";');
      expect(result).toContain('__moduleExports');
      expect(result).toContain('foo: myFoo');
    });

    it('rewrites default + named imports', async () => {
      const result = await transform('import Default, { foo } from "remoteApp/utils";');
      expect(result).toContain('default as Default');
      expect(result).toContain('__moduleExports');
      expect(result).toContain('const { foo }');
    });

    it('skips default-only import', async () => {
      const result = await transform('import Default from "remoteApp/utils";');
      expect(result).toBeUndefined();
    });

    it('does not touch non-remote imports', async () => {
      const code = ['import { foo } from "remoteApp/utils";', 'import { bar } from "lodash";'].join(
        '\n'
      );
      const result = await transform(code);
      expect(result).toContain('__moduleExports');
      expect(result).toContain('import { bar } from "lodash"');
    });

    it('handles bare remote name (no subpath)', async () => {
      const result = await transform('import { foo } from "remoteApp";');
      expect(result).toContain('__moduleExports');
      expect(result).toContain('const { foo }');
    });

    it('handles multiple remotes in one file', async () => {
      const code = [
        'import { foo } from "remoteApp/utils";',
        'import { bar } from "otherRemote/helpers";',
      ].join('\n');
      const result = await transform(code);
      expect(result).toContain('const { foo }');
      expect(result).toContain('const { bar }');
    });
  });

  // ── namespace imports ────────────────────────────────────────

  describe('namespace imports', () => {
    it('rewrites namespace import', async () => {
      const result = await transform('import * as utils from "remoteApp/utils";');
      expect(result).toContain('import { __moduleExports as utils }');
      expect(result).not.toContain('import *');
    });
  });

  // ── dynamic imports ──────────────────────────────────────────

  describe('dynamic imports', () => {
    it('wraps dynamic import with .then()', async () => {
      const result = await transform('const m = import("remoteApp/utils");');
      expect(result).toContain('.then(function(__mf_m__)');
      expect(result).toContain('__moduleExports');
    });

    it('wraps tagged remote imports after Vite rewrites the source id', async () => {
      const result = await transform(
        'const m = import("/virtual/remoteApp__loadRemote__utils.js");'
      );
      expect(result).toContain('.then(function(__mf_m__)');
      expect(result).toContain('__moduleExports');
    });

    it('does not wrap non-remote dynamic import', async () => {
      // "remoteApp" is mentioned in a comment, but the import is for lodash
      const code = '// uses remoteApp\nconst m = import("lodash");';
      const result = await transform(code);
      expect(result).toBeUndefined();
    });

    it('gracefully returns module if __moduleExports missing', async () => {
      const result = await transform('const m = import("remoteApp/utils");');
      expect(result).toContain('if (!__mf_m__ || !__mf_m__.__moduleExports) return __mf_m__');
    });
  });

  // ── re-exports ───────────────────────────────────────────────

  describe('re-exports', () => {
    it('rewrites named re-export', async () => {
      const result = await transform('export { foo } from "remoteApp/utils";');
      expect(result).toContain('import { __moduleExports as');
      expect(result).toContain('__mf_re_');
      expect(result).toContain('as foo');
    });

    it('rewrites aliased re-export', async () => {
      const result = await transform('export { foo as myFoo } from "remoteApp/utils";');
      expect(result).toContain('as myFoo');
    });

    it('warns on export * from remote', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const result = await transform('export * from "remoteApp/utils";');
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('export * from'));
      expect(result).toBeUndefined();
      warnSpy.mockRestore();
    });
  });

  // ── es-module-lexer fallback (TypeScript files) ──────────────

  describe('es-module-lexer fallback', () => {
    // parseError=true forces the catch path → esLexerFallbackTransform

    it('rewrites named import via fallback', async () => {
      const result = await transform(
        'import { foo } from "remoteApp/utils";',
        '/src/app.tsx',
        true
      );
      expect(result).toContain('__moduleExports');
      expect(result).toContain('const { foo }');
    });

    it('rewrites namespace import via fallback', async () => {
      const result = await transform(
        'import * as utils from "remoteApp/utils";',
        '/src/app.tsx',
        true
      );
      expect(result).toContain('import { __moduleExports as utils }');
    });

    it('rewrites default + named import via fallback', async () => {
      const result = await transform(
        'import Default, { foo } from "remoteApp/utils";',
        '/src/app.tsx',
        true
      );
      expect(result).toContain('default as Default');
      expect(result).toContain('const { foo }');
    });

    it('wraps dynamic import via fallback', async () => {
      const result = await transform('const m = import("remoteApp/utils");', '/src/app.tsx', true);
      expect(result).toContain('.then(function(__mf_m__)');
    });

    it('rewrites re-export via fallback', async () => {
      const result = await transform(
        'export { foo } from "remoteApp/utils";',
        '/src/app.tsx',
        true
      );
      expect(result).toContain('import { __moduleExports as');
      expect(result).toContain('__mf_re_');
    });

    it('skips type-only imports via fallback', async () => {
      const result = await transform(
        'import type { Foo } from "remoteApp/utils";',
        '/src/app.tsx',
        true
      );
      expect(result).toBeUndefined();
    });

    it('skips default-only import via fallback', async () => {
      const result = await transform(
        'import Default from "remoteApp/utils";',
        '/src/app.tsx',
        true
      );
      expect(result).toBeUndefined();
    });

    it('warns on export * via fallback', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await transform('export * from "remoteApp/utils";', '/src/app.tsx', true);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('export * from'));
      warnSpy.mockRestore();
    });

    it('handles unparseable content gracefully (e.g. vue SFC)', async () => {
      const vueSfc = [
        '<template><div>{{ msg }}</div></template>',
        '<script setup>',
        'import { foo } from "remoteApp/utils";',
        '</script>',
      ].join('\n');
      const result = await transform(vueSfc, '/src/App.vue', true);
      expect(result).toBeUndefined();
    });

    it('handles aliased import via fallback', async () => {
      const result = await transform(
        'import { foo as myFoo } from "remoteApp/utils";',
        '/src/app.tsx',
        true
      );
      expect(result).toContain('foo: myFoo');
    });

    it('handles aliased re-export via fallback', async () => {
      const result = await transform(
        'export { foo as myFoo } from "remoteApp/utils";',
        '/src/app.tsx',
        true
      );
      expect(result).toContain('as myFoo');
    });

    it('rewrites namespace import in raw JSX via regex fallback', async () => {
      const result = await transform(
        [
          'import * as routesRemote from "remoteApp/routes";',
          '',
          'export function App() {',
          '  return <div>{routesRemote.foo}</div>;',
          '}',
        ].join('\n'),
        '/src/app.jsx',
        true
      );
      expect(result).toContain('import { __moduleExports as routesRemote }');
      expect(result).not.toContain('import * as routesRemote');
    });
  });

  // ── file extension matching ──────────────────────────────────

  describe('file extensions', () => {
    for (const ext of ['.js', '.ts', '.tsx', '.jsx', '.mjs', '.cjs', '.mts', '.vue', '.svelte']) {
      it(`processes ${ext} files`, async () => {
        const needsFallback = ext === '.vue' || ext === '.svelte';
        const result = await transform(
          'import { foo } from "remoteApp/utils";',
          `/src/app${ext}`,
          needsFallback
        );
        expect(result).toContain('__moduleExports');
      });
    }

    it('skips .css files', async () => {
      const result = await transform('.remoteApp { color: red }', '/src/styles.css');
      expect(result).toBeUndefined();
    });

    it('skips .json files', async () => {
      const result = await transform('{"remoteApp": true}', '/src/config.json');
      expect(result).toBeUndefined();
    });
  });

  // ── shared module imports (Rolldown lacks syntheticNamedExports) ──

  describe('shared module imports', () => {
    // Shared rewriting only applies in build mode
    async function transformBuild(
      code: string,
      id = '/src/app.js',
      parseError = false,
      options = SHARED_OPTIONS as any
    ) {
      return transform(code, id, parseError, options, 'build');
    }

    const SHARED_OPTIONS = {
      remotes: {
        remoteApp: { external: ['remoteApp'], shareScope: 'default' },
      },
      shared: {
        react: { singleton: true },
        '@acme/ui': { singleton: true },
        '@mui/material': { singleton: true },
        '@mui/x-date-pickers-pro/AdapterLuxon': { singleton: true },
      },
    } as any;

    it('rewrites named import from shared package', async () => {
      const result = await transformBuild('import { useState } from "react";');
      expect(result).toContain('import { __moduleExports as');
      expect(result).toContain('const { useState }');
      expect(result).not.toContain('import { useState }');
    });

    it('rewrites named import from scoped shared package', async () => {
      const result = await transformBuild('import { Button } from "@acme/ui";');
      expect(result).toContain('__moduleExports');
      expect(result).toContain('const { Button }');
    });

    it('does not rewrite deep imports of shared packages', async () => {
      const result = await transformBuild('import IconButton from "@mui/material/IconButton";');
      // Default-only import → skip. But more importantly, deep imports
      // should not be matched as shared (only exact package names).
      expect(result).toBeUndefined();
    });

    it('rewrites shared package with subpath when explicitly listed', async () => {
      const result = await transformBuild(
        'import { AdapterLuxon } from "@mui/x-date-pickers-pro/AdapterLuxon";'
      );
      expect(result).toContain('__moduleExports');
      expect(result).toContain('const { AdapterLuxon }');
    });

    it('rewrites multiple named imports from shared package', async () => {
      const result = await transformBuild('import { useState, useEffect, useRef } from "react";');
      expect(result).toContain('__moduleExports');
      expect(result).toContain('const { useState, useEffect, useRef }');
    });

    it('skips default-only import from shared package', async () => {
      const result = await transformBuild('import React from "react";');
      expect(result).toBeUndefined();
    });

    it('rewrites default + named import from shared package', async () => {
      const result = await transformBuild('import React, { useState } from "react";');
      expect(result).toContain('default as React');
      expect(result).toContain('__moduleExports');
      expect(result).toContain('const { useState }');
    });

    it('rewrites namespace import from shared package', async () => {
      const result = await transformBuild('import * as React from "react";');
      expect(result).toContain('import { __moduleExports as React }');
      expect(result).not.toContain('import *');
    });

    it('wraps dynamic import of shared package', async () => {
      const result = await transformBuild('const React = import("react");');
      expect(result).toContain('.then(function(__mf_m__)');
      expect(result).toContain('__moduleExports');
    });

    it('rewrites re-export from shared package', async () => {
      const result = await transformBuild('export { useState } from "react";');
      expect(result).toContain('import { __moduleExports as');
      expect(result).toContain('__mf_re_');
      expect(result).toContain('as useState');
    });

    it('handles mixed remote and shared imports in one file', async () => {
      const code = [
        'import { foo } from "remoteApp/utils";',
        'import { useState } from "react";',
      ].join('\n');
      const result = await transformBuild(code);
      expect(result).toContain('const { foo }');
      expect(result).toContain('const { useState }');
    });

    it('still works when only shared packages are configured (no remotes)', async () => {
      const sharedOnlyOptions = {
        remotes: {},
        shared: {
          react: { singleton: true },
        },
      } as any;
      const result = await transformBuild(
        'import { useState } from "react";',
        '/src/app.js',
        false,
        sharedOnlyOptions
      );
      expect(result).toContain('__moduleExports');
      expect(result).toContain('const { useState }');
    });

    it('rewrites shared import via es-module-lexer fallback', async () => {
      const result = await transformBuild(
        'import { useState } from "react";',
        '/src/app.tsx',
        true
      );
      expect(result).toContain('__moduleExports');
      expect(result).toContain('const { useState }');
    });

    it('skips __loadShare__ modules for shared packages', async () => {
      const result = await transformBuild(
        'import { useState } from "react";',
        '/virtual/__loadShare__react.js'
      );
      expect(result).toBeUndefined();
    });

    it('does not rewrite __loadShare__ imports in dev mode (non-Rolldown)', async () => {
      mockGetIsRolldown.mockReturnValueOnce(false);
      const code = [
        'import { useState } from "__mf__virtual/host__loadShare__react__loadShare__.js";',
        'import { foo } from "remoteApp/utils";',
      ].join('\n');
      const result = await transform(code, '/src/app.js', false, SHARED_OPTIONS);
      // Only the remote import should be rewritten, not the shared __loadShare__ import
      expect(result).toContain('const { foo }');
      expect(result).not.toContain('const { useState }');
    });
  });

  // ── sourcemaps ───────────────────────────────────────────────

  describe('sourcemaps', () => {
    it('returns sourcemap when code is transformed', async () => {
      const plugin = pluginRemoteNamedExports(OPTIONS);
      const ctx = createContext();
      const result = await (plugin as any).transform.call(
        ctx,
        'import { foo } from "remoteApp/utils";',
        '/src/app.js'
      );
      expect(result).toBeDefined();
      expect(result.map).toBeDefined();
      expect(result.map.mappings).toBeTruthy();
    });
  });
});
