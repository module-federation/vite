// CJS sub-path that require()s the main package — mirrors react-dom/client.js
// When 'cjs-dep' is shared, MF resolves require('cjs-dep') to an ESM virtual
// module. The commonjs plugin then creates a \0-prefixed proxy, triggering the bug.
var m = require('cjs-dep');
module.exports.greeting = m.greeting;
module.exports.add = m.add;
