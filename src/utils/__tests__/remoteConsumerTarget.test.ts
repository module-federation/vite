import { describe, expect, it } from 'vitest';
import { resolveRemoteConsumer } from '../remoteConsumerTarget';

describe('resolveRemoteConsumer', () => {
  it('returns unified when the Environment API is off', () => {
    expect(resolveRemoteConsumer({}, false)).toBe('unified');
    expect(resolveRemoteConsumer({ environment: { name: 'ssr' } }, false)).toBe('unified');
  });

  it('maps client and missing env to client when multi-environment is on', () => {
    expect(resolveRemoteConsumer({}, true)).toBe('client');
    expect(resolveRemoteConsumer({ environment: { name: 'client' } }, true)).toBe('client');
  });

  it('maps non-client environments to server', () => {
    expect(resolveRemoteConsumer({ environment: { name: 'ssr' } }, true)).toBe('server');
    expect(resolveRemoteConsumer({ environment: { name: 'rsc' } }, true)).toBe('server');
  });
});
