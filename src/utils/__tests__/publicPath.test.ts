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
