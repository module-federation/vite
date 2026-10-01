import * as fs from 'node:fs';
import type { HtmlTagDescriptor, IndexHtmlTransformContext, Plugin } from 'vite';
import type { NormalizedModuleFederationOptions } from '../utils/normalizeModuleFederationOptions';
import { sharedChunkName } from '../utils/importMapSpecifiers';

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
 * 1. One re-export entry chunk per shared key (`export * from '<key>'`, plus `default`
 *    when present), emitted with `preserveSignature: 'strict'` so its exports stay intact.
 *    The bundler dedupes it with the host's own imports of the same package, so the host
 *    and every remote end up on one module instance.
 * 2. An import map in `index.html` that points each shared key at its entry chunk.
 */
export function pluginImportMapHost(options: NormalizedModuleFederationOptions): Plugin {
  const sharedKeys = Object.keys(options.shared);
  let base = '/';

  return {
    name: 'module-federation:importmap-host',
    enforce: 'pre',
    apply: 'build',
    configResolved(config) {
      base = config.base.endsWith('/') ? config.base : `${config.base}/`;
    },
    buildStart() {
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
      return id.startsWith(SHARE_PREFIX) ? id : null;
    },
    async load(id) {
      if (!id.startsWith(SHARE_PREFIX)) return null;
      const key = id.slice(SHARE_PREFIX.length);
      const resolved = await this.resolve(key, undefined, { skipSelf: true });
      const file = resolved?.id.split('?')[0];
      const forwardDefault =
        file !== undefined &&
        fs.existsSync(file) &&
        hasDefaultExport(fs.readFileSync(file, 'utf8'));
      return shareEntryCode(key, forwardDefault);
    },
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        if (!ctx.bundle) return html;
        return {
          html,
          tags: [importMapTag(collectShareImports(ctx.bundle, base))],
        };
      },
    },
  };
}
