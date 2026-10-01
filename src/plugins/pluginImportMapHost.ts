import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import type { HtmlTagDescriptor, IndexHtmlTransformContext, Plugin } from 'vite';
import { collectRemoteImports } from '../utils/importMapManifest';
import { sharedChunkName } from '../utils/importMapSpecifiers';
import type { NormalizedModuleFederationOptions } from '../utils/normalizeModuleFederationOptions';

/** Virtual-module prefix for the per-share re-export entries (`\0` keeps other plugins away). */
export const SHARE_PREFIX = '\0mf-importmap-share:';

/** How a shared module must be re-exported: ESM (`export *` ± default) or CommonJS (named keys). */
export type ShareShape = { kind: 'esm'; hasDefault: boolean } | { kind: 'cjs'; names: string[] };

const isEsmSource = (source: string) => /(^|[\s;])(export|import)[\s{*]/m.test(source);
const hasDefaultExport = (source: string) =>
  /export\s+default\b|export\s*\{[^}]*\bas\s+default\b/.test(source);
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/**
 * Export names of a CommonJS module, read by loading it in Node (what the bundler's interop
 * exposes as named imports). Empty when it can't be loaded in Node (e.g. touches `window`).
 */
function cjsExportNames(target: string, root: string): string[] {
  try {
    const mod = createRequire(path.join(root, 'package.json'))(target);
    return Object.keys(mod ?? {}).filter(
      (name) => name !== 'default' && name !== '__esModule' && IDENTIFIER.test(name)
    );
  } catch {
    return [];
  }
}

/**
 * Generated body of the re-export entry for one shared key. `export *` never re-exports
 * `default`, and re-exports nothing named from a CommonJS module, so both cases are explicit:
 * `export { default }` only when an ESM module has one, and one named binding per CommonJS key
 * (e.g. `react/jsx-runtime` → `jsx`, `jsxs`, `Fragment`) so remotes can `import { jsx }`.
 */
export function shareEntryCode(key: string, shape: ShareShape): string {
  const spec = JSON.stringify(key);
  if (shape.kind === 'cjs') {
    const named = shape.names.length
      ? `export const { ${shape.names.join(', ')} } = __mf_cjs;\n`
      : '';
    return `import __mf_cjs from ${spec};\nexport default __mf_cjs;\n${named}`;
  }
  return `export * from ${spec};\n${shape.hasDefault ? `export { default } from ${spec};\n` : ''}`;
}

/** BUILD: shared key → URL of its emitted entry chunk, read from the final bundle. */
function collectShareImports(
  bundle: NonNullable<IndexHtmlTransformContext['bundle']>,
  base: string
): Record<string, string> {
  const imports: Record<string, string> = {};
  for (const chunk of Object.values(bundle)) {
    if (chunk.type === 'chunk' && chunk.facadeModuleId?.startsWith(SHARE_PREFIX)) {
      imports[chunk.facadeModuleId.slice(SHARE_PREFIX.length)] = `${base}${chunk.fileName}`;
    }
  }
  return imports;
}

/**
 * DEV: shared key → the dev server URL of its virtual re-export module. Vite serves
 * `\0`-prefixed ids at `/@id/__x00__<id>`, and import analysis rewrites the module's own
 * `export * from '<key>'` to the same pre-bundled URL host code gets, so remotes share
 * the host's instance.
 */
function devShareImports(sharedKeys: string[], base: string): Record<string, string> {
  const prefix = `${base}@id/__x00__${SHARE_PREFIX.slice(1)}`;
  return Object.fromEntries(sharedKeys.map((key) => [key, `${prefix}${key}`]));
}

interface OptimizedDep {
  file: string;
  needsInterop?: boolean;
  processing?: Promise<void>;
}
interface DepsOptimizerLike {
  metadata: {
    optimized: Record<string, OptimizedDep>;
    discovered: Record<string, OptimizedDep>;
  };
}

/**
 * DEV: a shared key resolves to Vite's pre-bundle (`…/deps/<key>.js?v=…`), which may still
 * be written when first requested. Wait for it and return its optimizer info, whose
 * `needsInterop` says whether the package is CommonJS (the pre-bundle itself is always ESM).
 * Best effort on Vite versions without the environment API.
 */
async function awaitPrebundle(context: unknown, file: string): Promise<OptimizedDep | undefined> {
  const optimizer = (context as { environment?: { depsOptimizer?: DepsOptimizerLike } }).environment
    ?.depsOptimizer;
  if (!optimizer) return undefined;
  const { optimized, discovered } = optimizer.metadata;
  const dep = [...Object.values(optimized), ...Object.values(discovered)].find(
    (info) => info.file === file
  );
  await dep?.processing;
  return dep;
}

/**
 * Shape of the module the bundler resolved for `key`. A pre-bundle (dev) is CommonJS when the
 * optimizer says it needs interop; a plain file is CommonJS when it has no ESM syntax.
 */
async function resolveShareShape(
  context: unknown,
  key: string,
  file: string,
  { isBuild, root }: { isBuild: boolean; root: string }
): Promise<ShareShape> {
  const dep = isBuild ? undefined : await awaitPrebundle(context, file);
  const source = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const cjsSource = !isEsmSource(source);
  if (dep?.needsInterop || (!dep && cjsSource)) {
    // A CommonJS source file is loaded directly; a pre-bundle is loaded by package name.
    return { kind: 'cjs', names: cjsExportNames(dep ? key : file, root) };
  }
  return { kind: 'esm', hasDefault: hasDefaultExport(source) };
}

/** `<script type="importmap">` injected at the top of `<head>`, before any module script. */
function importMapTag(imports: Record<string, string>): HtmlTagDescriptor {
  return {
    tag: 'script',
    attrs: { type: 'importmap' },
    children: JSON.stringify({ imports }, null, 2),
    injectTo: 'head-prepend',
  };
}

/**
 * Host side of import-map mode. The host provides every shared dependency:
 *
 * 1. One re-export module per shared key (`export * from '<key>'`, plus `default` when
 *    present). In a build it is emitted as a `preserveSignature: 'strict'` entry chunk that
 *    the bundler dedupes with the host's own imports; in dev it is a virtual module served
 *    at `/@id/…`. Either way host and remotes end up on one module instance.
 * 2. An import map in `index.html` pointing each shared key at that module, and each
 *    remote expose at the entry listed in the remote's `importmap-manifest.json`.
 */
export function pluginImportMapHost(options: NormalizedModuleFederationOptions): Plugin {
  const sharedKeys = Object.keys(options.shared);
  const remoteKeys = Object.keys(options.remotes);
  const isRemoteSpecifier = (id: string) =>
    remoteKeys.some((key) => id === key || id.startsWith(`${key}/`));
  let isBuild = true;
  let base = '/';
  let root = process.cwd();
  let remoteImports: Record<string, string> = {};

  return {
    name: 'module-federation:importmap-host',
    enforce: 'pre',
    configResolved(config) {
      isBuild = config.command === 'build';
      base = config.base.endsWith('/') ? config.base : `${config.base}/`;
      root = config.root;
    },
    async buildStart() {
      remoteImports = await collectRemoteImports(options.remotes, root);
      if (!isBuild) return;
      for (const key of sharedKeys) {
        this.emitFile({
          type: 'chunk',
          id: `${SHARE_PREFIX}${key}`,
          name: `shared/${sharedChunkName(key)}`,
          preserveSignature: 'strict',
        });
      }
    },
    resolveId(id) {
      if (id.startsWith(SHARE_PREFIX)) return id;
      if (!isRemoteSpecifier(id)) return null;
      // Build: keep the bare specifier for the browser's import map. Dev: import analysis
      // turns resolved ids into URLs, so resolve straight to the URL the map points at.
      return { id: isBuild ? id : (remoteImports[id] ?? id), external: true };
    },
    async load(id) {
      if (!id.startsWith(SHARE_PREFIX)) return null;
      const key = id.slice(SHARE_PREFIX.length);
      const resolved = await this.resolve(key, undefined, { skipSelf: true });
      const file = resolved?.id.split('?')[0];
      const shape: ShareShape = file
        ? await resolveShareShape(this, key, file, { isBuild, root })
        : { kind: 'esm', hasDefault: false };
      return shareEntryCode(key, shape);
    },
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        const shares = ctx.bundle
          ? collectShareImports(ctx.bundle, base)
          : devShareImports(sharedKeys, base);
        return { html, tags: [importMapTag({ ...remoteImports, ...shares })] };
      },
    },
  };
}
