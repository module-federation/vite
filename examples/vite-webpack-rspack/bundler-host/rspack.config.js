const rspack = require('@rspack/core');
const { ModuleFederationPlugin } = require('@module-federation/enhanced/rspack');
const federationConfig = require('./federation.config.js');

/** @type {import('@rspack/cli').Configuration} */
module.exports = {
  context: __dirname,
  entry: { main: './src/index.js' },
  output: { publicPath: 'auto', uniqueName: 'rspackHost' },
  resolve: { extensions: ['.jsx', '.js'] },
  devServer: { port: 8083, hot: false, liveReload: false, client: { overlay: false } },
  // rspack serve lazily compiles the async bootstrap chunk and needs HMR to ship
  // it; compile everything up front instead so the first load is deterministic.
  lazyCompilation: false,
  module: {
    rules: [
      {
        test: /\.jsx?$/,
        exclude: /node_modules/,
        use: {
          loader: 'builtin:swc-loader',
          options: {
            jsc: {
              parser: { syntax: 'ecmascript', jsx: true },
              transform: { react: { runtime: 'automatic' } },
              target: 'es2020',
            },
          },
        },
      },
    ],
  },
  plugins: [
    new ModuleFederationPlugin(federationConfig('rspackHost')),
    new rspack.HtmlRspackPlugin({ template: './src/index.html' }),
    new rspack.DefinePlugin({ 'process.env.NODE_ENV': JSON.stringify('development') }),
  ],
};
