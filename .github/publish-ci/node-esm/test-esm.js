// TODO This entire file doesn't work yet with RTK 1.9.3 master

import assert from 'node:assert';
import path from 'path';
import { importMetaResolve } from 'resolve-esm';

import { federation } from '@module-federation/vite';

console.log('Testing Node with ESM imports...');

function checkFunctionName(fn, name) {
  console.log(`Checking '${name}' === '${fn.name}'`);
  assert(fn.name === name, `\`${name}\` did not import correctly (name: '${fn.name}')`);
}

const entries = [[federation, 'federation']];

for (let [fn, name] of entries) {
  try {
    checkFunctionName(fn, name);
  } catch (error) {
    console.error(error);
  }
}

const moduleNames = [['@module-federation/vite', 'lib/index.mjs']];

(async () => {
  for (let [moduleName, expectedFilename] of moduleNames) {
    const modulePath = await importMetaResolve(moduleName);
    const posixPath = modulePath.split(path.sep).join(path.posix.sep);
    console.log(`Module: ${moduleName}, path: ${posixPath}`);
    assert(posixPath.endsWith(expectedFilename));
  }

  console.log('ESM test succeeded');
})();
