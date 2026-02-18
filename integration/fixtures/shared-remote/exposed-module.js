import defu from 'defu';

export function merge(a, b) {
  return defu(a, b);
}
