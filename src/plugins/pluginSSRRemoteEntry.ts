import { Plugin } from 'vite';
import { NormalizedModuleFederationOptions } from '../utils/normalizeModuleFederationOptions';
import { getIsRolldown } from '../utils/packageUtils';
import { generateExposesSSR, getVirtualExposesSSRId } from '../virtualModules/virtualExposesSSR';
import {
  generateRemoteEntrySSR,
  getRemoteEntrySSRId,
  getSSRFilename,
} from '../virtualModules/virtualRemoteEntrySSR';

/**
 * Emits a Node-compatible SSR remote entry alongside the browser entry.
 *
 * Format strategy:
 *  - Vite 8+ (Rolldown): ESM output — Rolldown's native format, no CJS interop issues.
 *  - Vite 5–7 (Rollup): CJS output — Rollup has mature CJS support; Node can
 *    require() it directly without any experimental flags.
 *
 * In both cases shared packages (react, react-dom, etc.) are marked as external
 * so Node resolves them through its own module cache, guaranteeing the singleton
 * is shared with react-dom/server.
 */
export function pluginSSRRemoteEntry(options: NormalizedModuleFederationOptions): Plugin[] {
  const remoteEntrySSRId = getRemoteEntrySSRId(options);
  const virtualExposesSSRId = getVirtualExposesSSRId(options);
  let isRolldown = false;
  let ssrOutputFilename = '';

  // MF internal packages must be external for the SSR entry (Node resolves
  // them via its module cache) but must NOT be global externals — they need
  // to be bundled inline in the browser remote entry to avoid bare-specifier
  // errors (browsers cannot resolve "@module-federation/runtime" etc.).
  const ssrOnlyExternals = [
    '@module-federation/runtime',
    '@module-federation/runtime-core',
    '@module-federation/sdk',
    ...(options.ssrExternals ?? []),
  ];
  const ssrOnlyExternalPattern = new RegExp(
    `^(${ssrOnlyExternals.map((e) => e.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')).join('|')})(\\/.*)?$`
  );

  // Tracks every module ID that belongs to the SSR entry's module graph.
  // Populated in resolveId as we walk the graph so transitive deps are covered.
  const ssrModuleIds = new Set<string>([remoteEntrySSRId, virtualExposesSSRId]);

  // Maps resolved absolute paths → the bare package name they came from.
  // Vite's internal alias plugin rewrites bare MF specifiers to abs paths
  // before any user plugin's resolveId fires — so we intercept by abs path
  // and re-externalise using the original bare package name (so Node can
  // resolve it from its own module cache at runtime).
  const resolvedAbsToPackage = new Map<string, string>();
  let isServe = false;

  return [
    {
      name: 'mf:ssr-remote-entry:pre',
      enforce: 'pre',
      // Intentionally no `apply: 'build'` — resolveId/load must also run in
      // serve so Vite's dev server can respond to virtual SSR module requests
      // from ssrEntryLoader.

      configResolved(config) {
        isServe = config.command === 'serve';
        // Build a map of alias target abs-path → bare package name for each
        // SSR-only external. This lets resolveId intercept the post-alias path.
        for (const pkg of ssrOnlyExternals) {
          const aliasEntry = (
            config.resolve?.alias as { find: unknown; replacement: string }[] | undefined
          )?.find((a) => a.find === pkg || (a.find instanceof RegExp && a.find.test(pkg)));
          if (aliasEntry?.replacement) {
            resolvedAbsToPackage.set(aliasEntry.replacement, pkg);
          }
        }
      },

      resolveId(id, importer) {
        // Register virtual SSR module IDs so they resolve to themselves.
        if (id === remoteEntrySSRId || id.startsWith(remoteEntrySSRId)) return id;
        if (id === virtualExposesSSRId || id.startsWith(virtualExposesSSRId)) return id;

        if (!importer || !ssrModuleIds.has(importer)) return;

        // Bare specifier match — fires when the alias hasn't run yet
        // (e.g. for runtime-core, sdk which aren't aliased by Vite internals).
        if (ssrOnlyExternalPattern.test(id)) {
          return { id, external: true };
        }

        // Abs-path match — fires when Vite's alias already resolved a bare
        // specifier (e.g. @module-federation/runtime → /abs/.../dist/index.js).
        // Re-externalise using the original package name so Node can resolve it.
        const pkg = resolvedAbsToPackage.get(id);
        if (pkg) {
          return { id: pkg, external: true };
        }

        // Track other SSR imports so their transitive deps are also scoped.
        // Skip bare specifiers — they're either SSR externals (handled above)
        // or shared packages that should not be followed into the SSR graph.
        if (id.startsWith('.') || id.startsWith('/') || id.startsWith('file:')) {
          return this.resolve(id, importer, { skipSelf: true }).then((resolved) => {
            if (resolved) ssrModuleIds.add(resolved.id);
            return resolved;
          });
        }
      },
    },
    {
      name: 'mf:ssr-remote-entry',
      // No `apply: 'build'` — resolveId/load must run in serve too.
      // buildStart and generateBundle are guarded internally.

      configureServer(server) {
        const base = '/__mf_ssr__';
        const fileBase = `${base}/module`;

        // Middleware that serves SSR-transformed versions of source files.
        // ssrLoadModule runs Vite's server-side transform pipeline — the output
        // is Node-compatible ESM (no browser globals, HMR, or /@react-refresh).
        // ssrEntryLoader fetches these URLs, writes temp .mjs files, and imports
        // them via Node's native ESM loader.
        server.middlewares.use(fileBase, async (req, res) => {
          const filePath = decodeURIComponent(req.url?.slice(1) ?? '');
          if (!filePath) {
            res.statusCode = 400;
            res.end('Missing file path');
            return;
          }
          try {
            const mod = await server.ssrLoadModule(filePath);
            // Serialise the evaluated module as ESM — re-export all keys.
            const exports = Object.keys(mod);
            const lines = exports.map((key) => {
              const val = mod[key];
              const serialised = typeof val === 'function' ? val.toString() : JSON.stringify(val);
              return `export const ${key === 'default' ? '_default' : key} = ${serialised};`;
            });
            if ('default' in mod) lines.push(`export default _default;`);
            res.setHeader('Content-Type', 'application/javascript');
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.end(lines.join('\n'));
          } catch (e) {
            res.statusCode = 500;
            res.end(`// ssrLoadModule error: ${String(e)}\nexport default null;`);
          }
        });

        // Serve the SSR remote entry at a predictable URL.
        const ssrPath = `${base}/${options.filename.replace(/\.[^.]+$/, '')}.server.js`;
        server.middlewares.use(ssrPath, (_req, res) => {
          const exposesUrl = `${base}/${options.filename.replace(/\.[^.]+$/, '')}.exposes.js`;
          const code = generateRemoteEntrySSR(options).replace(
            JSON.stringify(virtualExposesSSRId),
            JSON.stringify(exposesUrl)
          );
          res.setHeader('Content-Type', 'application/javascript');
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.end(code);
        });

        // Serve the exposes map with URLs pointing to the SSR module endpoint.
        const exposesPath = `${base}/${options.filename.replace(/\.[^.]+$/, '')}.exposes.js`;
        server.middlewares.use(exposesPath, (_req, res) => {
          const exposesCode = `
    export default {
    ${Object.entries(options.exposes)
      .map(([key, config]) => {
        const encodedPath = encodeURIComponent(config.import);
        return `
        ${JSON.stringify(key)}: async () => {
          const importModule = await import("${fileBase}/${encodedPath}")
          const exportModule = {}
          Object.assign(exportModule, importModule)
          Object.defineProperty(exportModule, "__esModule", {
            value: true,
            enumerable: false
          })
          return exportModule
        }
      `;
      })
      .join(',')}
  }
  `;
          res.setHeader('Content-Type', 'application/javascript');
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.end(exposesCode);
        });
      },

      resolveId(id) {
        // Register virtual SSR module IDs so they resolve to themselves.
        if (id === remoteEntrySSRId || id.startsWith(remoteEntrySSRId)) return id;
        if (id === virtualExposesSSRId || id.startsWith(virtualExposesSSRId)) return id;
      },

      load(id) {
        if (id === remoteEntrySSRId || id.startsWith(remoteEntrySSRId)) {
          return generateRemoteEntrySSR(options);
        }
        if (id === virtualExposesSSRId || id.startsWith(virtualExposesSSRId)) {
          return generateExposesSSR(options);
        }
      },

      buildStart() {
        // Only emit the SSR entry chunk during vite build — not vite serve.
        if (isServe) return;
        // `this.meta` is available in Rollup/Rolldown hooks — use it to detect
        // whether we're running under Rolldown (Vite 8+) so we can choose the
        // right output format and file extension.
        isRolldown = getIsRolldown(this);
        ssrOutputFilename = getSSRFilename(options.filename, /* isCJS */ !isRolldown);

        const environmentName = (this as { environment?: { name?: string } }).environment?.name;
        // Only emit in the client environment — the SSR module runner shouldn't
        // produce a second SSR entry.
        if (environmentName && environmentName !== 'client') return;

        if (Object.keys(options.exposes).length === 0) return;

        this.emitFile({
          type: 'chunk',
          id: remoteEntrySSRId,
          name: 'ssrRemoteEntry',
          fileName: ssrOutputFilename,
          preserveSignature: 'strict',
        });
      },

      /**
       * Post-process the SSR entry chunk:
       *  - For Rollup (Vite 5–7): convert the emitted ESM chunk to CJS by
       *    wrapping it. Rollup can also be configured directly via
       *    `output.format` but that would affect all chunks; we only want CJS
       *    for the SSR entry.
       *  - For Rolldown (Vite 8+): the chunk is already ESM — just verify
       *    shared externals were not bundled.
       */
      generateBundle(_options, bundle) {
        if (!isRolldown) {
          // Rollup path — rewrite the emitted ESM chunk to CJS.
          const chunk = bundle[ssrOutputFilename];
          if (!chunk || chunk.type !== 'chunk') return;

          // Simple ESM→CJS transform: replace `export { init, get }` with
          // `module.exports = { init, get }` and rewrite `import X from "Y"`
          // to `const X = require("Y")`.
          let code = chunk.code;
          code = code
            .replace(
              /^import\s+\{([^}]+)\}\s+from\s+(['"])([^'"]+)\2;?/gm,
              (_m, names, _q, src) => {
                const bindings = names
                  .split(',')
                  .map((n: string) => n.trim())
                  .join(', ');
                return `const { ${bindings} } = require(${JSON.stringify(src)});`;
              }
            )
            .replace(
              /^import\s+(\w+)\s+from\s+(['"])([^'"]+)\2;?/gm,
              (_m, name, _q, src) => `const ${name} = require(${JSON.stringify(src)});`
            )
            .replace(/^export\s*\{([^}]+)\};?/gm, (_m, names) => {
              const pairs = names
                .split(',')
                .map((n: string) => {
                  const parts = n.trim().split(/\s+as\s+/);
                  const local = parts[0].trim();
                  const exported = (parts[1] ?? parts[0]).trim();
                  return `${exported}: ${local}`;
                })
                .join(', ');
              return `module.exports = { ${pairs} };`;
            })
            .replace(/^export\s+default\s+/gm, 'module.exports = ');

          // chunk.code is writable at this stage of the pipeline — Rollup exposes
          // it as readonly in the type but allows writes during generateBundle.
          (chunk as { code: string }).code = code.includes("'use strict'")
            ? code
            : `'use strict';\n${code}`;
        }
      },
    },
  ];
}
