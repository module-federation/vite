import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import type { HtmlTagDescriptor, IndexHtmlTransformContext, Plugin, ResolveFn } from 'vite';
import {
  collectRemoteImports,
  isRemoteSpecifier,
  SHARE_MODULE_PREFIX,
  shareChunkName,
} from '../utils/hostProvidesAllShared';
import type { NormalizedModuleFederationOptions } from '../utils/normalizeModuleFederationOptions';
import { ensureTrailingSlash, stripQueryAndHash } from '../utils/pathNormalization';

/** How a shared module is re-exported: ESM (`export *`, plus `default`) or CommonJS (named keys). */
type ShareShape = { kind: 'esm'; hasDefault: boolean } | { kind: 'cjs'; names: string[] };

const ESM_SYNTAX_RE = /(^|[\s;])(export|import)[\s{*]/m;
const DEFAULT_EXPORT_RE = /export\s+default\b|export\s*\{[^}]*\bas\s+default\b/;
const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/;

/**
 * Export names of a CommonJS package, read by loading it in Node from the project root
 * (what the bundler's interop exposes as named imports). Empty when it cannot be loaded
 * in Node, e.g. because it touches `window`.
 */
function cjsExportNames(key: string, root: string): string[] {
  try {
    const exported = createRequire(path.join(root, 'package.json'))(key);
    return Object.keys(exported ?? {}).filter(
      (name) => name !== 'default' && name !== '__esModule' && IDENTIFIER_RE.test(name)
    );
  } catch {
    return [];
  }
}

/** Shape of a shared module, sniffed from its real package entry (never a pre-bundle). */
function detectShareShape(key: string, entry: string | undefined, root: string): ShareShape {
  const source = entry && fs.existsSync(entry) ? fs.readFileSync(entry, 'utf8') : '';
  if (source !== '' && !ESM_SYNTAX_RE.test(source)) {
    return { kind: 'cjs', names: cjsExportNames(key, root) };
  }
  return { kind: 'esm', hasDefault: DEFAULT_EXPORT_RE.test(source) };
}

/**
 * Body of the re-export entry for one shared key. `export *` never forwards `default` and
 * forwards nothing named from CommonJS, so an ESM module adds `default` only when it has
 * one, and a CommonJS module re-exports each key explicitly (`react/jsx-runtime` → `jsx`,
 * `jsxs`) so remotes can `import { jsxs }`.
 */
function shareModuleCode(key: string, shape: ShareShape): string {
  const spec = JSON.stringify(key);
  if (shape.kind === 'cjs') {
    const named = shape.names.length
      ? `export const { ${shape.names.join(', ')} } = __mf_cjs;\n`
      : '';
    return `import __mf_cjs from ${spec};\nexport default __mf_cjs;\n${named}`;
  }
  const forwardDefault = shape.hasDefault ? `export { default } from ${spec};\n` : '';
  return `export * from ${spec};\n${forwardDefault}`;
}

/** BUILD: shared key → URL of its emitted entry chunk. */
function bundledShareImports(
  bundle: NonNullable<IndexHtmlTransformContext['bundle']>,
  base: string
): Record<string, string> {
  const imports: Record<string, string> = {};
  for (const chunk of Object.values(bundle)) {
    if (chunk.type === 'chunk' && chunk.facadeModuleId?.startsWith(SHARE_MODULE_PREFIX)) {
      imports[chunk.facadeModuleId.slice(SHARE_MODULE_PREFIX.length)] = `${base}${chunk.fileName}`;
    }
  }
  return imports;
}

/**
 * DEV: shared key → dev-server URL of its virtual re-export module. Vite serves `\0` ids
 * at `/@id/__x00__<id>`; import analysis then rewrites the module's own `from '<key>'` to
 * the same pre-bundle URL the host's code gets, so host and remotes share one instance.
 */
function devShareImports(sharedKeys: string[], base: string): Record<string, string> {
  const prefix = `${base}@id/__x00__${SHARE_MODULE_PREFIX.slice(1)}`;
  return Object.fromEntries(sharedKeys.map((key) => [key, `${prefix}${key}`]));
}

function importMapTag(imports: Record<string, string>): HtmlTagDescriptor {
  return {
    tag: 'script',
    attrs: { type: 'importmap' },
    children: JSON.stringify({ imports }, null, 2),
    // Before any module script: an import map must precede the first module resolution.
    injectTo: 'head-prepend',
  };
}

/**
 * Host side of `experiments.hostProvidesAllShared`. The host provides every shared key:
 *
 * 1. one re-export module per shared key, emitted in a build as a `preserveSignature:
 *    'strict'` entry chunk that the bundler dedupes with the host's own imports, and served
 *    in dev as a virtual module; either way host and remotes land on one module instance;
 * 2. an import map in `index.html` pointing each shared key at that module and each remote
 *    expose at the entry listed in the remote's `mf-manifest.json`.
 */
export function pluginHostProvidesAllSharedHost(
  options: NormalizedModuleFederationOptions
): Plugin {
  const sharedKeys = Object.keys(options.shared);
  const remoteKeys = Object.keys(options.remotes);
  let isBuild = true;
  let base = '/';
  let root = process.cwd();
  let remoteImports: Record<string, string> = {};
  // DEV: `this.resolve` lands on Vite's pre-bundle, which always looks like ESM and may not be
  // written yet. A bare config resolver has no optimizer and returns the package's real entry.
  let resolveEntry: ResolveFn | undefined;

  return {
    name: 'module-federation:host-provides-all-shared-host',
    enforce: 'pre',
    configResolved(config) {
      isBuild = config.command === 'build';
      base = ensureTrailingSlash(config.base);
      root = config.root;
      resolveEntry = isBuild ? undefined : config.createResolver();
    },
    async buildStart() {
      remoteImports = await collectRemoteImports(options.remotes, root);
      if (!isBuild) return;
      for (const key of sharedKeys) {
        this.emitFile({
          type: 'chunk',
          id: `${SHARE_MODULE_PREFIX}${key}`,
          name: shareChunkName(key),
          preserveSignature: 'strict',
        });
      }
    },
    resolveId(id) {
      if (id.startsWith(SHARE_MODULE_PREFIX)) return id;
      if (!isRemoteSpecifier(id, remoteKeys)) return null;
      // Build: keep the bare specifier for the browser's import map. Dev: import analysis
      // would turn a bare id into a URL, so resolve straight to the URL the map points at.
      return { id: isBuild ? id : (remoteImports[id] ?? id), external: true };
    },
    async load(id) {
      if (!id.startsWith(SHARE_MODULE_PREFIX)) return null;
      const key = id.slice(SHARE_MODULE_PREFIX.length);
      const entry = resolveEntry
        ? await resolveEntry(key)
        : (await this.resolve(key, undefined, { skipSelf: true }))?.id;
      return shareModuleCode(key, detectShareShape(key, entry && stripQueryAndHash(entry), root));
    },
    transformIndexHtml: {
      order: 'post',
      handler(html, context) {
        const shares = context.bundle
          ? bundledShareImports(context.bundle, base)
          : devShareImports(sharedKeys, base);
        return { html, tags: [importMapTag({ ...remoteImports, ...shares })] };
      },
    },
  };
}
