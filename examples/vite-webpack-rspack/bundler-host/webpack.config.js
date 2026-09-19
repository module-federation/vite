const HtmlWebPackPlugin = require('html-webpack-plugin');
const { ModuleFederationPlugin } = require('@module-federation/enhanced/webpack');
const federationConfig = require('./federation.config.js');

module.exports = {
  context: __dirname,
  entry: './src/index.js',
  output: { publicPath: 'auto', uniqueName: 'webpackHost' },
  resolve: { extensions: ['.jsx', '.js'] },
  devServer: { port: 8082, hot: false, liveReload: false, client: { overlay: false } },
  module: {
    rules: [{ test: /\.jsx?$/, exclude: /node_modules/, use: { loader: 'babel-loader' } }],
  },
  plugins: [
    new ModuleFederationPlugin(federationConfig('webpackHost')),
    new HtmlWebPackPlugin({ template: './src/index.html' }),
  ],
};
