import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchWithTimeout,
  readResponseTextBounded,
  SsrFetchBodyTooLargeError,
} from '../fetchWithTimeout';

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

describe('readResponseTextBounded', () => {
  it('returns the body when it is under the limit', async () => {
    const res = new Response('export const ok = true;', {
      headers: { 'content-type': 'application/javascript' },
    });

    await expect(readResponseTextBounded(res, 1024, 'https://example.com/a.js')).resolves.toBe(
      'export const ok = true;'
    );
  });

  it('rejects when Content-Length exceeds the limit before reading', async () => {
    const res = new Response('too-large', {
      headers: { 'content-length': '100' },
    });

    await expect(readResponseTextBounded(res, 50, 'https://example.com/big.js')).rejects.toThrow(
      SsrFetchBodyTooLargeError
    );
  });

  it('rejects when the streamed body exceeds the limit', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('abcdefghij'));
        controller.enqueue(encoder.encode('klmnopqrst'));
        controller.close();
      },
    });
    const res = new Response(stream);

    await expect(readResponseTextBounded(res, 15, 'https://example.com/stream.js')).rejects.toThrow(
      /exceeded the 15-byte limit/
    );
  });

  it('disables the limit when maxBytes is 0', async () => {
    const body = 'x'.repeat(100);
    const res = new Response(body, {
      headers: { 'content-length': String(body.length) },
    });

    await expect(readResponseTextBounded(res, 0, 'https://example.com/x.js')).resolves.toBe(body);
  });
});
