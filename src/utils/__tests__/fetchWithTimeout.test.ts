import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchWithTimeout } from '../fetchWithTimeout';

describe('fetchWithTimeout', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches resources over HTTPS', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response());
    vi.stubGlobal('fetch', fetchMock);

    await fetchWithTimeout('https://example.com/remoteEntry.js', {}, 0);

    expect(fetchMock).toHaveBeenCalledWith('https://example.com/remoteEntry.js', {
      redirect: 'error',
    });
  });

  it.each(['http://localhost:5001/remoteEntry.js', 'http://127.0.0.1:5001/remoteEntry.js'])(
    'allows loopback development URL %s',
    async (url) => {
      const fetchMock = vi.fn().mockResolvedValue(new Response());
      vi.stubGlobal('fetch', fetchMock);

      await fetchWithTimeout(url, {}, 0);

      expect(fetchMock).toHaveBeenCalledWith(url, { redirect: 'error' });
    }
  );

  it('rejects HTTP resources before fetching them', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchWithTimeout('http://example.com/remoteEntry.js')).rejects.toThrow(
      'Refusing to fetch SSR resource over an insecure connection'
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('disables automatic redirects to prevent protocol downgrades', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response());
    vi.stubGlobal('fetch', fetchMock);

    await fetchWithTimeout('https://example.com/remoteEntry.js', {}, 0);

    expect(fetchMock).toHaveBeenCalledWith('https://example.com/remoteEntry.js', {
      redirect: 'error',
    });
  });
});
