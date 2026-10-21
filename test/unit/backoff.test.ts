import { describe, expect, test } from 'bun:test';
import { backoffDelayMs } from '../../src/infra/outbox/backoff';

const opts = { baseMs: 1_000, maxMs: 30_000 };

describe('backoffDelayMs', () => {
  test('dobra a cada tentativa', () => {
    expect(backoffDelayMs(1, opts, () => 1)).toBe(1_000);
    expect(backoffDelayMs(2, opts, () => 1)).toBe(2_000);
    expect(backoffDelayMs(3, opts, () => 1)).toBe(4_000);
  });

  test('nunca passa do teto', () => {
    expect(backoffDelayMs(20, opts, () => 1)).toBe(30_000);
  });

  test('o jitter usa só a metade de cima da faixa', () => {
    expect(backoffDelayMs(3, opts, () => 0)).toBe(2_000);
    expect(backoffDelayMs(3, opts, () => 0.5)).toBe(3_000);
  });
});
