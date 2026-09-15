import { describe, expect, it } from 'vitest';
import {
  isClientEnvironment,
  resolveEnvironmentConsumerTarget,
  resolveRemoteConsumer,
} from '../remoteConsumerTarget';

describe('resolveRemoteConsumer', () => {
  it('returns unified when the Environment API is off', () => {
    expect(resolveRemoteConsumer({}, false)).toBe('unified');
    expect(resolveRemoteConsumer({ environment: { name: 'ssr' } }, false)).toBe('unified');
  });

  it('maps client and missing env to client when multi-environment is on', () => {
    expect(resolveRemoteConsumer({}, true)).toBe('client');
    expect(resolveRemoteConsumer({ environment: { name: 'client' } }, true)).toBe('client');
    expect(
      resolveRemoteConsumer(
        { environment: { name: 'federation', config: { consumer: 'client' } } },
        true
      )
    ).toBe('client');
  });

  it('maps non-client environments to server', () => {
    expect(resolveRemoteConsumer({ environment: { name: 'ssr' } }, true)).toBe('server');
    expect(resolveRemoteConsumer({ environment: { name: 'rsc' } }, true)).toBe('server');
    expect(
      resolveRemoteConsumer(
        { environment: { name: 'federation', config: { consumer: 'server' } } },
        true
      )
    ).toBe('server');
  });
});

describe('resolveEnvironmentConsumerTarget', () => {
  it('returns undefined without an environment context', () => {
    expect(resolveEnvironmentConsumerTarget(undefined)).toBeUndefined();
    expect(resolveEnvironmentConsumerTarget(null)).toBeUndefined();
    expect(resolveEnvironmentConsumerTarget({})).toBeUndefined();
  });

  it('prefers the Vite consumer role over the environment name', () => {
    expect(
      resolveEnvironmentConsumerTarget({
        environment: { name: 'federation', config: { consumer: 'client' } },
      })
    ).toBe('client');
    expect(
      resolveEnvironmentConsumerTarget({
        environment: { name: 'client', config: { consumer: 'server' } },
      })
    ).toBe('server');
  });

  it('falls back to the environment name when consumer is missing', () => {
    expect(resolveEnvironmentConsumerTarget({ environment: {} })).toBe('client');
    expect(resolveEnvironmentConsumerTarget({ environment: { name: 'client' } })).toBe('client');
    expect(resolveEnvironmentConsumerTarget({ environment: { name: 'ssr' } })).toBe('server');
  });
});

describe('isClientEnvironment', () => {
  it('treats missing context and client environments as client', () => {
    expect(isClientEnvironment(undefined)).toBe(true);
    expect(isClientEnvironment({ environment: { name: 'client' } })).toBe(true);
    expect(
      isClientEnvironment({ environment: { name: 'federation', config: { consumer: 'client' } } })
    ).toBe(true);
  });

  it('rejects server environments', () => {
    expect(isClientEnvironment({ environment: { name: 'ssr' } })).toBe(false);
    expect(
      isClientEnvironment({ environment: { name: 'federation', config: { consumer: 'server' } } })
    ).toBe(false);
  });
});
