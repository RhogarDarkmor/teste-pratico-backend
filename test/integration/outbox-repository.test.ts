import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { OutboxRepository } from '../../src/infra/persistence/outbox.repository';
import { createTestDatabase, type TestDatabase } from '../helpers/database';

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.sql('delete from outbox_messages');
});

async function seed(
  opts: { occurredAt?: string; nextAttemptAt?: string; published?: boolean; aggregateId?: string } = {},
) {
  const id = randomUUID();
  await db.sql(
    `insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at, next_attempt_at, published_at)
     values (?, ?, 'WalletBalanceChanged', '{"x":1}'::jsonb, ?, ?, ?)`,
    [
      id,
      opts.aggregateId ?? randomUUID(),
      opts.occurredAt ?? new Date(Date.now() - 60_000).toISOString(),
      opts.nextAttemptAt ?? null,
      opts.published ? new Date().toISOString() : null,
    ],
  );
  return id;
}

const claim = (limit: number) =>
  db.orm.em.fork().transactional((tem) => new OutboxRepository(tem as any).claimPending(limit));

describe('OutboxRepository.claimPending', () => {
  test('devolve as pendentes da mais antiga para a mais nova', async () => {
    const older = await seed({ occurredAt: new Date(Date.now() - 50_000).toISOString() });
    const newer = await seed({ occurredAt: new Date(Date.now() - 10_000).toISOString() });

    const messages = await claim(10);

    expect(messages.map((m) => m.id)).toEqual([older, newer]);
    expect(messages[0]!.payload).toEqual({ x: 1 });
    expect(messages[0]!.attempts).toBe(0);
  });

  test('ignora publicadas e as que ainda estão em espera', async () => {
    await seed({ published: true });
    await seed({ nextAttemptAt: new Date(Date.now() + 60_000).toISOString() });
    const due = await seed({ nextAttemptAt: new Date(Date.now() - 1_000).toISOString() });

    const messages = await claim(10);

    expect(messages.map((m) => m.id)).toEqual([due]);
  });

  test('respeita o tamanho do lote', async () => {
    for (let i = 0; i < 5; i++) await seed();
    expect(await claim(3)).toHaveLength(3);
  });

  test('dois publicadores ao mesmo tempo pegam mensagens diferentes', async () => {
    for (let i = 0; i < 6; i++) await seed();

    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let firstClaimed!: () => void;
    const firstReady = new Promise<void>((resolve) => (firstClaimed = resolve));

    // o primeiro publicador segura o lock da transação até o segundo terminar
    const first = db.orm.em.fork().transactional(async (tem) => {
      const got = await new OutboxRepository(tem as any).claimPending(3);
      firstClaimed();
      await gate;
      return got;
    });
    await firstReady;

    const second = await claim(6);
    release();
    const firstMessages = await first;

    const firstIds = firstMessages.map((m) => m.id);
    const secondIds = second.map((m) => m.id);
    expect(firstIds).toHaveLength(3);
    expect(secondIds).toHaveLength(3);
    expect(new Set([...firstIds, ...secondIds]).size).toBe(6);
  });

  test('depois que a transação termina sem publicar, a mensagem volta a ficar disponível', async () => {
    const id = await seed();
    await claim(1);
    expect((await claim(1)).map((m) => m.id)).toEqual([id]);
  });

  test('marca como publicada e não devolve mais', async () => {
    const id = await seed();
    const [message] = await claim(1);
    message!.markPublished(new Date());
    await db.orm.em.fork().transactional((tem) => new OutboxRepository(tem as any).markPublished(message!));
    expect(await claim(10)).toHaveLength(0);
    const [row] = await db.sql('select published_at from outbox_messages where id = ?', [id]);
    expect(row.published_at).not.toBeNull();
  });

  test('falha soma a tentativa e adia a próxima', async () => {
    const id = await seed();
    await db.sql('update outbox_messages set attempts = 2 where id = ?', [id]);
    const [message] = await claim(1);
    message!.scheduleRetry(new Date(), { baseMs: 60_000, maxMs: 60_000 });
    await db.orm.em.fork().transactional((tem) => new OutboxRepository(tem as any).markFailed(message!));
    expect(await claim(10)).toHaveLength(0);
    const [row] = await db.sql('select attempts, next_attempt_at > now() as waiting from outbox_messages where id = ?', [id]);
    expect(row.attempts).toBe(3);
    expect(row.waiting).toBe(true);
  });

  test('não libera mensagem nova de uma carteira cuja anterior está esperando backoff', async () => {
    const aggregateId = randomUUID();
    await seed({
      aggregateId,
      occurredAt: new Date(Date.now() - 50_000).toISOString(),
      nextAttemptAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await seed({ aggregateId, occurredAt: new Date(Date.now() - 40_000).toISOString() });
    const other = await seed();

    expect((await claim(10)).map((m) => m.id)).toEqual([other]);
  });

  test('não libera mensagem nova enquanto a anterior vencida está bloqueada por outro publicador', async () => {
    const aggregateId = randomUUID();
    const older = await seed({
      aggregateId,
      occurredAt: new Date(Date.now() - 50_000).toISOString(),
      nextAttemptAt: new Date(Date.now() - 1_000).toISOString(),
    });
    const newer = await seed({ aggregateId, occurredAt: new Date(Date.now() - 40_000).toISOString() });

    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let firstClaimed!: () => void;
    const firstReady = new Promise<void>((resolve) => (firstClaimed = resolve));

    const first = db.orm.em.fork().transactional(async (tem) => {
      const messages = await new OutboxRepository(tem as any).claimPending(1);
      firstClaimed();
      await gate;
      return messages;
    });
    await firstReady;

    const second = await claim(10);
    release();
    const firstMessages = await first;

    expect(firstMessages.map((message) => message.id)).toEqual([older]);
    expect(second).toHaveLength(0);
    expect(second.map((message) => message.id)).not.toContain(newer);
    expect((await claim(10)).map((message) => message.id)).toEqual([older]);
    const [oldMessage] = await claim(1);
    oldMessage!.markPublished(new Date());
    await db.orm.em.fork().transactional((tem) => new OutboxRepository(tem as any).markPublished(oldMessage!));
    expect((await claim(10)).map((message) => message.id)).toEqual([newer]);
  });
});
