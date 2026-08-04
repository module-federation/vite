import { readFileSync } from 'node:fs';

const REACT_DEVELOPMENT_RUNTIME =
  /[\\/]react[\\/]cjs[\\/]react(?:-jsx-(?:dev-)?runtime)?\.development\.js$/;
const UNSAFE_GET_OWNER = 'return null === dispatcher ? null : dispatcher.getOwner();';
const SAFE_GET_OWNER =
  'return typeof dispatcher?.getOwner === "function" ? dispatcher.getOwner() : null;';

export const REACT_MIXED_MODE_ROLLDOWN_PLUGIN = 'module-federation:react-mixed-mode-rolldown';
export const REACT_MIXED_MODE_ESBUILD_PLUGIN = 'module-federation:react-mixed-mode-esbuild';

export function patchReactDevelopmentRuntime(code: string, id: string): string | undefined {
  if (!REACT_DEVELOPMENT_RUNTIME.test(id)) return;
  const patched = code.replaceAll(UNSAFE_GET_OWNER, SAFE_GET_OWNER);
  return patched === code ? undefined : patched;
}

export function createRolldownReactMixedModeGuard() {
  return {
    name: REACT_MIXED_MODE_ROLLDOWN_PLUGIN,
    transform(code: string, id: string) {
      return patchReactDevelopmentRuntime(code, id);
    },
  };
}

export function createEsbuildReactMixedModeGuard() {
  return {
    name: REACT_MIXED_MODE_ESBUILD_PLUGIN,
    setup(build: any) {
      build.onLoad({ filter: REACT_DEVELOPMENT_RUNTIME }, (args: { path: string }) => {
        const code = readFileSync(args.path, 'utf8');
        const patched = patchReactDevelopmentRuntime(code, args.path);
        if (patched === undefined) return;
        return { contents: patched, loader: 'js' };
      });
    },
  };
}
