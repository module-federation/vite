export function sanitizeDevEntryPath(devEntryPath: string): string {
  return devEntryPath.replace(/^[^:]+:([/\\])[/\\]?/, '$1').replace(/\\\\?/g, '/');
}

/**
 * Inlines the federation init import into existing module script tags to fix
 * the race condition (#396) where separate `<script type="module">` tags
 * don't guarantee execution order with top-level await.
 *
 * If no entry scripts are found, falls back to injecting a separate script tag.
 *
 * @example
 * // Before (two separate scripts, race condition):
 * //   <script type="module" src="/__mf__virtual/hostAutoInit.js"></script>
 * //   <script type="module" src="/src/main.js"></script>
 * // After (single inline script, sequential execution):
 * //   <script type="module">await import("/__mf__virtual/hostAutoInit.js");await import("/src/main.js");</script>
 */
export function inlineEntryScripts(html: string, initSrc: string): string {
  const src = sanitizeDevEntryPath(initSrc);
  // Match all <script ...>...</script> tags, then filter for type="module" with src
  const scriptTagRegex = /<script\s([^>]*)>\s*<\/script\s*>/gi;

  let hasEntry = false;
  const result = html.replace(scriptTagRegex, (match, attrs) => {
    if (!/type=["']module["']/i.test(attrs)) return match;
    const srcMatch = attrs.match(/\bsrc=["']([^"']+)["']/i);
    if (!srcMatch) return match;
    const originalSrc = srcMatch[1];
    if (originalSrc.includes('@vite/client')) return match;
    hasEntry = true;
    const attrsWithoutSrc = attrs.replace(/\s*\bsrc=["'][^"']+["']/i, '');
    return `<script ${attrsWithoutSrc}>await import(${JSON.stringify(src)});await import(${JSON.stringify(originalSrc)});</script>`;
  });

  if (hasEntry) return result;

  // Inject a separate script tag
  return html.replace('<head>', `<head><script type="module" src=${JSON.stringify(src)}></script>`);
}
