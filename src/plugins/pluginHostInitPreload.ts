/**
 * Injects `<link rel="modulepreload">` tags for the Module Federation host-init chunk chain.
 *
 * The MF bootstrap loads its init chain via runtime dynamic import() calls:
 *   mf-entry-bootstrap → hostInit → remoteEntry → _virtual_mf… → index
 *
 * Because each hop is a string-literal dynamic import inside the previous chunk, the
 * browser's preload scanner never sees them. On a cold cache this creates a serial
 * waterfall — each chunk can only start downloading after its parent has downloaded
 * AND executed. Vite preloads statically-analyzed deps but not this runtime-driven chain,
 * and the existing `module-federation-fix-preload` plugin is gated on `exposes`, so pure
 * hosts were left unoptimized.
 *
 * Adding `modulepreload` hints lets all four chunks fetch in parallel with the rest of
 * the entry. `modulepreload` only fetches and compiles (never executes), so the MF init
 * order is unchanged — only the network stalls are eliminated.
 */
import type { HtmlTagDescriptor, Plugin, Rollup } from 'vite';

// Chunks emitted by the MF bootstrap that the browser's preload scanner never sees,
// because they're loaded via runtime dynamic import() calls. Matching by Rollup chunk
// name (not the hashed filename) survives content-hash changes. `_virtual_mf*` is
// matched by prefix since it carries a generated app-specific suffix.
const HOST_INIT_CHUNKS: ReadonlyArray<{ label: string; match: (name: string) => boolean }> = [
  { label: 'hostInit', match: name => name === 'hostInit' },
  { label: 'remoteEntry', match: name => name === 'remoteEntry' },
  { label: '_virtual_mf*', match: name => name.startsWith('_virtual_mf') },
  { label: 'index', match: name => name === 'index' },
];

export function pluginHostInitPreload(): Plugin {
  return {
    name: 'module-federation-host-init-preload',
    enforce: 'post',
    apply: 'build',
    transformIndexHtml: {
      // Run after Vite's own build-html pass so ctx.bundle is populated and
      // Vite's preload links are already in `html` for dedup below.
      order: 'post',
      handler(html, ctx) {
        if (!ctx.bundle) return;

        const chunks = Object.values(ctx.bundle).filter(
          (c): c is Rollup.OutputChunk => c.type === 'chunk',
        );

        const matched: Rollup.OutputChunk[] = [];
        for (const { label, match } of HOST_INIT_CHUNKS) {
          const found = chunks.filter(c => match(c.name));
          if (found.length === 0) {
            console.warn(
              `[module-federation-host-init-preload] expected host-init chunk "${label}" not found — MF chunk names may have changed`,
            );
            continue;
          }
          matched.push(...found);
        }

        if (matched.length === 0) return;

        const tags = matched
          .map(c => `/${c.fileName}`)
          .filter(href => !html.includes(`href="${href}"`))
          .map(
            (href): HtmlTagDescriptor => ({
              tag: 'link',
              attrs: { rel: 'modulepreload', crossorigin: true, href },
              injectTo: 'head',
            }),
          );

        return tags.length > 0 ? tags : undefined;
      },
    },
  };
}
