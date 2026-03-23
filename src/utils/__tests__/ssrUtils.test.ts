import { describe, expect, it, vi, beforeEach } from 'vitest';

const { hasPackageDependencyMock } = vi.hoisted(() => ({
  hasPackageDependencyMock: vi.fn(),
}));

vi.mock('../packageUtils', () => ({
  hasPackageDependency: hasPackageDependencyMock,
}));

import {
  isSSREnvironment,
  matchSSRFrameworkEntry,
  SSR_FRAMEWORK_ENTRIES,
  ResolverContext,
} from '../ssrUtils';

describe('isSSREnvironment', () => {
  it('returns true when environment.name === "ssr"', () => {
    const context: Partial<ResolverContext> = {
      environment: { name: 'ssr' },
    };
    expect(isSSREnvironment(context)).toBe(true);
  });

  it('returns false when environment.name === "client"', () => {
    const context: Partial<ResolverContext> = {
      environment: { name: 'client' },
    };
    expect(isSSREnvironment(context)).toBe(false);
  });

  it('returns false when environment is undefined', () => {
    const context: Partial<ResolverContext> = {};
    expect(isSSREnvironment(context)).toBe(false);
  });

  it('returns false when environment.name is empty string', () => {
    const context: Partial<ResolverContext> = {
      environment: { name: '' },
    };
    expect(isSSREnvironment(context)).toBe(false);
  });
});

describe('SSR_FRAMEWORK_ENTRIES', () => {
  it('contains vinext entries', () => {
    expect(SSR_FRAMEWORK_ENTRIES.vinext).toBeDefined();
    expect(SSR_FRAMEWORK_ENTRIES.vinext).toContain('virtual:vite-rsc/entry-browser');
    expect(SSR_FRAMEWORK_ENTRIES.vinext).toContain('virtual:vinext-app-browser-entry');
  });

  it('contains TanStack Start entries', () => {
    expect(SSR_FRAMEWORK_ENTRIES['@tanstack/react-start']).toBeDefined();
    expect(SSR_FRAMEWORK_ENTRIES['@tanstack/react-start']).toContain(
      'virtual:tanstack-start-client-entry'
    );
    expect(SSR_FRAMEWORK_ENTRIES['@tanstack/react-start']).toContain('default-entry/client');
  });
});

describe('matchSSRFrameworkEntry', () => {
  beforeEach(() => {
    hasPackageDependencyMock.mockReset();
  });

  it('matches TanStack Start virtual entry when package is installed', () => {
    hasPackageDependencyMock.mockImplementation((pkg: string) => pkg === '@tanstack/react-start');

    expect(matchSSRFrameworkEntry('virtual:tanstack-start-client-entry')).toBe(
      '@tanstack/react-start'
    );
    expect(matchSSRFrameworkEntry('/app/.tanstack/default-entry/client.tsx')).toBe(
      '@tanstack/react-start'
    );
  });

  it('matches Vinext browser entry when package is installed', () => {
    hasPackageDependencyMock.mockImplementation((pkg: string) => pkg === 'vinext');

    expect(matchSSRFrameworkEntry('virtual:vinext-app-browser-entry')).toBe('vinext');
    expect(matchSSRFrameworkEntry('virtual:vite-rsc/entry-browser')).toBe('vinext');
  });

  it('returns null for matching entry when package is not installed', () => {
    hasPackageDependencyMock.mockReturnValue(false);

    expect(matchSSRFrameworkEntry('virtual:tanstack-start-client-entry')).toBeNull();
    expect(matchSSRFrameworkEntry('virtual:vinext-app-browser-entry')).toBeNull();
  });

  it('returns null for non-matching entries', () => {
    hasPackageDependencyMock.mockReturnValue(true);

    expect(matchSSRFrameworkEntry('some-other-module')).toBeNull();
    expect(matchSSRFrameworkEntry('/src/main.ts')).toBeNull();
    expect(matchSSRFrameworkEntry('react')).toBeNull();
  });

  it('returns null when entry pattern is a partial match but not included', () => {
    hasPackageDependencyMock.mockReturnValue(true);

    // "start-client" is not the same as "tanstack-start-client-entry"
    expect(matchSSRFrameworkEntry('start-client')).toBeNull();
  });
});
