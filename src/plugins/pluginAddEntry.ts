import * as fs from 'fs';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import type { Plugin, ResolvedConfig, Rollup } from 'vite';
import { normalizePathForImport, rebaseImport } from '../utils/buildPaths';
import { mapCodeToCodeWithSourcemap } from '../utils/mapCodeToCodeWithSourcemap';

import {
  findModuleImportSources,
  injectEntryScript,
  rewriteEntryScripts,
  sanitizeDevEntryPath,
} from '../utils/htmlEntryUtils';
import { mfWarn } from '../utils/logger';
import type { NormalizedModuleFederationOptions } from '../utils/normalizeModuleFederationOptions';
import { getNormalizeModuleFederationOptions } from '../utils/normalizeModuleFederationOptions';
import { hasPackageDependency } from '../utils/packageUtils';
import { decodeViteId, toViteEncodedId, VITE_ID_PREFIX } from '../utils/VirtualModule';
import {
  addUsedRemote,
  getRuntimeRemoteId,
  getUsedRemotesMap,
} from '../virtualModules/virtualRemotes';
import {
  getRuntimeModuleCacheBootstrapCode,
  getRuntimeRemoteCachePrefix,
} from '../virtualModules/virtualRuntimeInitStatus';

interface AddEntryOptions {
  entryName: string;
  entryPath: string | (() => string);
  fileName?: string;
  inject?: NormalizedModuleFederationOptions['hostInitInjectLocation'];
  /** When true, skip the dev HTML-entry fallback (used for MF remotes whose index.html is never browser-requested). */
  forceClientInjected?: boolean;
  skipTransformFor?: string[];
  federationOptions?: NormalizedModuleFederationOptions;
}

const HOST_INIT_PRELOAD_CHUNKS: ReadonlyArray<(name: string) => boolean> = [
  (name) => name === 'hostInit',
  (name) => name === 'remoteEntry',
  // Tree-shaken shares deliberately keep their complete provider as a lazy
  // fallback. Preloading every virtual MF chunk would fetch that fallback
  // before runtime provider selection has a chance to choose the optimized
  // provider.
  (name) => name.startsWith('_virtual_mf') && !name.includes('__prebuild__'),
  (name) => name === 'index',
];

function escapeHtmlAttr(value: string) {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function getExistingHrefSet(html: string) {
  return new Set(Array.from(html.matchAll(/\bhref\s*=\s*["']([^"']+)["']/gi), (match) => match[1]));
}

function injectHostInitPreloads(
  html: string,
  bundle: Rollup.OutputBundle,
  resolvePath: (fileName: string) => string
) {
  const existingHrefs = getExistingHrefSet(html);
  const seenFiles = new Set<string>();
  const hrefs: string[] = [];

  for (const chunk of Object.values(bundle)) {
    if (chunk.type !== 'chunk') continue;
    if (!HOST_INIT_PRELOAD_CHUNKS.some((match) => match(chunk.name))) continue;
    if (seenFiles.has(chunk.fileName)) continue;
    seenFiles.add(chunk.fileName);
    const href = resolvePath(chunk.fileName);
    if (existingHrefs.has(href)) continue;
    existingHrefs.add(href);
    hrefs.push(href);
  }

  if (hrefs.length === 0) return html;

  const tags = hrefs
    .map((href) => `<link rel="modulepreload" crossorigin href="${escapeHtmlAttr(href)}">`)
    .join('');
  return html.includes('</head>') ? html.replace('</head>', `${tags}</head>`) : `${tags}${html}`;
}

function getFirstHtmlEntryFile(entryFiles: string[]): string | undefined {
  return entryFiles.find((file) => file.endsWith('.html'));
}

function stripQueryAndHash(file: string) {
  return file.split(/[?#]/)[0];
}

function resolveDevHashEntryFileName(fileName: string) {
  if (!fileName.includes('[hash')) return fileName;

  const normalized = fileName.replace(/(?:[._-]?\[hash(?::\d+)?\])/g, '');
  const baseName = path.basename(normalized);

  return path.extname(baseName) ? normalized : `${normalized}.js`;
}

function getBuildInput(config: any) {
  return config.build?.rollupOptions?.input ?? config.build?.rolldownOptions?.input;
}

function patchHashEntryFileName(output: any, entryName: string, fileName: string) {
  const originalEntryFileNames = output.entryFileNames;
  output.entryFileNames = (chunkInfo: { name?: string }, ...args: unknown[]) => {
    if (chunkInfo?.name === entryName) return fileName;
    if (typeof originalEntryFileNames === 'function') {
      return originalEntryFileNames(chunkInfo, ...args);
    }
    return originalEntryFileNames || 'assets/[name]-[hash].js';
  };
}

function patchHashEntryFileNames(config: any, entryName: string, fileName?: string) {
  if (!fileName?.includes?.('[hash')) return;
  config.build ??= {};
  config.build.rollupOptions ??= {};
  config.build.rolldownOptions ??= {};

  const patchOutput = (output: any) => patchHashEntryFileName(output, entryName, fileName);
  const patchBundlerOutput = (bundlerOptions: any) => {
    const output = bundlerOptions.output;
    if (Array.isArray(output)) {
      output.forEach(patchOutput);
      return;
    }
    patchOutput((bundlerOptions.output ??= {}));
  };

  patchBundlerOutput(config.build.rollupOptions);
  patchBundlerOutput(config.build.rolldownOptions);
}

const addEntry = ({
  entryName,
  entryPath,
  fileName,
  inject = 'entry',
  forceClientInjected,
  skipTransformFor = [],
  federationOptions,
}: AddEntryOptions): Plugin[] => {
  const DEV_HTML_PROXY_PREFIX = 'virtual:mf-html-entry-proxy?';
  const ENTRY_BOOTSTRAP_PARAM = 'mf-entry-bootstrap';
  const ENTRY_BOOTSTRAP_QUERY = `?${ENTRY_BOOTSTRAP_PARAM}`;
  const waitsForInit = entryName === 'hostInit';
  const getEntryPath = () => (typeof entryPath === 'function' ? entryPath() : entryPath);
  let devEntryPath = '';
  let entryFiles: string[] = [];
  let htmlFilePath: string | undefined;
  let _command: string;
  let emitFileId: string;
  let viteConfig: ResolvedConfig;
  // Producer remotes are consumed via federation entry URLs, not their index.html.
  // Skip only the broad dev HTML fallback — not isHydrationEntryFallback, which
  // SSR producer apps without index.html still need when hostInitInjectLocation is 'entry'.
  let skipHtmlDevFallback = forceClientInjected ?? false;
  let clientInjected = false;
  let emittedFileName: string | undefined;
  let skipTransformIds = new Set<string>();
  let injectedTransformIds = new Set<string>();
  let bootstrapDir = '';

  function skipSvelteKitSsrBuild() {
    return (
      (_command === 'build' || viteConfig?.command === 'build') &&
      viteConfig?.build?.ssr &&
      hasPackageDependency('@sveltejs/kit')
    );
  }

  function isSvelteKitServerModule(id: string) {
    return (
      hasPackageDependency('@sveltejs/kit') &&
      (id.includes('.svelte-kit/generated/') || id.includes('/@sveltejs/kit/src/runtime/server/'))
    );
  }

  function hasEntryBootstrapParam(id: string) {
    return (
      id.includes(ENTRY_BOOTSTRAP_PARAM) || decodeURIComponent(id).includes(ENTRY_BOOTSTRAP_PARAM)
    );
  }

  function rewriteSvelteKitInlineStart(html: string, initPath: string) {
    return html.replace(/<script>([\s\S]*?)<\/script>/gi, (scriptTag, body) => {
      if (!body.includes('kit.start(app, element);') || !body.includes('Promise.all([')) {
        return scriptTag;
      }
      // generateBundle and closeBundle both patch SvelteKit HTML; skip re-wrap.
      if (body.includes('initHost')) {
        return scriptTag;
      }

      const blockStart = body.indexOf('{');
      const blockEnd = body.lastIndexOf('}');
      if (blockStart === -1 || blockEnd <= blockStart) return scriptTag;

      const wrapped =
        body.slice(0, blockStart + 1) +
        `
const __mfCurrentScript = document.currentScript;
(async () => {
  await import(${JSON.stringify(initPath)}).then(({ initHost }) => initHost());
` +
        body
          .slice(blockStart + 1, blockEnd)
          .replaceAll('document.currentScript', '__mfCurrentScript') +
        `
})();
` +
        body.slice(blockEnd);

      return `<script>${wrapped}</script>`;
    });
  }

  function walkFiles(dir: string, predicate: (fileName: string) => boolean): string[] {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) return walkFiles(entryPath, predicate);
      return entry.isFile() && predicate(entry.name) ? [entryPath] : [];
    });
  }

  function walkHtmlFiles(dir: string): string[] {
    return walkFiles(dir, (fileName) => fileName.endsWith('.html'));
  }

  function toRelativeImport(fromFile: string, targetFile: string) {
    const relative = normalizePathForImport(path.relative(path.dirname(fromFile), targetFile));
    return relative.startsWith('.') ? relative : `./${relative}`;
  }

  function patchSvelteKitStaticHtml() {
    const buildDir = path.resolve(viteConfig.root, 'build');
    let initFile = emittedFileName ? path.resolve(buildDir, emittedFileName) : undefined;
    if (!initFile || !fs.existsSync(initFile)) {
      initFile = walkFiles(buildDir, (fileName) => fileName.endsWith('.js')).find((file) => {
        const code = fs.readFileSync(file, 'utf-8');
        return code.includes('hostInitPromise') && code.includes('initHost');
      });
    }
    if (!initFile) return false;
    let patched = false;
    for (const htmlFile of walkHtmlFiles(buildDir)) {
      const html = fs.readFileSync(htmlFile, 'utf-8');
      const rewritten = rewriteSvelteKitInlineStart(html, toRelativeImport(htmlFile, initFile));
      if (rewritten !== html) {
        fs.writeFileSync(htmlFile, rewritten);
        patched = true;
      }
    }
    return patched;
  }

  function getBootstrapSource(
    initSrc: string,
    entrySrc: string,
    useSystemImportFallback = false,
    options?: { skipRemotePreload?: boolean }
  ) {
    const importHelper = useSystemImportFallback
      ? `const __mfImport = (src) =>
  globalThis.System && typeof globalThis.System.import === 'function'
    ? globalThis.System.import(src)
    : import(src);
`
      : '';
    const importExpression = (src: string) =>
      useSystemImportFallback
        ? `__mfImport(${JSON.stringify(src)})`
        : `import(${JSON.stringify(src)})`;

    // Eagerly preloading remotes mirrors the federation runtime's own
    // `version-first` behaviour, where `ShareHandler.initializeSharing()` loads
    // every remote entry during startup. With `loaded-first` the runtime defers
    // remote loading until a module is actually requested, so the host must NOT
    // preload — otherwise an offline remote would block host bootstrap even
    // though the user explicitly opted into the on-demand strategy.
    const shouldPreloadRemotes =
      !options?.skipRemotePreload &&
      (federationOptions ?? getNormalizeModuleFederationOptions())?.shareStrategy !==
        'loaded-first';

    // Bare ids may represent a root (`.`) expose, so preload them too. Failures
    // remain non-blocking through Promise.allSettled below.
    const remotePreloads = shouldPreloadRemotes
      ? Object.entries(getUsedRemotesMap(federationOptions))
          .flatMap(([, remotes]) => Array.from(remotes))
          .sort()
          .map(
            (remote) =>
              `__mfPreloadRemote(${JSON.stringify(
                getRuntimeRemoteId(
                  remote,
                  (federationOptions ?? getNormalizeModuleFederationOptions()).remotes,
                  federationOptions
                )
              )}, ${JSON.stringify(remote)})`
          )
          .join(',')
      : '';
    const remoteCachePrefix = getRuntimeRemoteCachePrefix(federationOptions);

    const preloadBlock = remotePreloads
      ? `
  const runtime = await initHost();
  const __mfPreloadRemote = (runtimeRemote, remote) => {
    const remoteCacheKey = ${JSON.stringify(remoteCachePrefix)} + remote;
    const pendingKey = "__mf_pending__" + remoteCacheKey;
    if (!__mfModuleCache.remote[pendingKey]) {
      __mfModuleCache.remote[pendingKey] = runtime.loadRemote(runtimeRemote)
        .then((mod) => {
          __mfModuleCache.remote[remoteCacheKey] = mod;
          delete __mfModuleCache.remote[pendingKey];
          return mod;
        })
        .catch((error) => {
          delete __mfModuleCache.remote[pendingKey];
          throw error;
        });
    }
    return __mfModuleCache.remote[pendingKey];
  };
  const __mfRemotePreloads = [${remotePreloads}];
  await Promise.allSettled(__mfRemotePreloads);`
      : `await initHost();`;

    // The hostInit chunk's top-level await may be lowered to an emulated
    // `__tla` promise (e.g. by vite-plugin-top-level-await, or any build target
    // below es2022). Under that lowering the dynamic import resolves after the
    // module's *synchronous* evaluation — before its async init assigns
    // `initHost` — so destructuring `initHost` immediately races the init and
    // reads `undefined` in engines that settle the import microtask first
    // (notably Safari/JavaScriptCore; V8 happens to win the race). Await the
    // module's exported `__tla` promise before reading `initHost`. No-op under
    // native TLA, where `__tla` is undefined.
    // After initHost, also await any pending share loads queued by loadShare
    // modules during init(). When init() seeds the cache with the loadShare
    // module's _exports (getters returning undefined), the loadShare module
    // defers real value assignment to an initPromise.then() + ESM import
    // callback. Those promises are tracked in __mfModuleCache.pendingShareLoads
    // so the bootstrap can await them before importing the entry, preventing
    // a race where the entry renders before the ESM import resolves.
    const pendingShareLoadsAwait = `
  if (__mfModuleCache.pendingShareLoads) {
    await Promise.all(__mfModuleCache.pendingShareLoads);
  }`;

    const importCode = `
(async () => {
  const __mfHostInit = await ${importExpression(initSrc)};
  await __mfHostInit.__tla;
  const { initHost } = __mfHostInit;
  ${preloadBlock}${pendingShareLoadsAwait}
})().then(() => ${importExpression(entrySrc)});
`;

    return [getRuntimeModuleCacheBootstrapCode(), importHelper, importCode].join('\n');
  }

  function getSystemBootstrapSource(initSrc: string, entrySrc: string) {
    return getBootstrapSource(initSrc, entrySrc, true);
  }

  function injectHtml() {
    return inject === 'html' && (htmlFilePath || hasPackageDependency('@sveltejs/kit'));
  }

  function injectEntry() {
    if (inject === 'html' && hasPackageDependency('@sveltejs/kit')) return false;
    return inject === 'entry' || !htmlFilePath;
  }

  function normalizeDevHtmlProxyId(id: string) {
    return decodeViteId(id).replace(/^\0/, '');
  }

  function normalizeModuleId(id: string) {
    return normalizePathForImport(id.split('?')[0]);
  }

  function resolveProjectId(id: string) {
    if (id.startsWith('\0') || id.startsWith('virtual:')) return normalizeModuleId(id);
    return normalizeModuleId(path.isAbsolute(id) ? id : path.resolve(viteConfig.root, id));
  }

  function isFederationInternalVirtualId(id: string) {
    const normalized = decodeViteId(id).replace(/^\0+/, '');
    return (
      normalized.includes('virtual:mf:') || /__(?:loadShare|prebuild|loadRemote)__/.test(normalized)
    );
  }

  function addEntryFile(file: string) {
    const normalized = normalizeModuleId(file);
    if (!entryFiles.includes(normalized)) entryFiles.push(normalized);
  }

  function addHtmlScriptEntries(htmlPath: string) {
    if (!fs.existsSync(htmlPath)) return;
    const htmlContent = fs.readFileSync(htmlPath, 'utf-8');
    const scriptRegex =
      /<script\b(?=[^>]*\btype=["']module["'])(?=[^>]*\bsrc=["']([^"']+)["'])[^>]*>/gi;
    let match: RegExpExecArray | null;

    while ((match = scriptRegex.exec(htmlContent)) !== null) {
      const scriptSrc = stripQueryAndHash(match[1]);
      if (/^(?:[a-z]+:)?\/\//i.test(scriptSrc)) continue;
      addEntryFile(scriptSrc);
      const scriptPath = scriptSrc.startsWith('/')
        ? path.resolve(viteConfig.root, scriptSrc.slice(1))
        : path.resolve(path.dirname(htmlPath), scriptSrc);
      addEntryFile(scriptPath);
    }
  }

  function addEntryRemoteImports(entrySrc: string) {
    if (!federationOptions || /^(?:[a-z]+:)?\/\//i.test(entrySrc)) return;
    const file = path.resolve(viteConfig.root, stripQueryAndHash(entrySrc).replace(/^\//, ''));
    if (!fs.existsSync(file)) return;
    const code = fs.readFileSync(file, 'utf-8');
    for (const source of findModuleImportSources(code)) {
      const remote = Object.keys(federationOptions.remotes).find(
        (name) => source === name || source.startsWith(`${name}/`)
      );
      if (remote) {
        addUsedRemote(remote, source, federationOptions);
      }
    }
  }

  return [
    {
      name: 'add-entry',
      apply: 'serve',
      config(_config, { command }) {
        _command = command;
      },
      configResolved(config) {
        viteConfig = config;
        const resolvedEntryPath = getEntryPath();
        if (resolvedEntryPath.startsWith('virtual:mf')) {
          devEntryPath = config.base + VITE_ID_PREFIX.slice(1) + resolvedEntryPath;
        } else {
          // Convert absolute filesystem path to root-relative URL path.
          // On Windows, naive drive-letter stripping leaves the full directory
          // tree in the URL (e.g. /Repositories/.../node_modules/...) causing 404s.
          // Instead, compute the path relative to Vite's project root.
          const normalized = normalizePathForImport(resolvedEntryPath);
          const root = normalizePathForImport(config.root).replace(/\/$/, '');
          const relativePath = normalized.startsWith(root + '/')
            ? normalized.slice(root.length)
            : '/' + normalized.replace(/^[A-Za-z]:[\\/]/, '');
          devEntryPath = config.base + relativePath.replace(/^\//, '');
        }
        skipTransformIds = new Set(skipTransformFor.map(resolveProjectId));
      },
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const rawUrl = req.url?.split('#')[0] ?? '';
          const proxyId = normalizeDevHtmlProxyId(rawUrl.split('?')[0]);
          if (proxyId === DEV_HTML_PROXY_PREFIX.slice(0, -1)) {
            const query = rawUrl.slice(rawUrl.indexOf('?') + 1);
            const params = new URLSearchParams(query);
            const initSrc = params.get('init');
            const entrySrc = params.get('entry');
            if (initSrc && entrySrc) {
              const withBase = (src: string) => viteConfig.base + src.replace(/^\//, '');
              res.statusCode = 200;
              res.setHeader('Content-Type', 'application/javascript');
              res.end(getBootstrapSource(withBase(initSrc), withBase(entrySrc)));
              return;
            }
          }
          if (!fileName) {
            next();
            return;
          }
          const devFileName = resolveDevHashEntryFileName(fileName);
          if (
            devFileName !== fileName &&
            req.url?.startsWith((viteConfig.base + devFileName).replace(/^\/?/, '/'))
          ) {
            req.url = req.url.replace(devFileName, fileName);
          }
          if (req.url && req.url.startsWith((viteConfig.base + fileName).replace(/^\/?/, '/'))) {
            req.url = devEntryPath;
          }
          next();
        });
      },
      transformIndexHtml: {
        // Run before Vite's devHtmlHook so we see the original HTML.
        // devHtmlHook converts inline <script type="module"> tags into
        // external proxy modules; if we ran after it, rewriteEntryScripts
        // would mistakenly rewrite those proxied inline scripts too (#571).
        order: 'pre',
        handler(c) {
          const shouldWrapEntryHtml = _command === 'serve' && inject === 'entry' && waitsForInit;
          if (!injectHtml() && !shouldWrapEntryHtml) return;
          clientInjected = true;
          // Normalize all paths to root-relative (without base) before storing
          // in query params. devHtmlHook runs after pre hooks and prepends base
          // to script src attributes automatically, and Vite's server-side import
          // resolver also handles base — so query params must be base-free.
          // Note: originalSrc may or may not include the base depending on the
          // user's HTML (#590), so we normalize both directions uniformly.
          const base = viteConfig.base.replace(/\/$/, '');
          const stripBase = (p: string) =>
            base && p.startsWith(base + '/') ? p.slice(base.length) : p;
          const html = rewriteEntryScripts(c, (originalSrc) => {
            addEntryRemoteImports(stripBase(originalSrc));
            const query = new URLSearchParams({
              init: sanitizeDevEntryPath(stripBase(devEntryPath)),
              entry: sanitizeDevEntryPath(stripBase(originalSrc)),
            }).toString();
            return toViteEncodedId(`${DEV_HTML_PROXY_PREFIX}${query}`);
          });
          return html === c ? injectEntryScript(c, stripBase(devEntryPath)) : html;
        },
      },
      resolveId(id) {
        const normalizedId = normalizeDevHtmlProxyId(id);
        if (normalizedId.startsWith(DEV_HTML_PROXY_PREFIX)) {
          return id;
        }
      },
      load(id) {
        const normalizedId = normalizeDevHtmlProxyId(id);
        if (!normalizedId.startsWith(DEV_HTML_PROXY_PREFIX)) return;
        const params = new URLSearchParams(normalizedId.slice(DEV_HTML_PROXY_PREFIX.length));
        const initSrc = params.get('init');
        const entrySrc = params.get('entry');
        if (!initSrc || !entrySrc) return;
        return getBootstrapSource(initSrc, entrySrc);
      },
      transform(code, id) {
        if (id.includes('node_modules') || inject !== 'html' || htmlFilePath) {
          return;
        }

        if (id.includes('.svelte-kit') && id.includes('internal.js')) {
          return code.replace(
            /<head>/g,
            '<head><script type=\\"module\\" src=\\"' +
              sanitizeDevEntryPath(devEntryPath) +
              '\\"></script>'
          );
        }
      },
    },
    {
      name: 'add-entry',
      enforce: 'post',
      // In Vite 8 multi-environment setups (e.g. TanStack Start via Vinxi),
      // each environment has its own plugin pipeline. Without applyToEnvironment,
      // this plugin only runs in the default environment and the transform hook
      // never fires for modules in the client or ssr environments. Returning
      // true makes this plugin active in all environments so the transform (and
      // therefore bootstrap injection) fires wherever the client entry is processed.
      applyToEnvironment() {
        return true;
      },
      config(config) {
        patchHashEntryFileNames(config, entryName, fileName);
      },
      configResolved(config) {
        viteConfig = config;
        skipTransformIds = new Set(skipTransformFor.map(resolveProjectId));

        // In Vite 8 multi-environment mode this hook fires once per environment.
        // Only populate entryFiles from the 'client' environment — reading it from
        // 'ssr' would overwrite entryFiles with the server input (e.g. Nitro's
        // SSR entry) and break client injection detection for frameworks like
        // TanStack Start that set rollupOptions.input per-environment.
        // `this.environment` is Vite 8+ only. In Vite 5–7, `this` may be
        // undefined/null in strict mode, so guard before property access.
        const ctx = this as unknown;
        const envName = (
          ctx != null && typeof ctx === 'object'
            ? (ctx as Record<string, unknown>)['environment']
            : undefined
        ) as { name?: string } | undefined;
        if (envName?.name && envName.name !== 'client') return;
        const inputOptions = getBuildInput(config);

        if (!inputOptions) {
          htmlFilePath = path.resolve(config.root, 'index.html');
        } else if (typeof inputOptions === 'string') {
          entryFiles = [resolveProjectId(inputOptions)];
        } else if (Array.isArray(inputOptions)) {
          entryFiles = inputOptions.map(resolveProjectId);
        } else if (typeof inputOptions === 'object') {
          entryFiles = Object.values(inputOptions).map((input) => resolveProjectId(String(input)));
        }

        if (entryFiles.length > 0) {
          htmlFilePath = getFirstHtmlEntryFile(entryFiles);
        }

        if (htmlFilePath) {
          addHtmlScriptEntries(htmlFilePath);
        }
      },
      buildStart() {
        if (_command === 'serve') return;
        if (skipSvelteKitSsrBuild()) return;
        // Skip Nitro's "ssr" environment — it reads all emitted entry chunks to
        // detect the SSR request handler, and picks up hostInit / remoteEntry
        // instead of the real framework SSR entry, causing
        // "mod.fetch is not a function". Other SSR environments (e.g. Vinext's
        // RSC environments) must still emit their entry chunks normally.
        const environmentName = (this as { environment?: { name?: string } }).environment?.name;
        if (environmentName === 'ssr') return;
        const hasHash = fileName?.includes?.('[hash');
        const emitFileOptions: any = {
          name: entryName,
          type: 'chunk',
          id: getEntryPath(),
          preserveSignature: 'strict',
        };
        if (!hasHash) {
          emitFileOptions.fileName = fileName;
        }
        emitFileId = this.emitFile(emitFileOptions);
        if (htmlFilePath) {
          addHtmlScriptEntries(htmlFilePath);
        }
      },
      generateBundle(_options, bundle) {
        if (skipSvelteKitSsrBuild()) return;
        if (!injectHtml()) return;
        if (!emitFileId) return;
        const htmlFileNames = Object.keys(bundle).filter((fileName) => fileName.endsWith('.html'));
        if (htmlFileNames.length === 0) return;
        const file = this.getFileName(emitFileId);
        emittedFileName = file;
        // Derive bootstrapDir from the emitted hostInit file path.
        // entryFileNames is normalized away by Vite/Rolldown before plugins
        // can read it, so we extract the directory from the actual output path.
        const lastSlash = file.lastIndexOf('/');
        bootstrapDir = lastSlash !== -1 ? file.slice(0, lastSlash + 1) : '';
        // Helper to resolve path with proper renderBuiltUrl handling
        const resolvePath = (builtFileName: string, htmlFileName: string): string => {
          if (!viteConfig.experimental?.renderBuiltUrl) {
            return viteConfig.base + builtFileName;
          }

          const result = viteConfig.experimental.renderBuiltUrl(builtFileName, {
            hostId: htmlFileName,
            hostType: 'html',
            type: 'asset',
            ssr: false,
          });

          // Handle return types
          if (typeof result === 'string') {
            return result;
          }

          if (result && typeof result === 'object') {
            if ('runtime' in result) {
              // Runtime code cannot be used in <script src="">
              mfWarn(
                'renderBuiltUrl returned runtime code for HTML injection. ' +
                  'Runtime code cannot be used in <script src="">. Falling back to base path.'
              );
              return viteConfig.base + builtFileName;
            }
            if (result.relative) {
              return builtFileName;
            }
          }

          // Fallback for undefined or unexpected values
          return viteConfig.base + builtFileName;
        };

        // Strip Vite base before rebasing — paths in HTML include the base
        // prefix (e.g. "/app/static/js/hostInit.js" with base="/app/"),
        // but rebaseImport works against the output directory structure
        // (e.g. "static/js/"), which is relative to the build root.
        const basePrefix = viteConfig.base?.replace(/\/$/, '') ?? '';
        const stripBase = (p: string) =>
          basePrefix && p.startsWith(basePrefix + '/') ? p.slice(basePrefix.length) : p;

        let bootstrapIndex = 0;
        // Process each HTML file
        for (const fileName of htmlFileNames) {
          let htmlAsset = bundle[fileName];
          if (htmlAsset.type === 'chunk') return;

          let htmlContent = htmlAsset.source.toString() || '';
          const initPath = resolvePath(file, fileName);
          const scriptRegex =
            /<script\b(?=[^>]*\btype=["']module["'])(?=[^>]*\bsrc=["']([^"']+)["'])[^>]*>\s*<\/script>/gi;
          let rewritten = false;
          htmlContent = htmlContent.replace(scriptRegex, (scriptTag, entrySrc) => {
            rewritten = true;
            const strippedInit = stripBase(initPath);
            const strippedEntry = stripBase(entrySrc);
            const rebasedInitPath = bootstrapDir
              ? rebaseImport(strippedInit, bootstrapDir)
              : initPath;
            const rebasedEntrySrc = bootstrapDir
              ? rebaseImport(strippedEntry, bootstrapDir)
              : entrySrc;
            const bootstrapSource = getSystemBootstrapSource(rebasedInitPath, rebasedEntrySrc);
            // Content-hash the bootstrap filename so browsers/CDNs invalidate
            // the cache on deploy. Without a hash the file ships as
            // `mf-entry-bootstrap-0.js` and stale caches serve the old
            // bootstrap, breaking app load after a deploy.
            const bootstrapHash = createHash('sha256')
              .update(bootstrapSource)
              .digest('hex')
              .slice(0, 8);
            const bootstrapFileName = `${bootstrapDir}mf-entry-bootstrap-${bootstrapIndex++}-${bootstrapHash}.js`;
            const bootstrapRef = this.emitFile({
              type: 'asset',
              fileName: bootstrapFileName,
              source: bootstrapSource,
            });
            const bootstrapPath = viteConfig.base + this.getFileName(bootstrapRef);
            return scriptTag.replace(entrySrc, bootstrapPath);
          });

          if (!rewritten) {
            const svelteKitHtml = rewriteSvelteKitInlineStart(htmlContent, initPath);
            if (svelteKitHtml !== htmlContent) {
              htmlContent = svelteKitHtml;
            } else {
              const scriptContent = `
          <script type="module" src="${initPath}"></script>
        `;
              htmlContent = htmlContent.replace('<head>', `<head>${scriptContent}`);
            }
          }
          if (waitsForInit && viteConfig.build.modulePreload !== false) {
            htmlContent = injectHostInitPreloads(htmlContent, bundle, (builtFileName) =>
              resolvePath(builtFileName, fileName)
            );
          }
          htmlAsset.source = htmlContent;
        }
      },
      closeBundle() {
        if (_command === 'serve' || skipSvelteKitSsrBuild()) {
          return;
        }

        let attempts = 0;
        const retry = () => {
          attempts += 1;
          if (!patchSvelteKitStaticHtml() && attempts < 20) setTimeout(retry, 50);
        };
        setTimeout(retry, 0);
      },
      transform(code, id) {
        if (skipSvelteKitSsrBuild()) return;
        if (isSvelteKitServerModule(id)) return;
        if (hasEntryBootstrapParam(id)) return;
        if (normalizeModuleId(id).endsWith('.html')) return;
        const projectId = resolveProjectId(id);
        if (skipTransformIds.has(projectId)) return;
        // Only inject into client-side modules. In Vite 8 multi-environment mode
        // this transform also runs for ssr/server environments — injecting there
        // would set clientInjected=true and prevent the real client injection.
        const transformCtx = this as unknown;
        const transformEnv = (
          transformCtx != null && typeof transformCtx === 'object'
            ? (transformCtx as Record<string, unknown>)['environment']
            : undefined
        ) as { name?: string } | undefined;
        if (transformEnv?.name && transformEnv.name !== 'client') return;
        const isVinext = hasPackageDependency('vinext');
        if (
          isVinext &&
          inject === 'html' &&
          id.includes('virtual:vite-rsc/remove-duplicate-server-css')
        ) {
          const namespaceReactImport = `import * as React from 'react';`;
          if (code.includes(namespaceReactImport)) return;
          const rewritten = code.replace(
            /import\s+React\s+from\s+['"]react['"];?/,
            namespaceReactImport
          );
          return rewritten === code ? undefined : mapCodeToCodeWithSourcemap(rewritten);
        }

        if (
          isVinext &&
          inject === 'html' &&
          (id.includes('virtual:vite-rsc/entry-browser') ||
            id.includes('virtual:vinext-app-browser-entry'))
        ) {
          const injection = `import ${JSON.stringify(getEntryPath())};\n`;
          if (code.includes(injection.trim())) {
            clientInjected = true;
            return;
          }
          clientInjected = true;
          return mapCodeToCodeWithSourcemap(injection + code);
        }

        const isNuxtMountEntry =
          _command === 'serve' &&
          inject === 'entry' &&
          waitsForInit &&
          !clientInjected &&
          /(?:^|\/)nuxt\/dist\/app\/entry\.js(?:\?|$)/.test(id) &&
          code.includes('vueApp.mount(vueAppRootContainer);');
        if (isNuxtMountEntry) {
          clientInjected = true;
          const injection = `await import(${JSON.stringify(getEntryPath())}).then(({ initHost }) => initHost());\n      `;
          return mapCodeToCodeWithSourcemap(
            code.replace(
              'vueApp.mount(vueAppRootContainer);',
              `${injection}vueApp.mount(vueAppRootContainer);`
            )
          );
        }

        // SSR hosts without index.html (Nitro, TanStack Start) and
        // hostInitInjectLocation:'entry' have no rollup input in dev. Match the
        // client module that hydrates/mounts the app so host init runs before
        // hydrateRoot / app.mount — required for @module-federation/bridge-*
        // remotes that call getInstance() on first render. Covers React
        // (hydrateRoot / createRoot / ReactDOM.render) and Vue clients. Vue
        // entries frequently mount via `app.mount('#app')` while the
        // createApp/createSSRApp call lives in a separate module, so match a
        // selector-string mount on its own as well as a co-located createApp.
        const isHydrationEntryFallback =
          inject === 'entry' &&
          entryFiles.length === 0 &&
          (!htmlFilePath || !fs.existsSync(htmlFilePath)) &&
          !clientInjected &&
          !isFederationInternalVirtualId(id) &&
          !id.includes('node_modules') &&
          (id.startsWith('\0') || /\.(js|ts|mjs|vue|jsx|tsx)(\?|$)/.test(id)) &&
          (/hydrateRoot|createRoot|ReactDOM\.render/.test(code) ||
            /\.mount\s*\(\s*['"#]/.test(code) ||
            (/\.mount\s*\(/.test(code) && /createSSRApp|createApp/.test(code)));

        const isNuxtEntryAsyncModule =
          /(?:^|\/)nuxt\/dist\/app\/entry\.async\.js(?:\?|$)/.test(id) && code.includes('entry();');
        const isNuxtClientEntryFallback =
          _command === 'serve' &&
          inject === 'entry' &&
          (!htmlFilePath || !fs.existsSync(htmlFilePath)) &&
          !clientInjected &&
          !hasEntryBootstrapParam(id) &&
          !id.includes('node_modules/.vite') &&
          isNuxtEntryAsyncModule &&
          !entryFiles.some((file) => projectId === file);

        // Nuxt dev loads entry.async.js as the HTML module script; wrapping it in
        // the async host-init bootstrap sets clientInjected before entry.js is
        // processed, so the mount-time init injection never runs and Vue stays inert.
        const skipNuxtDevEntryAsyncInject = _command === 'serve' && isNuxtEntryAsyncModule;

        const shouldInject =
          !skipNuxtDevEntryAsyncInject &&
          (injectedTransformIds.has(projectId) ||
            (injectEntry() && entryFiles.some((file) => projectId === file)) ||
            // Fallback for SSR frameworks (e.g. Nuxt) that bypass transformIndexHtml.
            (_command === 'serve' &&
              inject === 'html' &&
              !isVinext &&
              !clientInjected &&
              !skipHtmlDevFallback &&
              !id.startsWith('\0') &&
              !id.includes('node_modules') &&
              /\.(js|ts|mjs|vue|jsx|tsx)(\?|$)/.test(id)) ||
            // Fallback for frameworks (e.g. TanStack Start) that manage their own
            // client entry and never populate rollupOptions.input in dev. Inject
            // into the module that mounts/hydrates the React app — identified by
            // the presence of hydrateRoot, createRoot, or ReactDOM.render calls.
            // TanStack Start inlines client.tsx into a virtual entry module, so
            // we also match virtual IDs (id.startsWith('\0')) that contain the
            // hydration call.
            isHydrationEntryFallback ||
            isNuxtClientEntryFallback);
        if (shouldInject) {
          clientInjected = true;
          injectedTransformIds.add(projectId);
          // Non-hostInit injections only need a side-effect import. Host-init
          // bootstrap must await initHost() before the app entry runs — in both
          // build and serve — so bridge-react remotes do not hit
          // "Module Federation runtime is not initialized" on first paint.
          if (!waitsForInit) {
            const injection = `import ${JSON.stringify(getEntryPath())};\n`;
            return mapCodeToCodeWithSourcemap(injection + code);
          }
          const entrySrc = id.includes('?')
            ? `${id}&${ENTRY_BOOTSTRAP_QUERY.slice(1)}`
            : `${id}${ENTRY_BOOTSTRAP_QUERY}`;
          const bootstrap = getBootstrapSource(getEntryPath(), entrySrc, false, {
            skipRemotePreload: _command === 'serve' && isNuxtEntryAsyncModule,
          });
          return mapCodeToCodeWithSourcemap(bootstrap);
        }
      },
    },
  ];
};

export default addEntry;
