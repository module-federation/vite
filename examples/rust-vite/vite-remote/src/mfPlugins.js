const runtimePlugin = () => {
  return {
    name: 'module-federation-example-plugin',
    beforeRequest(args) {
      console.log('before request hook');
      return args;
    },
  };
};

export default runtimePlugin;
