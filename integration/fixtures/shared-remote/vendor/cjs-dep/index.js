// CJS module — triggers @rollup/plugin-commonjs proxy during build
module.exports.greeting = 'hello from cjs';
module.exports.add = function add(a, b) {
  return a + b;
};
