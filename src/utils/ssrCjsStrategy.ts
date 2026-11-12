import { registerSsrBuildExternal, withoutSsrBuildGraph } from './ssrBuildGraph';
/** No static Node imports: the runtime plugin is also imported by browser builds. */
export async function evaluateSsrCommonJs(
  source: string,
  url: string,
  resolvedShared: Record<string, string>,
  hostExternals: Record<string, unknown> = {}
): Promise<{ init: (...args: any[]) => any; get: (...args: any[]) => any }> {
  const nodeModule = 'node:module';
  const nodeVm = 'node:vm';
  const nodeFs = 'node:fs';
  const nodePath = 'node:path';
  const [{ createRequire, isBuiltin }, { compileFunction }, fs, path] = await withoutSsrBuildGraph(
    () =>
      Promise.all([
        import(/* @vite-ignore */ nodeModule) as Promise<typeof import('node:module')>,
        import(/* @vite-ignore */ nodeVm) as Promise<typeof import('node:vm')>,
        import(/* @vite-ignore */ nodeFs) as Promise<typeof import('node:fs')>,
        import(/* @vite-ignore */ nodePath) as Promise<typeof import('node:path')>,
      ])
  );
  const hostRequire = createRequire(path.join(process.cwd(), 'noop.js'));
  const fallbackRequire = createRequire(import.meta.url);
  const packageFileFor = (filename: string): string | undefined => {
    let directory = path.dirname(filename);
    for (;;) {
      const packageFile = path.join(directory, 'package.json');
      if (fs.existsSync(packageFile)) return packageFile;
      const parent = path.dirname(directory);
      if (parent === directory) return;
      directory = parent;
    }
  };
  const isEsmFile = (filename: string) => {
    if (path.extname(filename) === '.mjs') return true;
    const packageFile = packageFileFor(filename);
    return (
      path.extname(filename) === '.js' &&
      packageFile !== undefined &&
      JSON.parse(fs.readFileSync(packageFile, 'utf8')).type === 'module'
    );
  };
  const packageIdentityFor = (filename: string, requestedName: string) => {
    let directory = path.dirname(fs.realpathSync(filename));
    let nearest: { root: string; name: string } | undefined;
    for (;;) {
      const packageFile = path.join(directory, 'package.json');
      if (fs.existsSync(packageFile)) {
        const name = JSON.parse(fs.readFileSync(packageFile, 'utf8')).name;
        if (typeof name === 'string') {
          nearest ??= { root: directory, name };
          if (name === requestedName) return { root: directory, name };
        }
      }
      const parent = path.dirname(directory);
      if (parent === directory) return nearest;
      directory = parent;
    }
  };
  const requireExternal = (specifier: string) => {
    if (typeof specifier !== 'string' || /^(?:[./\\]|[a-zA-Z]:|\w+:\/\/)/.test(specifier)) {
      throw new Error(
        `CJS SSR entry must be fully bundled; unsupported require(${JSON.stringify(specifier)}) in ${url}`
      );
    }
    if (Object.hasOwn(hostExternals, specifier))
      return registerSsrBuildExternal(hostExternals[specifier]);
    if (isBuiltin(specifier))
      return registerSsrBuildExternal(withoutSsrBuildGraph(() => hostRequire(specifier)));
    const prefix = Object.keys(resolvedShared)
      .filter((key) => key.endsWith('/') && specifier.startsWith(key))
      .sort((a, b) => b.length - a.length)[0];
    const selected = resolvedShared[specifier] ?? (prefix && resolvedShared[prefix]);
    let filename: string;
    try {
      filename = selected || hostRequire.resolve(specifier);
    } catch {
      filename = fallbackRequire.resolve(specifier);
    }
    // Node can synchronously require some ESM, but that would put the external
    // into its permanent ESM cache. This strategy deliberately supports CJS
    // externals only, resolved using the host's require conditions.
    if (selected && (prefix || isEsmFile(filename))) {
      // An import-condition path can identify a dual package. Resolve its own
      // require condition while preserving the selected package installation.
      try {
        const requestedName = specifier.startsWith('@')
          ? specifier.split('/').slice(0, 2).join('/')
          : specifier.split('/')[0];
        const identity = packageIdentityFor(filename, requestedName);
        const request = identity
          ? identity.name + specifier.slice(requestedName.length)
          : specifier;
        const commonJs = createRequire(filename).resolve(request);
        if (identity && packageIdentityFor(commonJs, identity.name)?.root === identity.root) {
          filename = commonJs;
        } else if (prefix) {
          throw new Error('Resolved a different package installation');
        }
      } catch (error) {
        if (prefix)
          throw new Error(
            `CJS SSR could not resolve "${specifier}" from the selected host shared installation ${selected}: ${error}`
          );
        // The package has no supported require condition.
      }
    }
    filename = fs.realpathSync(filename);
    if (isEsmFile(filename))
      throw new Error(
        `CJS SSR does not support ESM-only external "${specifier}" (${filename}); provide a CommonJS require export`
      );
    if (!['.js', '.cjs', '.json', '.node'].includes(path.extname(filename))) {
      throw new Error(
        `CJS SSR does not support external "${specifier}" with file type ${path.extname(filename)}`
      );
    }
    if (path.extname(filename) === '.js' && !hostRequire.cache[filename]) {
      // Ambiguous .js files can be syntax-detected as ESM by modern Node even
      // without type:module. Parse the wrapper before Node can cache such ESM.
      try {
        compileFunction(fs.readFileSync(filename, 'utf8').replace(/^#![^\n]*\n/, ''), [
          'module',
          'exports',
          'require',
          '__filename',
          '__dirname',
        ]);
      } catch {
        throw new Error(
          `CJS SSR does not support ESM-only or non-CommonJS external "${specifier}" (${filename})`
        );
      }
    }
    return registerSsrBuildExternal(withoutSsrBuildGraph(() => hostRequire(filename)));
  };
  const module = { exports: {} as any };
  // No parsingContext, filename-backed Module, require.cache insertion, or
  // importModuleDynamically hook: the compiled function belongs to this graph.
  const evaluate = compileFunction(source, ['module', 'exports', 'require'], { filename: url });
  evaluate(module, module.exports, requireExternal);
  const container = module.exports;
  if (!container || typeof container.init !== 'function' || typeof container.get !== 'function') {
    throw new Error(`CJS SSR entry ${url} must export init and get functions`);
  }
  return container;
}
