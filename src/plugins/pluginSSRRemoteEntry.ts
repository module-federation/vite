import * as fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as path from 'node:path';
import { Plugin, ResolvedConfig } from 'vite';
import { NormalizedModuleFederationOptions } from '../utils/normalizeModuleFederationOptions';
import { getIsRolldown, isNuxtProjectRoot } from '../utils/packageUtils';
import { getBasePath, isNuxtClientBase } from '../utils/pathNormalization';
import { decodeViteId } from '../utils/VirtualModule';
import { generateExposesSSR, getVirtualExposesSSRId } from '../virtualModules/virtualExposesSSR';
import {
  generateRemoteEntrySSR,
  getRemoteEntrySSRId,
  getSsrRemoteEntryFileName,
} from '../virtualModules/virtualRemoteEntrySSR';

const MAX_RUNNER_BODY_BYTES = 1024 * 1024;
const ALLOWED_RUNNER_INVOKE_NAMES = new Set(['fetchModule', 'getBuiltins']);
const VITE_FS_PREFIX = '/@fs/';

type RunnerInvokePayload = {
  type: 'custom';
  event: 'vite:invoke';
  data: { name: 'fetchModule' | 'getBuiltins'; data: unknown[] };
};

type RunnerValidationConfig = {
  root: string;
  server?: {
    fs?: {
      allow?: string[];
    };
  };
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stripQueryAndHash(id: string): string {
  const queryIndex = id.indexOf('?');
  const hashIndex = id.indexOf('#');
  const endIndex =
    queryIndex === -1 ? hashIndex : hashIndex === -1 ? queryIndex : Math.min(queryIndex, hashIndex);
  return endIndex === -1 ? id : id.slice(0, endIndex);
}

function decodeRunnerFilePath(filePath: string): string | undefined {
  try {
    return decodeURIComponent(filePath);
  } catch {
    return undefined;
  }
}

function hasRelativeTraversal(id: string): boolean {
  return id.split(/[\\/]+/).includes('..');
}

function getRealPathIfExists(filePath: string): string | undefined {
  try {
    return fs.realpathSync.native(filePath);
  } catch {
    return undefined;
  }
}

function isPathWithinDirectory(filePath: string, directory: string): boolean {
  const realFilePath = getRealPathIfExists(filePath) ?? path.resolve(filePath);
  const realDirectory = getRealPathIfExists(directory) ?? path.resolve(directory);
  const relative = path.relative(realDirectory, realFilePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function getRunnerAllowedDirectories(config: RunnerValidationConfig): string[] {
  return [config.root, ...(config.server?.fs?.allow ?? [])].map((directory) =>
    path.resolve(directory)
  );
}

function isPathWithinAllowedDirectories(filePath: string, allowedDirectories: string[]): boolean {
  return allowedDirectories.some((directory) => isPathWithinDirectory(filePath, directory));
}

function isSafeRunnerFetchModuleId(id: unknown, config: RunnerValidationConfig): boolean {
  if (typeof id !== 'string' || !id) return false;

  const rawDecoded = decodeViteId(id);
  const decoded = rawDecoded.replace(/^\0+/, '');
  if (!decoded || rawDecoded.startsWith('\0') || decoded.startsWith('virtual:')) return !!decoded;
  if (decoded.startsWith('file://')) {
    try {
      const filePath = decodeURIComponent(new URL(decoded).pathname);
      return (
        path.isAbsolute(filePath) &&
        isPathWithinAllowedDirectories(filePath, getRunnerAllowedDirectories(config))
      );
    } catch {
      return false;
    }
  }
  if (/^(?:https?|data|blob|javascript):/i.test(decoded) || decoded.startsWith('//')) return false;

  const rawCleanId = stripQueryAndHash(decoded);
  const cleanId = decodeRunnerFilePath(rawCleanId);
  if (!cleanId || hasRelativeTraversal(cleanId)) return false;

  const allowedDirectories = getRunnerAllowedDirectories(config);
  if (cleanId.startsWith(VITE_FS_PREFIX)) {
    const fsPath = `/${cleanId.slice(VITE_FS_PREFIX.length)}`;
    return path.isAbsolute(fsPath) && isPathWithinAllowedDirectories(fsPath, allowedDirectories);
  }
  if (path.isAbsolute(cleanId)) {
    if (isPathWithinAllowedDirectories(cleanId, allowedDirectories)) return true;
    return !fs.existsSync(cleanId);
  }
  return true;
}

function isRunnerInvokePayload(
  payload: unknown,
  config: RunnerValidationConfig
): payload is RunnerInvokePayload {
  if (!payload || typeof payload !== 'object') return false;
  if (
    (payload as { type?: unknown }).type !== 'custom' ||
    (payload as { event?: unknown }).event !== 'vite:invoke'
  ) {
    return false;
  }
  const data = (payload as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return false;
  const name = (data as { name?: unknown }).name;
  const args = (data as { data?: unknown }).data;
  if (typeof name !== 'string' || !ALLOWED_RUNNER_INVOKE_NAMES.has(name) || !Array.isArray(args)) {
    return false;
  }
  if (name === 'getBuiltins') return args.length === 0;
  if (args.length < 1 || args.length > 3) return false;
  const [id, importer, opts] = args;
  return (
    isSafeRunnerFetchModuleId(id, config) &&
    (importer === undefined || importer === null || isSafeRunnerFetchModuleId(importer, config)) &&
    (opts === undefined || isPlainObject(opts))
  );
}

function readBoundedRunnerBody(
  req: IncomingMessage,
  res: ServerResponse
): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;

    const fail = (statusCode: number, message: string) => {
      if (done) return;
      done = true;
      res.statusCode = statusCode;
      res.end(message);
      resolve(undefined);
    };

    req.on('data', (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > MAX_RUNNER_BODY_BYTES) return fail(413, 'Payload too large');
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', () => fail(400, 'Bad request'));
  });
}

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
  let ssrOutputFiles = new Set<string>();
  let ssrOutputDir = '';
  let clientOutputDir = '';

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
      // The post-build publisher consumes the SSR environment's generated
      // bundle graph, so Vite 8 must use this same plugin instance for every
      // build environment and the top-level buildApp hook.
      sharedDuringBuild: true,
      // No `apply: 'build'` — resolveId/load must run in serve too.
      // buildStart and generateBundle are guarded internally.

      configResolved(config) {
        viteConfig = config;
        isNuxtProject = isNuxtProjectRoot(config.root);
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
        type EnvWithRunnerInvoke = {
          fetchModule?: unknown;
          hot?: {
            handleInvoke?: (
              payload: unknown
            ) => Promise<{ result: unknown } | { error: { message: string } }>;
          };
        };
        const ssrEnv = (
          server.environments as Record<string, EnvWithRunnerInvoke | undefined> | undefined
        )?.ssr;
        const clientEnv = (
          server.environments as Record<string, EnvWithRunnerInvoke | undefined> | undefined
        )?.client;
        const runnerEnv =
          typeof ssrEnv?.hot?.handleInvoke === 'function'
            ? ssrEnv
            : typeof clientEnv?.hot?.handleInvoke === 'function'
              ? clientEnv
              : undefined;
        if (typeof (ssrEnv?.fetchModule ?? clientEnv?.fetchModule) === 'function' && runnerEnv) {
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
              const rawBody = await readBoundedRunnerBody(req, res);
              if (!rawBody) return;

              let body: unknown;
              try {
                body = JSON.parse(rawBody.toString('utf8')) as unknown;
              } catch {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: { message: 'Invalid JSON' } }));
                return;
              }
              if (!isRunnerInvokePayload(body, server.config as RunnerValidationConfig)) {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: { message: 'Invalid runner invoke' } }));
                return;
              }

              let result = await runnerEnv.hot!.handleInvoke!(body);
              if ('error' in result && body.data.name === 'fetchModule') {
                const id = body.data.data[0];
                const bareId = typeof id === 'string' ? decodeViteId(id).replace(/^\0/, '') : '';
                const isBarePackageSpecifier =
                  bareId &&
                  !bareId.startsWith('.') &&
                  !bareId.startsWith('/') &&
                  !bareId.startsWith('file:') &&
                  !/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(bareId);

                if (isBarePackageSpecifier) {
                  try {
                    const { createRequire } = await import('module');
                    const path = await import('path');
                    const { pathToFileURL } = await import('url');
                    const req = createRequire(
                      pathToFileURL(
                        path.join((server.config as { root: string }).root, 'package.json')
                      )
                    );
                    const resolved = req.resolve(bareId);
                    result = {
                      result: { externalize: pathToFileURL(resolved).href, type: 'module' },
                    };
                  } catch {
                    // Keep Vite's original invoke error.
                  }
                }
              }
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify(result));
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

        const exposesPath = `${base}/${options.filename.replace(/\.[^.]+$/, '')}.exposes.js`;
        server.middlewares.use(exposesPath, (_req, res) => {
          res.setHeader('Content-Type', 'application/javascript');
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.end(generateExposesSSR(options));
        });
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
          // Non-Nuxt: SSR entry belongs in the dedicated `ssr` environment build.
          // Nuxt: federation assets land in `dist/client` only — emit there (or the
          // unnamed client pass), never in the Nitro `ssr` pass (wrong output dir).
          if (isNuxtProject) {
            if (environmentName === 'ssr') return;
          } else if (environmentName !== 'ssr') {
            return;
          }
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

        if ((this as { environment?: { name?: string } }).environment?.name === 'ssr') {
          ssrOutputFiles = collectEntryOutputFiles(bundle, ssrOutputFilename);
        }

        // Vite 8+ (Rolldown) only — the chunk was emitted via the chunk path in buildStart.
        // No post-processing needed; Rolldown emits ESM natively.
        // On Vite 5–7 the SSR entry was emitted as a pre-generated asset, so nothing to do here.
        if (!isRolldown) return;
        const chunk = bundle[ssrOutputFilename];
        if (!chunk || chunk.type !== 'chunk') return;
        // Verify the chunk exists and was emitted correctly — no transform needed for Rolldown.
      },

      writeBundle(outputOptions) {
        const environmentName = (this as { environment?: { name?: string } }).environment?.name;
        if (environmentName === 'ssr' && outputOptions.dir) {
          ssrOutputDir = outputOptions.dir;
        } else if (environmentName === 'client' && outputOptions.dir) {
          clientOutputDir = outputOptions.dir;
        }
        publishSsrOutputFiles(
          ssrOutputDir,
          clientOutputDir || viteConfig?.environments?.client?.build?.outDir
        );
      },
    },
  ];

  function publishSsrOutputFiles(ssrOutDir?: string, clientOutDir?: string) {
    if (ssrOutputFiles.size === 0 || !ssrOutDir || !clientOutDir) return;

    const root = viteConfig?.root ?? process.cwd();
    const ssrDir = path.resolve(root, ssrOutDir);
    const clientDir = path.resolve(root, clientOutDir);
    if (ssrDir === clientDir || !fs.existsSync(ssrDir)) return;
    fs.mkdirSync(clientDir, { recursive: true });

    // This runs for each environment build, including framework-managed
    // builds that do not invoke Vite's buildApp orchestration. Publish only
    // the SSR entry's reachable output graph; existing client files win.
    for (const fileName of ssrOutputFiles) {
      const source = path.resolve(ssrDir, fileName);
      const destination = path.resolve(clientDir, fileName);
      if (!isWithinDirectory(source, ssrDir) || !isWithinDirectory(destination, clientDir)) {
        continue;
      }
      if (!fs.existsSync(source) || fs.existsSync(destination)) continue;
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(source, destination);
    }
  }
}

type OutputFile = {
  type: 'asset' | 'chunk';
  fileName: string;
  code?: string;
  source?: string | Uint8Array;
  imports?: string[];
  dynamicImports?: string[];
  implicitlyLoadedBefore?: string[];
  referencedFiles?: string[];
};

const RELATIVE_IMPORT_RE =
  /(?:\bfrom|\bimport\s*(?:\(\s*)?|\bexport\s*\*\s*from)\s*["'`](\.\.?\/[^"'`]+)["'`]/g;

function collectEntryOutputFiles(
  bundle: Record<string, OutputFile>,
  entryFileName: string
): Set<string> {
  const files = new Set<string>();
  const visit = (fileName: string) => {
    if (files.has(fileName)) return;
    const file = bundle[fileName];
    if (!file) return;
    files.add(fileName);

    const dependencies = new Set([
      ...(file.imports || []),
      ...(file.dynamicImports || []),
      ...(file.implicitlyLoadedBefore || []),
      ...(file.referencedFiles || []),
    ]);
    const source =
      typeof file.code === 'string'
        ? file.code
        : typeof file.source === 'string'
          ? file.source
          : '';
    if (source) {
      const directory = path.posix.dirname(fileName);
      for (const match of source.matchAll(RELATIVE_IMPORT_RE)) {
        dependencies.add(path.posix.normalize(path.posix.join(directory, match[1])));
      }
    }

    for (const dependency of dependencies) {
      visit(dependency);
    }
  };
  visit(entryFileName);
  return files;
}

function isWithinDirectory(filePath: string, directory: string): boolean {
  const relative = path.relative(directory, filePath);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..';
}
