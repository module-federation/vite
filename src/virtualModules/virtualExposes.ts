import { NormalizedModuleFederationOptions } from '../utils/normalizeModuleFederationOptions';
import { getRemoteVirtualModule } from './virtualRemotes';

const EXPOSES_CSS_MAP_PLACEHOLDER = '__MF_EXPOSES_CSS_MAP__';

export function getExposesCssMapPlaceholder() {
  return EXPOSES_CSS_MAP_PLACEHOLDER;
}

export function getVirtualExposesId(
  options: Pick<NormalizedModuleFederationOptions, 'internalName' | 'filename'>
) {
  const scopedKey = `${options.internalName}__${options.filename}`.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `virtual:mf-exposes:${scopedKey}`;
}

export function generateExposes(
  options: NormalizedModuleFederationOptions,
  remoteDependencyMap: Record<string, string[]> = {},
  command = 'build'
) {
  return `
    const cssAssetMap = ${JSON.stringify(options.bundleAllCSS ? EXPOSES_CSS_MAP_PLACEHOLDER : {})};
    const injectedCssHrefs = new Set();
    let exposeLoadQueue = Promise.resolve();

    async function importExposedModule(loader) {
      const currentLoad = exposeLoadQueue.then(loader, loader);
      exposeLoadQueue = currentLoad.then(
        () => undefined,
        () => undefined
      );
      return currentLoad;
    }

    async function injectCssAssets(exposeKey) {
      if (typeof document === "undefined") {
        return;
      }

      // Replaced at build time with expose -> css asset paths.
      const cssAssets = cssAssetMap[exposeKey] || [];

      await Promise.all(
        cssAssets.map((cssAsset) => {
          const href = new URL(cssAsset, import.meta.url).href;

          // Same expose can be resolved multiple times in one page.
          if (injectedCssHrefs.has(href)) {
            return Promise.resolve();
          }
          injectedCssHrefs.add(href);

          // Check for any existing stylesheet with the same href, not just
          // MF-injected ones. This prevents duplicate <link> tags when Vite's
          // own CSS module injection or MF runtime's createLink has already
          // created a <link rel="stylesheet"> for the same URL.
          const existingLink = document.querySelector(
            \`link[rel="stylesheet"][href="\${href}"]\`
          );
          if (existingLink) {
            return Promise.resolve();
          }

          return new Promise((resolve, reject) => {
            const link = document.createElement("link");
            link.rel = "stylesheet";
            link.href = href;
            link.onload = () => resolve();
            link.onerror = () => reject(new Error(\`[Module Federation] Failed to load CSS asset: \${href}\`));
            document.head.appendChild(link);
          });
        })
      );
    }

    export default {
    ${Object.keys(options.exposes)
      .map((key) => {
        const remoteDependencyPreloads = (remoteDependencyMap[key] ?? [])
          .map((remoteId) => {
            const virtualRemote = getRemoteVirtualModule(
              remoteId,
              command,
              false,
              'unified',
              options
            );
            return `import(${JSON.stringify(virtualRemote.getImportId())})
            .then((mod) => mod.__mf_remote_pending)`;
          })
          .join(',');
        return `
        ${JSON.stringify(key)}: async () => {
          await injectCssAssets(${JSON.stringify(key)})
          await Promise.all([${remoteDependencyPreloads}])
          const importModule = await importExposedModule(
            () => import(${JSON.stringify(options.exposes[key].import)})
          )
          const dependencyPending = importModule && importModule.__mf_remote_dependency_pending;
          if (dependencyPending && typeof dependencyPending.then === "function") {
            await dependencyPending;
          }
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
}
