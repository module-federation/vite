import * as fs from 'fs';
import * as path from 'pathe';
import type { Plugin } from 'vite';
import { mapCodeToCodeWithSourcemap } from '../utils/mapCodeToCodeWithSourcemap';

import {
  injectEntryScript,
  rewriteEntryScripts,
  sanitizeDevEntryPath,
} from '../utils/htmlEntryUtils';
import { mfWarn } from '../utils/logger';
import type { NormalizedModuleFederationOptions } from '../utils/normalizeModuleFederationOptions';
import { getNormalizeModuleFederationOptions } from '../utils/normalizeModuleFederationOptions';
import { hasPackageDependency } from '../utils/packageUtils';
import { getUsedRemotesMap } from '../virtualModules/virtualRemotes';
import { getRuntimeModuleCacheBootstrapCode } from '../virtualModules/virtualRuntimeInitStatus';

interface AddEntryOptions {
  entryName: string;
  entryPath: string | (() => string);
  fileName?: string;
  inject?: NormalizedModuleFederationOptions['hostInitInjectLocation'];
  /** When true, skip the SSR fallback bootstrap wrapper (used for MF remotes whose HTML is never browser-requested). */
  forceClientInjected?: boolean;
  skipTransformFor?: string[];
}

function getFirstHtmlEntryFile(entryFiles: string[]): string | undefined {
  return entryFiles.find((file) => file.endsWith('.html'));
}

function stripQueryAndHash(file: string) {
  return file.split(/[?#]/)[0];
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
}: AddEntryOptions): Plugin[] => {
  const DEV_HTML_PROXY_PREFIX = 'virtual:mf-html-entry-proxy?';
  const ENTRY_BOOTSTRAP_QUERY = '?mf-entry-bootstrap';
  const waitsForInit = entryName === 'hostInit';
  const getEntryPath = () => (typeof entryPath === 'function' ? entryPath() : entryPath);
  let devEntryPath = '';
  let entryFiles: string[] = [];
  let htmlFilePath: string | undefined;
  let _command: string;
  let emitFileId: string;
  let viteConfig: any;
  let clientInjected = forceClientInjected ?? false;
  let emittedFileName: string | undefined;
  let skipTransformIds = new Set<string>();

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

  function rewriteSvelteKitInlineStart(html: string, initPath: string) {
    return html.replace(/<script>([\s\S]*?)<\/script>/gi, (scriptTag, body) => {
      if (!body.includes('kit.start(app, element);') || !body.includes('Promise.all([')) {
        return scriptTag;
      }

      const blockStart = body.indexOf('{');
      const blockEnd = body.lastIndexOf('}');
      if (blockStart === -1 || blockEnd <= blockStart) return scriptTag;

      const wrapped =
        body.slice(0, blockStart + 1) +
        `
(async () => {
  await import(${JSON.stringify(initPath)}).then(({ initHost }) => initHost());
` +
        body.slice(blockStart + 1, blockEnd) +
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
    const relative = path.relative(path.dirname(fromFile), targetFile).replace(/\\/g, '/');
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
      getNormalizeModuleFederationOptions()?.shareStrategy !== 'loaded-first';

    // Keep only sub-path entries (e.g. "remote/App"); skip bare remote keys
    // ("remote" or scoped "@scope/remote") since they refer to the container
    // itself, not an exposed module. The previous `includes('/')` check
    // incorrectly matched scoped names like "@scope/remote".
    const remotePreloads = shouldPreloadRemotes
      ? Object.entries(getUsedRemotesMap())
          .flatMap(([remoteKey, remotes]) =>
            Array.from(remotes).filter((remote) => remote !== remoteKey)
          )
          .sort()
          .map((remote) => `__mfPreloadRemote(${JSON.stringify(remote)})`)
          .join(',')
      : '';

    const preloadBlock = remotePreloads
      ? `
  const runtime = await initHost();
  const __mfPreloadRemote = (remote) => {
    const pendingKey = "__mf_pending__" + remote;
    if (!__mfModuleCache.remote[pendingKey]) {
      __mfModuleCache.remote[pendingKey] = runtime.loadRemote(remote)
        .then((mod) => {
          __mfModuleCache.remote[remote] = mod;
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

    const importCode = `
(async () => {
  const { initHost } = await ${importExpression(initSrc)};
  ${preloadBlock}
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
    return id
      .replace(/^\0/, '')
      .replace(/^\/@id\//, '')
      .replace(/^__x00__/, '');
  }

  function normalizeModuleId(id: string) {
    return id.split('?')[0].replace(/\\/g, '/');
  }

  function resolveProjectId(id: string) {
    if (id.startsWith('\0') || id.startsWith('virtual:')) return normalizeModuleId(id);
    return normalizeModuleId(path.isAbsolute(id) ? id : path.resolve(viteConfig.root, id));
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
          devEntryPath = config.base + '@id/' + resolvedEntryPath;
        } else {
          // Convert absolute filesystem path to root-relative URL path.
          // On Windows, naive drive-letter stripping leaves the full directory
          // tree in the URL (e.g. /Repositories/.../node_modules/...) causing 404s.
          // Instead, compute the path relative to Vite's project root.
          const normalized = resolvedEntryPath.replace(/\\\\?/g, '/');
          const root = config.root.replace(/\\\\?/g, '/').replace(/\/$/, '');
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
              res.statusCode = 200;
              res.setHeader('Content-Type', 'application/javascript');
              res.end(getBootstrapSource(initSrc, entrySrc));
              return;
            }
          }
          if (!fileName) {
            next();
            return;
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
            const query = new URLSearchParams({
              init: sanitizeDevEntryPath(stripBase(devEntryPath)),
              entry: sanitizeDevEntryPath(stripBase(originalSrc)),
            }).toString();
            return `/@id/__x00__${DEV_HTML_PROXY_PREFIX}${query}`;
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
          entryFiles = [normalizeModuleId(inputOptions)];
        } else if (Array.isArray(inputOptions)) {
          entryFiles = inputOptions.map(normalizeModuleId);
        } else if (typeof inputOptions === 'object') {
          entryFiles = Object.values(inputOptions).map((input) => normalizeModuleId(String(input)));
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
        // Helper to resolve path with proper renderBuiltUrl handling
        const resolvePath = (htmlFileName: string): string => {
          if (!viteConfig.experimental?.renderBuiltUrl) {
            return viteConfig.base + file;
          }

          const result = viteConfig.experimental.renderBuiltUrl(file, {
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
              return viteConfig.base + file;
            }
            if (result.relative) {
              return file;
            }
          }

          // Fallback for undefined or unexpected values
          return viteConfig.base + file;
        };

        let bootstrapIndex = 0;
        // Process each HTML file
        for (const fileName of htmlFileNames) {
          let htmlAsset = bundle[fileName];
          if (htmlAsset.type === 'chunk') return;

          let htmlContent = htmlAsset.source.toString() || '';
          const initPath = resolvePath(fileName);
          const scriptRegex =
            /<script\b(?=[^>]*\btype=["']module["'])(?=[^>]*\bsrc=["']([^"']+)["'])[^>]*>\s*<\/script>/gi;
          let rewritten = false;
          htmlContent = htmlContent.replace(scriptRegex, (scriptTag, entrySrc) => {
            rewritten = true;
            const bootstrapFileName = `mf-entry-bootstrap-${bootstrapIndex++}.js`;
            const bootstrapRef = this.emitFile({
              type: 'asset',
              fileName: bootstrapFileName,
              source: getSystemBootstrapSource(initPath, entrySrc),
            });
            const bootstrapPath = viteConfig.base + this.getFileName(bootstrapRef);
            return scriptTag.replace(entrySrc, bootstrapPath);
          });

          if (!rewritten) {
            const svelteKitHtml = rewriteSvelteKitInlineStart(htmlContent, initPath);
            if (svelteKitHtml !== htmlContent) {
              htmlAsset.source = svelteKitHtml;
              continue;
            }
            const scriptContent = `
          <script type="module" src="${initPath}"></script>
        `;
            htmlContent = htmlContent.replace('<head>', `<head>${scriptContent}`);
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
        if (id.includes(ENTRY_BOOTSTRAP_QUERY)) return;
        if (normalizeModuleId(id).endsWith('.html')) return;
        if (skipTransformIds.has(resolveProjectId(id))) return;
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

        const isHydrationEntryFallback =
          inject === 'entry' &&
          entryFiles.length === 0 &&
          (!htmlFilePath || !fs.existsSync(htmlFilePath)) &&
          !clientInjected &&
          !id.includes('node_modules') &&
          (id.startsWith('\0') || /\.(js|ts|mjs|vue|jsx|tsx)(\?|$)/.test(id)) &&
          /hydrateRoot|createRoot|ReactDOM\.render/.test(code);

        const isNuxtEntryAsyncModule =
          /(?:^|\/)nuxt\/dist\/app\/entry\.async\.js(?:\?|$)/.test(id) && code.includes('entry();');
        const isNuxtClientEntryFallback =
          _command === 'serve' &&
          inject === 'entry' &&
          (!htmlFilePath || !fs.existsSync(htmlFilePath)) &&
          !clientInjected &&
          !id.includes('node_modules/.vite') &&
          isNuxtEntryAsyncModule &&
          !entryFiles.some((file) => resolveProjectId(id) === file);

        // Nuxt dev loads entry.async.js as the HTML module script; wrapping it in
        // the async host-init bootstrap sets clientInjected before entry.js is
        // processed, so the mount-time init injection never runs and Vue stays inert.
        const skipNuxtDevEntryAsyncInject = _command === 'serve' && isNuxtEntryAsyncModule;

        const shouldInject =
          !skipNuxtDevEntryAsyncInject &&
          ((injectEntry() && entryFiles.some((file) => resolveProjectId(id) === file)) ||
            // Fallback for SSR frameworks (e.g. Nuxt) that bypass transformIndexHtml.
            (_command === 'serve' &&
              inject === 'html' &&
              !isVinext &&
              !clientInjected &&
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
          // For the dev-mode entry fallback (inject:'entry' with no known entry
          // files), always use a simple import injection. The getBootstrapSource
          // wrapper is incompatible with SSR module evaluation — the async IIFE
          // it generates prevents the module from exporting synchronously.
          const usesDevEntryFallback =
            _command === 'serve' && inject === 'entry' && isHydrationEntryFallback;
          if (!waitsForInit || usesDevEntryFallback) {
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
