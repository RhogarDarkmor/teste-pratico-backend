export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = { baseMs: 1_000, maxMs: 5 * 60_000 };

// `attempts` já inclui a tentativa que falhou; jitter distribui os retries.
export function backoffDelayMs(attempts: number, options: BackoffOptions = DEFAULT_BACKOFF, random = Math.random): number {
  const exponential = Math.min(options.baseMs * 2 ** Math.max(attempts - 1, 0), options.maxMs);
  return Math.round(exponential / 2 + random() * (exponential / 2));
}
