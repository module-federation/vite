const rspack = require('@rspack/core');
const refreshPlugin = require('@rspack/plugin-react-refresh');
const isDev = process.env.NODE_ENV === 'development';
const path = require('path');

const printCompilationMessage = require('./compilation.config.js');

/**
 * @type {import('@rspack/cli').Configuration}
 */
module.exports = {
  context: __dirname,
  entry: {
    main: './src/index.tsx',
  },

  devServer: {
    port: 8081,
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
  experiments: {
    css: true,
  },
  resolve: {
    extensions: ['.js', '.jsx', '.ts', '.tsx', '.json'],
  },
  module: {
    rules: [
      {
        test: /\.(svg|png)$/,
        type: 'asset',
      },
      {
        test: /\.css$/,
        use: [
          {
            loader: 'postcss-loader',
            options: {
              postcssOptions: {
                plugins: {
                  tailwindcss: {},
                  autoprefixer: {},
                },
              },
            },
          },
        ],
        type: 'css',
      },
      {
        test: /\.(jsx?|tsx?)$/,
        use: [
          {
            loader: 'builtin:swc-loader',
            options: {
              sourceMap: true,
              jsc: {
                parser: {
                  syntax: 'typescript',
                  tsx: true,
                },
                transform: {
                  react: {
                    runtime: 'automatic',
                    development: isDev,
                    refresh: isDev,
                  },
                },
                target: 'es2020',
              },
            },
          },
        ],
      },
    ],
  },
  plugins: [
    new rspack.container.ModuleFederationPlugin({
      name: 'rspack',
      filename: 'remoteEntry.js',
      exposes: {
        './Image': './src/Image',
      },
      shared: ['react', 'react-dom'],
    }),
    new rspack.DefinePlugin({
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV),
    }),
    new rspack.ProgressPlugin({}),
    new rspack.HtmlRspackPlugin({
      template: './src/index.html',
    }),
    isDev ? new refreshPlugin() : null,
  ].filter(Boolean),
};
