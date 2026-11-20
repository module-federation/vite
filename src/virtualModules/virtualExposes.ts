import { NormalizedModuleFederationOptions } from '../utils/normalizeModuleFederationOptions';
import { generateReactIslandBrowserDefinition } from '../utils/reactIsland';
import { getRemoteVirtualModule } from './virtualRemotes';
import { getVirtualModuleScopeKey } from './virtualModuleScope';

const EXPOSES_CSS_MAP_PLACEHOLDER = '__MF_EXPOSES_CSS_MAP__';

export function getExposesCssMapPlaceholder() {
  return EXPOSES_CSS_MAP_PLACEHOLDER;
}

export function getVirtualExposesId(
  options: Pick<NormalizedModuleFederationOptions, 'internalName' | 'filename'>
) {
  return `virtual:mf-exposes:${getVirtualModuleScopeKey(options)}`;
}

export function generateExposes(
  options: NormalizedModuleFederationOptions,
  remoteDependencyMap: Record<string, string[]> = {},
  command = 'build',
  reactIslandExposes: ReadonlySet<string> = new Set()
) {
  const manualCssExposes = Object.keys(options.exposes).filter(
    (key) => options.exposes[key].cssInjection === 'manual'
  );
  return `
    const cssAssetMap = ${JSON.stringify(options.bundleAllCSS || manualCssExposes.length ? EXPOSES_CSS_MAP_PLACEHOLDER : {})};
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
${
  manualCssExposes.length
    ? `
      // cssInjection: 'manual' leaves placement to the expose (e.g. a ShadowRoot).
      if (${JSON.stringify(manualCssExposes)}.includes(exposeKey)) {
        window[${JSON.stringify(`css__${options.name}__`)} + exposeKey] = cssAssets.map(
          (cssAsset) => new URL(cssAsset, import.meta.url).href
        );
        return;
      }
${options.bundleAllCSS ? '' : '      return;\n'}`
    : ''
}
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
            link.onerror = () => {
              injectedCssHrefs.delete(href);
              link.remove();
              reject(new Error(\`[Module Federation] Failed to load CSS asset: \${href}\`));
            };
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
