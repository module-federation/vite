import { Plugin, ResolvedConfig } from 'vite';
import { NormalizedModuleFederationOptions } from '../utils/normalizeModuleFederationOptions';
import { getIsRolldown, hasPackageDependency } from '../utils/packageUtils';
import { getBasePath, isNuxtClientBase } from '../utils/pathNormalization';
import { generateExposesSSR, getVirtualExposesSSRId } from '../virtualModules/virtualExposesSSR';
import {
  generateRemoteEntrySSR,
  getRemoteEntrySSRId,
  getSsrRemoteEntryFileName,
} from '../virtualModules/virtualRemoteEntrySSR';

/**
 * Emits a Node-compatible SSR remote entry alongside the browser entry.
 *
 * Format strategy:
 *  - Emit a dedicated ESM SSR entry alongside the browser entry.
 *  - Keep the SSR entry out of the browser remote graph for Rollup builds by
 *    emitting it as a generated asset.
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
  let viteConfig: ResolvedConfig | undefined;
  let isNuxtProject = false;

  const findNuxtExposesChunk = (
    bundle: Record<string, { type: string; fileName: string; code?: string }>
  ) => {
    const exposeKeys = Object.keys(options.exposes);
    if (exposeKeys.length === 0) return;

    return Object.values(bundle).find((file) => {
      if (
        file.type !== 'chunk' ||
        !file.fileName.startsWith('_nuxt/') ||
        !file.fileName.endsWith('.js')
      ) {
        return false;
      }
      const code = file.code || '';
      return exposeKeys.every((key) => code.includes(JSON.stringify(key)));
    })?.fileName;
  };

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

      configResolved(config) {
        viteConfig = config;
        isNuxtProject =
          hasPackageDependency('nuxt', config.root) ||
          hasPackageDependency('nuxt-nightly', config.root);
      },

      configureServer(server) {
        const base = '/__mf_ssr__';
        const basePath = getBasePath(viteConfig?.base);
        const ssrEntryFileName = getSsrRemoteEntryFileName(options.filename);

        if (isNuxtProject || isNuxtClientBase(basePath)) {
          server.middlewares.use((req, _res, next) => {
            if (req.url?.replace(/\?.*/, '') === `${basePath}/${ssrEntryFileName}`) {
              req.url = `${basePath}/__mf_ssr__/${ssrEntryFileName}`;
            }
            next();
          });
        }

        // Vite 8+ fetchModule proxy — allows ssrEntryLoader to create a
        // ModuleRunner on the remote host that fetches module source via HTTP
        // instead of through Vite's internal channels (which aren't available
        // across process boundaries). Each remote's Vite dev server exposes
        // this endpoint so the host's ssrEntryLoader can import remote modules
        // as fully-transformed, Node-compatible ESM at runtime.
        //
        // Only wired up when Vite exposes `fetchModule` (Vite 8+). Older
        // Vite versions fall back to the build-mode SSR entry path.
        // `fetchModule` lives on `DevEnvironment`, not on `ViteDevServer` directly.
        // Check via `environments.client` — present on Vite 8+.
        const ssrEnv = (
          server.environments as Record<string, { fetchModule?: unknown } | undefined> | undefined
        )?.ssr;
        const clientEnv = (
          server.environments as Record<string, { fetchModule?: unknown } | undefined> | undefined
        )?.client;
        if (typeof (ssrEnv?.fetchModule ?? clientEnv?.fetchModule) === 'function') {
          const runnerBase = '/__mf_runner__';
          server.middlewares.use(runnerBase, async (req, res) => {
            res.setHeader('Access-Control-Allow-Origin', '*');
            if (req.method === 'OPTIONS') {
              res.setHeader('Access-Control-Allow-Methods', 'POST');
              res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
              res.statusCode = 204;
              res.end();
              return;
            }
            if (req.method !== 'POST') {
              res.statusCode = 405;
              res.end('Method not allowed');
              return;
            }
            try {
              const chunks: Buffer[] = [];
              await new Promise<void>((resolve, reject) => {
                req.on('data', (chunk: Buffer) => chunks.push(chunk));
                req.on('end', resolve);
                req.on('error', reject);
              });
              const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
                name: string;
                data: [string, string?, { cached?: boolean; startOffset?: number }?];
              };
              // getBuiltins: return the resolved builtins list from Vite config.
              if (body.name === 'getBuiltins') {
                const env = (clientEnv ?? ssrEnv) as
                  | { config?: { resolve?: { builtins?: unknown[] } } }
                  | undefined;
                const builtins = env?.config?.resolve?.builtins ?? [];
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ result: builtins }));
                return;
              }
              if (body.name !== 'fetchModule') {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: { message: `Unsupported invoke: ${body.name}` } }));
                return;
              }
              const [id, importer, opts] = body.data;
              // Use the SSR environment for transforms. When `fetchModule` fails
              // (e.g. for bare Node.js package specifiers like @module-federation/runtime
              // that the SSR env externalises via Node module resolution), fall through
              // to a manual resolution using the remote project's require.
              type EnvWithFetch = {
                fetchModule: (
                  id: string,
                  importer?: string,
                  opts?: Record<string, unknown>
                ) => Promise<unknown>;
              };
              const fetchEnv = (ssrEnv as EnvWithFetch | undefined) ?? (clientEnv as EnvWithFetch);
              const fetchFn = fetchEnv.fetchModule.bind(fetchEnv);
              let result: unknown;
              try {
                result = await fetchFn(id, importer, opts);
              } catch (fetchErr) {
                // SSR env failed to resolve — try externalising via Node require from
                // the remote project root. This handles bare package specifiers like
                // @module-federation/runtime that need to run as Node externals.
                const bareId = id.startsWith('/@id/') ? id.slice(5).replace(/^__x00__/, '\0') : id;
                try {
                  const { createRequire } = await import('module');
                  const req = createRequire(
                    new URL(`file://${(server.config as { root: string }).root}/package.json`)
                  );
                  const resolved = req.resolve(bareId.replace(/^\0/, ''));
                  const { pathToFileURL } = await import('url');
                  result = { externalize: pathToFileURL(resolved).href, type: 'module' };
                } catch {
                  throw fetchErr;
                }
              }
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ result }));
            } catch (e) {
              res.setHeader('Content-Type', 'application/json');
              res.end(
                JSON.stringify({ error: { message: String(e instanceof Error ? e.message : e) } })
              );
            }
          });
        }

        // Serve the SSR remote entry at a predictable URL.
        const ssrPath = `${base}/${ssrEntryFileName}`;
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

        // Note: no exposes-map middleware here. The /__mf_ssr__/ path is only
        // consumed by ModuleRunner (Vite 8+), which resolves the exposes virtual
        // module through the plugin pipeline (resolveId → load → generateExposesSSR)
        // rather than via HTTP. Vite < 8 dev mode is not supported.
      },

      resolveId(id) {
        // Register virtual SSR module IDs so they resolve to themselves.
        if (id === remoteEntrySSRId || id.startsWith(remoteEntrySSRId)) return id;
        if (id === virtualExposesSSRId || id.startsWith(virtualExposesSSRId)) return id;

        // Vite 8+ dev path: allow server.fetchModule() to resolve the
        // /__mf_ssr__/*.ssr.js URL as the virtual SSR entry. ModuleRunner
        // imports this path and Vite resolves it here so load() can serve it.
        const ssrDevPath = `/__mf_ssr__/${getSsrRemoteEntryFileName(options.filename)}`;
        if (id === ssrDevPath) return remoteEntrySSRId;
        const exposesDevPath = `/__mf_ssr__/${options.filename.replace(/\.[^.]+$/, '')}.exposes.js`;
        if (id === exposesDevPath) return virtualExposesSSRId;
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
        ssrOutputFilename = getSsrRemoteEntryFileName(options.filename);

        const environmentName = (this as { environment?: { name?: string } }).environment?.name;
        const hasSsrEnvironment = Boolean(viteConfig?.environments?.ssr);
        const isLegacySsrBuild = Boolean(
          (this as { environment?: { config?: ResolvedConfig } }).environment?.config?.build?.ssr
        );

        // Environment API (client + ssr): emit only in the ssr environment so exposes
        // are bundled with the Node SSR graph (nested loadRemote stays on the server).
        // Nuxt only runs the client Vite graph for federation output (dist/client);
        // skipping the client pass leaves no remoteEntry.ssr.js in .output/public and
        // the host falls back to the browser remoteEntry (SourceTextModule errors).
        if (hasSsrEnvironment) {
          if (environmentName !== 'ssr' && !isNuxtProject) return;
        } else if (isLegacySsrBuild) {
          // Legacy `vite build --ssr` pass (e.g. vue-ssr dual build:server).
        } else if (environmentName && environmentName !== 'client') {
          return;
        }

        if (Object.keys(options.exposes).length === 0) return;

        if (isRolldown) {
          // Vite 8+ (Rolldown): emit as a proper chunk. Rolldown handles multiple
          // entry chunks without code-splitting side effects on the browser entry.
          this.emitFile({
            type: 'chunk',
            id: remoteEntrySSRId,
            name: 'ssrRemoteEntry',
            fileName: ssrOutputFilename,
            preserveSignature: 'strict',
          });
        } else {
          // Vite 5–7 (Rollup): emit as a pre-generated ESM asset instead of a chunk.
          // Emitting a second Rollup entry chunk that shares transitive deps with
          // the browser remoteEntry causes Rollup to code-split those deps out of
          // remoteEntry.js, breaking tests and consuming apps that expect them inlined.
          // Generating the ESM asset directly avoids touching the browser module graph.
          this.emitFile({
            type: 'asset',
            fileName: ssrOutputFilename,
            source: generateRemoteEntrySSR(options),
          });
        }
      },

      generateBundle(_options, bundle) {
        const exposesChunk = findNuxtExposesChunk(bundle);
        const ssrAsset = bundle[ssrOutputFilename];
        if (exposesChunk && ssrAsset?.type === 'asset' && typeof ssrAsset.source === 'string') {
          ssrAsset.source = ssrAsset.source.replace(
            /import\("virtual:mf-exposes-ssr:[^"]+"\)/g,
            `import("./${exposesChunk}")`
          );
        }

        // Vite 8+ (Rolldown) only — the chunk was emitted via the chunk path in buildStart.
        // No post-processing needed; Rolldown emits ESM natively.
        // On Vite 5–7 the SSR entry was emitted as a pre-generated asset, so nothing to do here.
        if (!isRolldown) return;
        const chunk = bundle[ssrOutputFilename];
        if (!chunk || chunk.type !== 'chunk') return;
        // Verify the chunk exists and was emitted correctly — no transform needed for Rolldown.
      },
    },
  ];
}
