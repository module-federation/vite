import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadPluginModuleParseEnd() {
  vi.resetModules();
  return import('../pluginModuleParseEnd');
}

describe('pluginModuleParseEnd', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.resetModules();
  });

  it('waits for parse activity to go idle when moduleParseIdleTimeout is configured', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const mod = await loadPluginModuleParseEnd();
    const state = mod.createModuleParseState();
    const plugins = mod.default(
      () => false,
      {
        moduleParseTimeout: 10,
        moduleParseIdleTimeout: 1,
        virtualExposesId: 'virtual:mf-exposes:test',
      },
      state
    );
    const parseStart = plugins.find((plugin) => plugin.name === 'parseStart');
    const parseEnd = plugins.find((plugin) => plugin.name === 'parseEnd');

    parseStart?.buildStart?.call({} as never);
    let resolved = false;
    void state.promise.then(() => {
      resolved = true;
    });
    parseStart?.load?.call({} as never, 'src/entry.ts');

    await vi.advanceTimersByTimeAsync(900);
    expect(resolved).toBe(false);

    parseEnd?.moduleParsed?.call({} as never, { id: 'src/entry.ts' } as never);

    await vi.advanceTimersByTimeAsync(900);
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(200);
    expect(resolved).toBe(true);
  });

  it('falls back to the fixed timeout when no idle timeout is configured', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const mod = await loadPluginModuleParseEnd();
    const state = mod.createModuleParseState();
    const plugins = mod.default(
      () => false,
      {
        moduleParseTimeout: 2,
        virtualExposesId: 'virtual:mf-exposes:test',
      },
      state
    );
    const parseStart = plugins.find((plugin) => plugin.name === 'parseStart');

    parseStart?.buildStart?.call({} as never);
    let resolved = false;
    void state.promise.then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(1900);
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(100);
    expect(resolved).toBe(true);
  });
});
