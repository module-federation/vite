import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { isTestEnv } from '../isTestEnv';

describe('isTestEnv', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {};
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('returns true when NODE_ENV is test', () => {
    process.env.NODE_ENV = 'test';
    expect(isTestEnv()).toBe(true);
  });

  it('returns true when VITEST is set', () => {
    process.env.VITEST = 'true';
    expect(isTestEnv()).toBe(true);
  });

  it('returns true when JEST_WORKER_ID is set', () => {
    process.env.JEST_WORKER_ID = '1';
    expect(isTestEnv()).toBe(true);
  });

  it('returns false when no test env vars are set', () => {
    expect(isTestEnv()).toBe(false);
  });

  it('returns false when MFE_VITE_SKIP_TEST_ENV_CHECK is true, even in test env', () => {
    process.env.NODE_ENV = 'test';
    process.env.MFE_VITE_SKIP_TEST_ENV_CHECK = 'true';
    expect(isTestEnv()).toBe(false);
  });
});
