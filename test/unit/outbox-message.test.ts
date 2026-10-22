import { describe, expect, test } from 'bun:test';
import { IntegrationEvent } from '../../src/domain/events/integration-event';
import { OutboxMessage } from '../../src/domain/events/outbox-message';

const base = {
  id: 'a',
  aggregateId: 'w1',
  eventType: 'WalletBalanceChanged',
  payload: {},
  occurredAt: new Date('2026-01-01T10:00:00Z'),
  attempts: 0,
};

class TestEvent extends IntegrationEvent<{ amount: string }> {
  readonly eventType = 'WagerProcessed';
  readonly version = 1;

  constructor() {
    super({
      eventId: 'event-1',
      aggregateId: 'wallet-1',
      correlationId: 'correlation-1',
      occurredAt: new Date('2026-01-01T10:00:00Z'),
      data: { amount: '10.00' },
    });
  }
}

describe('OutboxMessage', () => {
  test('enqueue cria uma mensagem a partir do evento', () => {
    const message = OutboxMessage.enqueue(new TestEvent());

    expect(message.id).toBe('event-1');
    expect(message.aggregateId).toBe('wallet-1');
    expect(message.eventType).toBe('WagerProcessed');
    expect(message.payload).toMatchObject({ eventId: 'event-1', data: { amount: '10.00' } });
    expect(message.attempts).toBe(0);
    expect(message.isPending()).toBe(true);
  });

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
    expect(msg.isPending()).toBe(false);
    expect(msg.isDue(new Date('2027-01-01T00:00:00Z'))).toBe(false);
  });

  test('markPublished registra a publicação e impede novas transições', () => {
    const message = OutboxMessage.rehydrate(base);
    const publishedAt = new Date('2026-01-01T10:00:01Z');

    message.markPublished(publishedAt);

    expect(message.publishedAt).toEqual(publishedAt);
    expect(message.isPending()).toBe(false);
    expect(message.isDue(new Date('2027-01-01T00:00:00Z'))).toBe(false);
    expect(() => message.scheduleRetry(publishedAt)).toThrow('published outbox message');
    expect(() => message.markPublished(publishedAt)).toThrow('published outbox message');
  });

  test('scheduleRetry incrementa tentativas e agenda usando o backoff', () => {
    const message = OutboxMessage.rehydrate(base);
    const now = new Date('2026-01-01T10:00:00Z');

    message.scheduleRetry(now, { baseMs: 1_000, maxMs: 1_000 });

    expect(message.attempts).toBe(1);
    expect(message.nextAttemptAt!.getTime() - now.getTime()).toBeGreaterThanOrEqual(500);
    expect(message.nextAttemptAt!.getTime() - now.getTime()).toBeLessThanOrEqual(1_000);
    expect(message.isPending()).toBe(true);
    expect(message.isDue(now)).toBe(false);
  });

  test('retries usam o número atualizado de tentativas', () => {
    const message = OutboxMessage.rehydrate(base);
    const now = new Date('2026-01-01T10:00:00Z');

    message.scheduleRetry(now, { baseMs: 1_000, maxMs: 10_000 });
    message.scheduleRetry(now, { baseMs: 1_000, maxMs: 10_000 });

    expect(message.attempts).toBe(2);
    expect(message.nextAttemptAt!.getTime() - now.getTime()).toBeGreaterThanOrEqual(1_000);
    expect(message.nextAttemptAt!.getTime() - now.getTime()).toBeLessThanOrEqual(2_000);
  });
});
