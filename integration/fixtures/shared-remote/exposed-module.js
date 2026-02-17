import { createDefu } from 'defu';

export const merge = createDefu((obj, key, value) => {
  if (typeof obj[key] === 'number' && typeof value === 'number') {
    obj[key] += value;
    return true;
  }
});
