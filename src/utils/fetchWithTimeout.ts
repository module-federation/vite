export const DEFAULT_SSR_FETCH_TIMEOUT_MS = 10_000;

/** Fetch with a bounded wait. Set timeoutMs to 0 to disable the timeout. */
export function fetchWithTimeout(
  input: Parameters<typeof fetch>[0],
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_SSR_FETCH_TIMEOUT_MS
): Promise<Response> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return fetch(input, init);

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
  return fetch(input, { ...init, signal });
}
