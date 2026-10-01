import * as fs from 'node:fs';
import type { HtmlTagDescriptor, IndexHtmlTransformContext, Plugin } from 'vite';
import { collectRemoteImports } from '../utils/importMapManifest';
import { sharedChunkName } from '../utils/importMapSpecifiers';
import type { NormalizedModuleFederationOptions } from '../utils/normalizeModuleFederationOptions';

/** Virtual-module prefix for the per-share re-export entries (`\0` keeps other plugins away). */
export const SHARE_PREFIX = '\0mf-importmap-share:';

/**
 * Whether the module the bundler resolved for a shared key has a `default` export.
 * `export *` never re-exports `default`, so the generated re-export module must forward
 * it explicitly when present, and must not when absent (`export { default } from` a
 * module without one is a hard error). A file with no ESM syntax is CommonJS, which the
 * bundler interops to a default export.
 */
export function hasDefaultExport(source: string): boolean {
  const isEsm = /(^|[\s;])(export|import)[\s{*]/m.test(source);
  return !isEsm || /export\s+default\b|export\s*\{[^}]*\bas\s+default\b/.test(source);
}

/** Generated body of the re-export entry for one shared key. */
export function shareEntryCode(key: string, forwardDefault: boolean): string {
  const spec = JSON.stringify(key);
  return `export * from ${spec};\n${forwardDefault ? `export { default } from ${spec};\n` : ''}`;
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
 * be written when first requested. The pre-bundle is exactly what the browser gets, and it
 * spells out `export default` iff one exists (CommonJS interop included), so wait for it
 * and probe it rather than the package's own entry. Best effort on Vite versions without
 * the environment API.
 */
async function awaitPrebundle(context: unknown, file: string): Promise<void> {
  const optimizer = (context as { environment?: { depsOptimizer?: DepsOptimizerLike } }).environment
    ?.depsOptimizer;
  if (!optimizer) return;
  const { optimized, discovered } = optimizer.metadata;
  const dep = [...Object.values(optimized), ...Object.values(discovered)].find(
    (info) => info.file === file
  );
  await dep?.processing;
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
      if (file && !isBuild) await awaitPrebundle(this, file);
      const forwardDefault =
        file !== undefined &&
        fs.existsSync(file) &&
        hasDefaultExport(fs.readFileSync(file, 'utf8'));
      return shareEntryCode(key, forwardDefault);
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
