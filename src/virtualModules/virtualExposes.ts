import { NormalizedModuleFederationOptions } from '../utils/normalizeModuleFederationOptions';

const EXPOSES_CSS_MAP_PLACEHOLDER = '__MF_EXPOSES_CSS_MAP__';

export function getExposesCssMapPlaceholder() {
  return EXPOSES_CSS_MAP_PLACEHOLDER;
}

export function getVirtualExposesId(
  options: Pick<NormalizedModuleFederationOptions, 'name' | 'filename'>
) {
  const scopedKey = `${options.name}__${options.filename}`.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `virtual:mf-exposes:${scopedKey}`;
}

export function generateExposes(options: NormalizedModuleFederationOptions) {
  return `
    const cssAssetMap = ${JSON.stringify(options.bundleAllCSS ? EXPOSES_CSS_MAP_PLACEHOLDER : {})};
    const injectedCssHrefs = new Set();

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

          const existingLink = document.querySelector(
            \`link[rel="stylesheet"][data-mf-href="\${href}"]\`
          );
          if (existingLink) {
            return Promise.resolve();
          }

          return new Promise((resolve, reject) => {
            const link = document.createElement("link");
            link.rel = "stylesheet";
            link.href = href;
            link.setAttribute("data-mf-href", href);
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
        return `
        ${JSON.stringify(key)}: async () => {
          await injectCssAssets(${JSON.stringify(key)})
          const importModule = await import(${JSON.stringify(options.exposes[key].import)})
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
