import { describe, expect, test } from 'bun:test';
import { OutboxMessage } from '../../src/domain/events/outbox-message';

const base = {
  id: 'a',
  aggregateId: 'w1',
  eventType: 'WalletBalanceChanged',
  payload: {},
  occurredAt: new Date('2026-01-01T10:00:00Z'),
  attempts: 0,
};

describe('OutboxMessage', () => {
  test('sem nextAttemptAt fica disponível desde que ocorreu', () => {
    const msg = OutboxMessage.rehydrate(base);
    expect(msg.isDue(new Date('2026-01-01T09:59:59Z'))).toBe(false);
    expect(msg.isDue(new Date('2026-01-01T10:00:00Z'))).toBe(true);
  });

  test('respeita o nextAttemptAt quando existe', () => {
    const msg = OutboxMessage.rehydrate({ ...base, attempts: 2, nextAttemptAt: new Date('2026-01-01T10:05:00Z') });
    expect(msg.isDue(new Date('2026-01-01T10:04:59Z'))).toBe(false);
    expect(msg.isDue(new Date('2026-01-01T10:05:00Z'))).toBe(true);
  });

  test('mensagem publicada nunca está pendente', () => {
    const msg = OutboxMessage.rehydrate({ ...base, publishedAt: new Date('2026-01-01T10:00:01Z') });
    expect(msg.isPublished).toBe(true);
    expect(msg.isDue(new Date('2027-01-01T00:00:00Z'))).toBe(false);
  });
});
