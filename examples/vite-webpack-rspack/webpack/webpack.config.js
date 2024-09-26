const HtmlWebPackPlugin = require('html-webpack-plugin');
const { ModuleFederationPlugin } = require('@module-federation/enhanced');
const path = require('path');
const Dotenv = require('dotenv-webpack');
const deps = require('./package.json').dependencies;

const printCompilationMessage = require('./compilation.config.js');

module.exports = {
  context: __dirname,
  output: {
    publicPath: 'auto',
  },

  resolve: {
    extensions: ['.tsx', '.ts', '.jsx', '.js', '.json'],
  },

  devServer: {
    port: 8080,
    historyApiFallback: true,
    watchFiles: [path.resolve(__dirname, 'src')],
    onListening: function (devServer) {
      const port = devServer.server.address().port;

      printCompilationMessage('compiling', port);

      devServer.compiler.hooks.done.tap('OutputMessagePlugin', (stats) => {
        setImmediate(() => {
          if (stats.hasErrors()) {
            printCompilationMessage('failure', port);
          } else {
            printCompilationMessage('success', port);
          }
        });
      });
    },
  },

  module: {
    rules: [
      {
        test: /\.(svg|png)$/,
        type: 'asset',
      },
      {
        test: /\.m?js/,
        type: 'javascript/auto',
        resolve: {
          fullySpecified: false,
        },
      },
      {
        test: /\.(css|s[ac]ss)$/i,
        use: ['style-loader', 'css-loader', 'postcss-loader'],
      },
      {
        test: /\.(ts|tsx|js|jsx)$/,
        exclude: /node_modules/,
        use: {
          loader: 'babel-loader',
        },
      },
    ],
  },

  plugins: [
    new ModuleFederationPlugin({
      name: 'webpack',
      filename: 'remoteEntry.js',
      remotes: {},
      dts: {
        generateTypes: {
          extractRemoteTypes: true,
        },
        consumeTypes: {
          typesFolder: '@mf-types/',
          abortOnError: true,
          deleteTypesFolder: false,
          consumeAPITypes: true,
        },
      },
      dev: {
        disableLiveReload: true,
        disableHotTypesReload: true,
        disableDynamicRemoteTypeHints: true,
      },
      exposes: {
        './Image': './src/Image.tsx',
      },
      shared: {
        ...deps,
        react: {
          singleton: true,
        },
        'react-dom': {
          singleton: true,
        },
      },
    }),
    new HtmlWebPackPlugin({
      template: './src/index.html',
    }),
    new Dotenv(),
  ],
};
