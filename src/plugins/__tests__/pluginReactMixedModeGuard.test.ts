import { describe, expect, it } from 'vitest';
import { createReactMixedModeRuntimeGuard } from '../pluginReactMixedModeGuard';

describe('React mixed-mode guard', () => {
  it('guards runtime-shared React dispatchers', () => {
    const result = createReactMixedModeRuntimeGuard();

    expect(result).toContain('mod["__CLIENT_INTERNALS_DO_NOT_USE');
    expect(result).toContain('typeof next.getOwner !== "function"');
  });
});
