# @module-federation/runtime-vite

A tree-shaken version of [@module-federation/runtime](https://www.npmjs.com/package/@module-federation/runtime) that includes only the necessary functions for [@module-federation/vite](https://www.npmjs.com/package/@module-federation/vite).

Among other things, this removes the NodeJS-specific code, particularly the eval() call and vm module invocations.
