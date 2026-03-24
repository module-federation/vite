/**
 * Transforms consumer-side imports of remote modules so that named exports
 * are accessible even when the bundler does not support syntheticNamedExports
 * (Rolldown / Vite 8+).
 *
 * The remote proxy module exports:
 *   export const __moduleExports = exportModule;   // full namespace
 *   export default exportModule.default ?? exportModule;  // unwrapped default
 *
 * This plugin rewrites consumer code:
 *   import { foo } from "remote/xxx"
 *     → import { __moduleExports as __mf_ns_0 } from "remote/xxx"; const { foo } = __mf_ns_0;
 *
 *   import("remote/xxx")
 *     → import("remote/xxx").then(…)  // spreads __moduleExports into namespace
 *
 * NOTE: `export * from "remote/xxx"` is not supported — Rolldown cannot
 * statically resolve the set of exported names from a federated remote at
 * build time.  Use explicit named re-exports instead.
 */
import MagicString from 'magic-string';
import type { Plugin } from 'vite';
import type { NormalizedModuleFederationOptions } from '../utils/normalizeModuleFederationOptions';
import { getIsRolldown } from '../utils/packageUtils';
import { loadWalk } from '../utils/loadWalk';
import { LOAD_REMOTE_TAG, LOAD_SHARE_TAG } from '../virtualModules';

const JS_EXTENSIONS_RE = /\.(?:[mc]?[jt]sx?|vue|svelte)(?:\?|$)/;

export function pluginRemoteNamedExports(options: NormalizedModuleFederationOptions): Plugin {
  const remoteNames = Object.keys(options.remotes);
  let counter = 0;
  let rolldown: boolean | undefined;

  function isRemoteImport(source: string): boolean {
    return remoteNames.some((name) => source === name || source.startsWith(name + '/'));
  }

  return {
    name: 'module-federation-remote-named-exports',
    enforce: 'pre',
    async transform(code: string, id: string) {
      // Lazily detect Rolldown on first transform call where this.meta is
      // guaranteed to be available.
      rolldown ??= getIsRolldown(this);
      if (!rolldown) return;
      if (remoteNames.length === 0) return;
      // Skip federation internal modules
      if (id.includes(LOAD_REMOTE_TAG) || id.includes(LOAD_SHARE_TAG)) return;
      // Only process JS-like files to avoid parsing CSS/JSON/etc.
      if (!JS_EXTENSIONS_RE.test(id)) return;
      // Quick bail-out: does the source mention any remote name?
      if (!remoteNames.some((name) => code.includes(name))) return;

      let ast: any;
      try {
        ast = this.parse(code);
      } catch {
        return;
      }

      const ms = new MagicString(code);
      const walk = await loadWalk();
      let changed = false;

      walk(ast, {
        enter(node: any) {
          // ── static imports ──────────────────────────────────────
          if (node.type === 'ImportDeclaration' && node.source?.value) {
            if (!isRemoteImport(node.source.value)) return;

            const specifiers = node.specifiers || [];
            const named = specifiers.filter((s: any) => s.type === 'ImportSpecifier');
            const defaultSpec = specifiers.find((s: any) => s.type === 'ImportDefaultSpecifier');
            const nsSpec = specifiers.find((s: any) => s.type === 'ImportNamespaceSpecifier');

            // default-only → already works, skip
            if (named.length === 0 && !nsSpec) return;

            const src = JSON.stringify(node.source.value);
            const nsId = `__mf_ns_${counter++}`;

            if (nsSpec && specifiers.length === 1) {
              // import * as ns from "remote/test"
              ms.overwrite(
                node.start,
                node.end,
                `import { __moduleExports as ${nsSpec.local.name} } from ${src};`
              );
            } else {
              const importParts: string[] = [];

              if (defaultSpec) importParts.push(`default as ${defaultSpec.local.name}`);

              importParts.push(`__moduleExports as ${nsId}`);

              const destructParts = named.map((s: any) => {
                const imported = s.imported.name ?? s.imported.value;
                const local = s.local.name;
                return imported === local ? local : `${imported}: ${local}`;
              });

              let rewrite = `import { ${importParts.join(', ')} } from ${src};`;

              if (destructParts.length > 0)
                rewrite += `\nconst { ${destructParts.join(', ')} } = ${nsId};`;

              ms.overwrite(node.start, node.end, rewrite);
            }
            changed = true;
          }

          // ── re-exports: export { foo } from "remote/test" ──────
          if (
            node.type === 'ExportNamedDeclaration' &&
            node.source?.value &&
            isRemoteImport(node.source.value)
          ) {
            const specifiers = node.specifiers || [];

            if (specifiers.length === 0) return;

            const src = JSON.stringify(node.source.value);
            const nsId = `__mf_ns_${counter++}`;

            const vars = specifiers.map((s: any) => {
              const local = s.local.name ?? s.local.value;
              const exported = s.exported.name ?? s.exported.value;
              const tmp = `__mf_re_${counter++}`;
              return { local, exported, tmp };
            });

            const importLine = `import { __moduleExports as ${nsId} } from ${src};`;
            const varLines = vars
              .map((v: any) => `const ${v.tmp} = ${nsId}[${JSON.stringify(v.local)}];`)
              .join('\n');
            const exportLine = `export { ${vars
              .map((v: any) => `${v.tmp} as ${v.exported}`)
              .join(', ')} };`;

            ms.overwrite(node.start, node.end, `${importLine}\n${varLines}\n${exportLine}`);
            changed = true;
          }

          // ── export * from "remote/test" (unsupported) ──────────
          if (
            node.type === 'ExportAllDeclaration' &&
            node.source?.value &&
            isRemoteImport(node.source.value)
          ) {
            this.skip();
            console.warn(
              `[module-federation] "export * from '${node.source.value}'" is not supported ` +
                `with Rolldown — use explicit named re-exports instead. (${id})`
            );
          }

          // ── dynamic imports: import("remote/test") ─────────────
          if (node.type === 'ImportExpression') {
            const source = node.source;

            if (
              source.type !== 'Literal' &&
              source.type !== 'StringLiteral' &&
              source.type !== 'TemplateLiteral'
            )
              return;

            const value =
              source.type === 'TemplateLiteral'
                ? source.quasis?.length === 1
                  ? source.quasis[0].value?.cooked
                  : undefined
                : source.value;

            if (!value || !isRemoteImport(value)) return;

            const original = code.slice(node.start, node.end);
            const wrapper =
              `${original}.then(function(__mf_m__){` +
              `if(!__mf_m__||!__mf_m__.__moduleExports)return __mf_m__;` +
              `var __mf_ns__=Object.create(null);` +
              `Object.defineProperty(__mf_ns__,Symbol.toStringTag,{value:"Module"});` +
              `var __mf_e__=__mf_m__.__moduleExports;` +
              `Object.keys(__mf_e__).forEach(function(k){if(k!=="__esModule")__mf_ns__[k]=__mf_e__[k]});` +
              `if("default" in __mf_m__)__mf_ns__.default=__mf_m__.default;` +
              `return __mf_ns__})`;

            ms.overwrite(node.start, node.end, wrapper);
            changed = true;
          }
        },
      });

      if (!changed) return;

      return {
        code: ms.toString(),
        map: ms.generateMap({ hires: true }),
      };
    },
  };
}
