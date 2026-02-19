// Named imports from a package that is declared as a shared dep in the
// federation environment.  In a multi-environment build the federation
// aliases / resolveId must NOT leak here — defu should resolve normally.
import { createDefu } from 'defu';

export const merge = createDefu((obj, key, value) => {
  if (typeof obj[key] === 'number' && typeof value === 'number') {
    obj[key] += value;
    return true;
  }
});
