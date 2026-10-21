const RETRYABLE = new Set(['23505', '40001', '40P01']);

export function isRetryable(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && RETRYABLE.has(code);
}

// unique violation: a tentativa seguinte já enxerga a linha da vencedora; 40001/40P01: serialização e deadlock
export async function withRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= attempts || !isRetryable(error)) {
        throw error;
      }
    }
  }
}
