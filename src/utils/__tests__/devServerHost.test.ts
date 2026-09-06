import { describe, expect, it } from 'vitest';
import { formatDevServerHostForOrigin } from '../devServerHost';

describe('formatDevServerHostForOrigin', () => {
  it.each([
    [undefined, 'localhost'],
    [true, 'localhost'],
    ['0.0.0.0', 'localhost'],
    ['::', 'localhost'],
    ['localhost', 'localhost'],
    ['127.0.0.1', '127.0.0.1'],
    ['::1', '[::1]'],
    ['2001:db8::1', '[2001:db8::1]'],
    ['[::1]', '[::1]'],
    ['example.local', 'example.local'],
  ])('formats %j as %j', (host, expected) => {
    expect(formatDevServerHostForOrigin(host)).toBe(expected);
  });
});
