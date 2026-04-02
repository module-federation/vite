/**
 * Detects whether the current process is running in a test environment
 * Set `MFE_VITE_SKIP_TEST_ENV_CHECK=true` to load federation plugins during tests.
 */
export function isTestEnv() {
  if (process.env.MFE_VITE_SKIP_TEST_ENV_CHECK === 'true') return false;

  return (
    process.env.NODE_ENV === 'test' ||
    process.env.VITEST != null ||
    process.env.JEST_WORKER_ID != null
  );
}
