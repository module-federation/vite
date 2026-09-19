// Shared by webpack.config.js and rspack.config.js.
//
// Regression fixture for module-federation/vite#1326 / #1064: a host whose own
// bootstrap consumes `react` through the enhanced runtime. Its loadShare() awaits
// initializeSharing(), which awaits every remote init(). If the Vite remote bridges
// the host's shared providers *inside* init() it calls back into loadShare() and the
// two promises wait on each other forever (blank page, no error). The React version
// must match the remote's exactly to take the same-version bridge path.
module.exports = (name) => ({
  name,
  dts: false,
  remotes: {
    remote: 'remote@http://localhost:4001/mf-manifest.json',
  },
  shared: {
    react: {},
    'react-dom': {},
  },
});
