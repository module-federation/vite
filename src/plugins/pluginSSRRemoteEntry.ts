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

  // User-configured shared packages (react, react-dom, etc.) are marked as
  // global externals in the remote entry browser build — this is intentional
  // MF behaviour: the host's share scope provides them at runtime via init().
  // User-provided ssrExternals extend this list for the SSR entry only.
  const sharedPackages = Object.keys(options.shared);
  const sharedPattern = new RegExp(
    `^(${sharedPackages.map((e) => e.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')).join('|')})(\\/.*)?$`
  );

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

  return [
    {
      name: 'mf:ssr-remote-entry:pre',
      enforce: 'pre',
      apply: 'build',

      configResolved(config) {
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
        if (!sharedPattern.test(id)) {
          return this.resolve(id, importer, { skipSelf: true }).then((resolved) => {
            if (resolved) ssrModuleIds.add(resolved.id);
            return resolved;
          });
        }
      },
    },
    {
      name: 'mf:ssr-remote-entry',
      apply: 'build',

      config(config) {
        // Only remotes (apps with exposes) mark shared packages as external in
        // the browser build. The host provides them via the MF share scope at
        // runtime when the remote container's init() is called. Consumer-only
        // hosts must bundle react etc. inline — they have no remote container
        // to hand off shared packages to.
        if (Object.keys(options.exposes).length === 0) return;

        // Mark user-configured shared packages as external globally so that
        // CJS transitive deps (e.g. use-sync-external-store) can safely
        // require() them without hitting a TLA loadShare virtual module.
        config.build ??= {};
        const buildWithRolldown = config.build as typeof config.build & {
          rolldownOptions?: { external?: (string | RegExp)[] };
        };
        buildWithRolldown.rolldownOptions ??= {};
        buildWithRolldown.rolldownOptions.external ??= [];
        buildWithRolldown.rolldownOptions.external = [
          ...buildWithRolldown.rolldownOptions.external,
          sharedPattern,
        ];
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
        // `this.meta` is available in Rollup/Rolldown hooks — use it to detect
        // whether we're running under Rolldown (Vite 8+) so we can choose the
        // right output format and file extension.
        isRolldown = getIsRolldown(this);
        ssrOutputFilename = getSSRFilename(options.filename, /* isCJS */ !isRolldown);

        const environmentName = (this as any)?.environment?.name;
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

          (chunk as any).code = code.includes("'use strict'") ? code : `'use strict';\n${code}`;
        }
      },
    },
  ];
}
