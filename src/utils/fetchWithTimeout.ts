export const DEFAULT_SSR_FETCH_TIMEOUT_MS = 10_000;
export const DEFAULT_SSR_FETCH_MAX_BYTES = 10 * 1024 * 1024;

function getFetchUrl(input: Parameters<typeof fetch>[0]): URL {
  const raw = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
  return new URL(raw);
}

function getSecureFetchUrl(input: Parameters<typeof fetch>[0]): URL {
  const url = getFetchUrl(input);
  const isLoopback =
    url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) {
    throw new TypeError(`Refusing to fetch SSR resource over an insecure connection: ${url}`);
  }
  return url;
}

function isAbortLikeError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const name = (error as { name?: unknown }).name;
  return name === 'AbortError' || name === 'TimeoutError';
}

/** Fetch with a bounded wait. Set timeoutMs to 0 to disable the timeout. */
export async function fetchWithTimeout(
  input: Parameters<typeof fetch>[0],
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_SSR_FETCH_TIMEOUT_MS
): Promise<Response> {
  const inputUrl = getSecureFetchUrl(input);

  const request = (target: URL) => {
    const requestInit = { ...init, redirect: 'error' as const };
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return fetch(target.href, requestInit);
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
    return fetch(target.href, { ...requestInit, signal });
  };
  try {
    return await request(inputUrl);
  } catch (error) {
    // Only fall back to IPv6 loopback for connection failures. Retrying aborts
    // would double the configured timeout and hide intentional cancellations.
    if (inputUrl.hostname !== 'localhost' || isAbortLikeError(error)) throw error;
    inputUrl.hostname = '[::1]';
    return request(inputUrl);
  }
}

export class SsrFetchBodyTooLargeError extends Error {
  readonly url: string;
  readonly maxBytes: number;
  readonly declaredBytes?: number;

  constructor(url: string, maxBytes: number, declaredBytes?: number) {
    super(
      declaredBytes != null
        ? `SSR response from ${url} declared ${declaredBytes} bytes which exceeds the ${maxBytes}-byte limit`
        : `SSR response from ${url} exceeded the ${maxBytes}-byte limit`
    );
    this.name = 'SsrFetchBodyTooLargeError';
    this.url = url;
    this.maxBytes = maxBytes;
    this.declaredBytes = declaredBytes;
  }
}

export function isSsrFetchBodyTooLargeError(error: unknown): error is SsrFetchBodyTooLargeError {
  return error instanceof SsrFetchBodyTooLargeError;
}

/**
 * Read a response body as text, rejecting when it exceeds `maxBytes`.
 * Set `maxBytes` to 0 (or a non-finite value) to disable the limit.
 */
export async function readResponseTextBounded(
  res: Response,
  maxBytes: number = DEFAULT_SSR_FETCH_MAX_BYTES,
  url: string = res.url || 'unknown'
): Promise<string> {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    return res.text();
  }

  const contentLengthHeader = res.headers?.get?.('content-length') ?? null;
  if (contentLengthHeader != null) {
    const declaredBytes = Number(contentLengthHeader);
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
      try {
        await res.body?.cancel();
      } catch {
        /* ignore cancel failures */
      }
      throw new SsrFetchBodyTooLargeError(url, maxBytes, declaredBytes);
    }
  }

  if (!res.body) {
    return res.text();
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        /* ignore cancel failures */
      }
      throw new SsrFetchBodyTooLargeError(url, maxBytes);
    }
    chunks.push(value);
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}
