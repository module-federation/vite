export const DEFAULT_SSR_FETCH_TIMEOUT_MS = 10_000;

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
    if (inputUrl.hostname !== 'localhost') throw error;
    inputUrl.hostname = '[::1]';
    return request(inputUrl);
  }
}
