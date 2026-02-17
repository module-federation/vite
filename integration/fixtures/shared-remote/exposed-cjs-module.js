// Imports from the CJS sub-path — mirrors `import { createRoot } from 'react-dom/client'`
// cjs-dep/client.js internally require()s 'cjs-dep', which is a shared dep.
import { greeting, add } from 'cjs-dep/client';

export const message = greeting;
export const sum = add(1, 2);
