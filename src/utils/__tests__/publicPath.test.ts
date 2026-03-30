import { describe, it, expect } from 'vitest';
import { resolvePublicPath } from '../publicPath';
import { getDefaultMockOptions } from './helpers';

describe('resolvePublicPath', () => {
  const mockOptions = getDefaultMockOptions();

  it('should return explicitly set publicPath when provided', () => {
    const options = {
      ...mockOptions,
      publicPath: 'https://cdn.example.com/',
    };
    expect(resolvePublicPath(options, '/vite/')).toBe('https://cdn.example.com/');
  });

  it('should treat publicPath "auto" as unset and fall back to viteBase', () => {
    const options = {
      ...mockOptions,
      publicPath: 'auto',
    };
    expect(resolvePublicPath(options, '/vite/')).toBe('/vite/');
    expect(resolvePublicPath(options, '/vite')).toBe('/vite/');
  });

  it('should treat publicPath "auto" as unset and fall back to "auto" when no viteBase', () => {
    const options = {
      ...mockOptions,
      publicPath: 'auto',
    };
    expect(resolvePublicPath(options, '')).toBe('auto');
  });

  it('should not produce malformed URLs when publicPath is "auto" and filename is concatenated', () => {
    const options = {
      ...mockOptions,
      publicPath: 'auto',
    };
    const filename = 'remoteEntry.js';
    const resolved = resolvePublicPath(options, '/');
    // Must not produce "autoremoteEntry.js"
    expect(resolved + filename).toBe('/remoteEntry.js');
  });

  it('should return "auto" when originalBase is empty string', () => {
    expect(resolvePublicPath(mockOptions, '/vite/', '')).toBe('auto');
  });

  it('should return viteBase with trailing slash when provided', () => {
    expect(resolvePublicPath(mockOptions, '/vite')).toBe('/vite/');
    expect(resolvePublicPath(mockOptions, '/vite/')).toBe('/vite/');
  });

  it('should return "auto" when no base is specified', () => {
    expect(resolvePublicPath(mockOptions, '')).toBe('auto');
  });

  it('should return "auto" when base is undefined', () => {
    expect(resolvePublicPath(mockOptions, undefined as unknown as string)).toBe('auto');
  });

  it('should prioritize publicPath over viteBase when both are provided', () => {
    const options = {
      ...mockOptions,
      publicPath: 'https://custom.example/',
    };
    expect(resolvePublicPath(options, '/vite/')).toBe('https://custom.example/');
  });
});
