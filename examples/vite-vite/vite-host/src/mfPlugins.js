const runtimePlugin = () => {
  return {
    name: 'module-federation-example-plugin',
    beforeInit(args) {
      return args;
    },
    init(args) {
      console.log('init: ', args);
      return args;
    },
    beforeLoadShare(args) {
      console.log('beforeLoadShare: ', args);
      return args;
    },
    beforeRequest(args) {
      console.log('before request hook', args);
      return args;
    },
  };
};

export default runtimePlugin;
