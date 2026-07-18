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

  it('retries localhost connection failures over IPv6 loopback', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response('ok'));
    vi.stubGlobal('fetch', fetchMock);

    const response = await fetchWithTimeout('http://localhost:5001/remoteEntry.js', {}, 0);

    expect(await response.text()).toBe('ok');
    expect(fetchMock).toHaveBeenNthCalledWith(1, 'http://localhost:5001/remoteEntry.js', {
      redirect: 'error',
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'http://[::1]:5001/remoteEntry.js', {
      redirect: 'error',
    });
  });

  it('does not retry aborted localhost requests over IPv6', async () => {
    const abortError = new DOMException('The operation was aborted.', 'AbortError');
    const fetchMock = vi.fn().mockRejectedValue(abortError);
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchWithTimeout('http://localhost:5001/remoteEntry.js', {}, 5)).rejects.toBe(
      abortError
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:5001/remoteEntry.js',
      expect.objectContaining({ redirect: 'error' })
    );
  });

  it('does not retry timed-out localhost requests over IPv6', async () => {
    const timeoutError = new DOMException(
      'The operation was aborted due to timeout',
      'TimeoutError'
    );
    const fetchMock = vi.fn().mockRejectedValue(timeoutError);
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchWithTimeout('http://localhost:5001/remoteEntry.js', {}, 5)).rejects.toBe(
      timeoutError
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:5001/remoteEntry.js',
      expect.objectContaining({ redirect: 'error' })
    );
  });
});
