import { metrics } from '../../observability/metrics';

const RETRYABLE = new Set(['23505', '40001', '40P01']);

export function isRetryable(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && RETRYABLE.has(code);
}

// repetir o 23505 acha a linha que ganhou, e serve tambem pra serialização e deadlock
export async function withRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= attempts || !isRetryable(error)) {
        throw error;
      }
      const code = (error as { code: string }).code;
      metrics.dbRetries.inc({ code });
      if (code !== '23505') metrics.lockConflicts.inc({ code });
    }
  }
}
