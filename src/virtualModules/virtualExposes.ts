import { NormalizedModuleFederationOptions } from '../utils/normalizeModuleFederationOptions';
import { generateReactIslandBrowserDefinition } from '../utils/reactIsland';
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
  command = 'build',
  reactIslandExposes: ReadonlySet<string> = new Set()
) {
  return `
    const cssAssetMap = ${JSON.stringify(options.bundleAllCSS ? EXPOSES_CSS_MAP_PLACEHOLDER : {})};
    const injectedCssHrefs = new Set();
    const exposeLoadPromises = new Map();

    // Shared and remote readiness is handled by explicit Promise barriers below
    // and by remoteEntry's pendingShareLoads barrier. Keep this map scoped to a
    // single expose: unrelated exposes must stay independent and load in parallel.
    function loadExposedModule(exposeKey, loader) {
      let load = exposeLoadPromises.get(exposeKey);
      if (!load) {
        load = Promise.resolve()
          .then(loader)
          .catch((error) => {
            exposeLoadPromises.delete(exposeKey);
            throw error;
          });
        exposeLoadPromises.set(exposeKey, load);
      }
      return load;
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
          const importModule = await loadExposedModule(
            ${JSON.stringify(key)},
            () => import(${JSON.stringify(options.exposes[key].import)})
          )
          const dependencyPending = importModule && importModule.__mf_remote_dependency_pending;
          if (dependencyPending && typeof dependencyPending.then === "function") {
            await dependencyPending;
          }
          const exportModule = {}
          Object.assign(exportModule, importModule)
          ${generateReactIslandBrowserDefinition(reactIslandExposes.has(key))}
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
