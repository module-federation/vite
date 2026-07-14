const recordShareHook = (name, pkgName) => {
  if (pkgName !== 'react') return;
  (globalThis.__runtimeRegisterShareHooks ||= []).push(name);
};

export default function runtimeRegisterSharePlugin() {
  return {
    name: 'runtime-register-share-hooks',
    beforeLoadShare(args) {
      recordShareHook('beforeLoadShare', args.pkgName);
      return args;
    },
    resolveShare(args) {
      recordShareHook('resolveShare', args.pkgName);
      return args;
    },
    afterLoadShare(args) {
      recordShareHook('afterLoadShare', args.pkgName);
    },
  };
}
