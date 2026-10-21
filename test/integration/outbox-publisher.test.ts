import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import type { OutboxMessage } from '../../src/domain/events/outbox-message';
import { OutboxPublisher } from '../../src/infra/outbox/outbox-publisher';
import { SqsMessagePublisher, type MessagePublisher } from '../../src/infra/outbox/sqs-message-publisher';
import { createTestDatabase, type TestDatabase } from '../helpers/database';

const silent = { warn: () => {}, error: () => {} };
const endpoint = process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566';

let db: TestDatabase;
let sqs: SQSClient;
let queueUrl: string;

beforeAll(async () => {
  db = await createTestDatabase();
  sqs = new SQSClient({
    region: 'us-east-1',
    endpoint,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
  const created = await sqs.send(
    new CreateQueueCommand({
      QueueName: `outbox-test-${randomUUID()}.fifo`,
      Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' },
    }),
  );
  queueUrl = created.QueueUrl!;
});

afterAll(async () => {
  await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
  sqs.destroy();
  await db.drop();
});

beforeEach(async () => {
  await db.sql('delete from outbox_messages');
});

async function seed(aggregateId: string, ageMs: number) {
  const id = randomUUID();
  await db.sql(
    `insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at)
     values (?, ?, 'WalletBalanceChanged', ?::jsonb, ?)`,
    [id, aggregateId, JSON.stringify({ eventId: id }), new Date(Date.now() - ageMs).toISOString()],
  );
  return id;
}

const outbox = (publisher: MessagePublisher, options = {}) =>
  new OutboxPublisher(db.orm.em as any, publisher, { backoff: { baseMs: 50, maxMs: 200 }, ...options }, silent);

// lê até a fila esvaziar: depois de ter o esperado, uma leitura vazia confirma que não há duplicata
async function drainQueue(expected: number) {
  const bodies: any[] = [];
  for (let i = 0; i < 10; i++) {
    const res = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 }),
    );
    const received = res.Messages ?? [];
    for (const m of received) bodies.push(JSON.parse(m.Body!));
    if (received.length === 0 && bodies.length >= expected) break;
  }
  return bodies;
}

describe('OutboxPublisher', () => {
  test('publica no SQS e marca como publicado', async () => {
    const id = await seed(randomUUID(), 1_000);

    const result = await outbox(new SqsMessagePublisher(sqs, queueUrl)).runOnce();

    expect(result).toEqual({ claimed: 1, published: 1, failed: 0 });
    const [row] = await db.sql('select published_at from outbox_messages where id = ?', [id]);
    expect(row.published_at).not.toBeNull();
    expect((await drainQueue(1)).map((b) => b.eventId)).toEqual([id]);
  });

  test('se o SQS cai, a mensagem fica pendente com backoff e é publicada quando volta', async () => {
    const id = await seed(randomUUID(), 1_000);
    let sqsUp = false;
    const flaky: MessagePublisher = {
      publish: (m: OutboxMessage) => {
        if (!sqsUp) throw new Error('sqs indisponivel');
        return new SqsMessagePublisher(sqs, queueUrl).publish(m);
      },
    };
    const publisher = outbox(flaky);

    expect(await publisher.runOnce()).toEqual({ claimed: 1, published: 0, failed: 1 });
    const [afterFail] = await db.sql('select attempts, published_at from outbox_messages where id = ?', [id]);
    expect(afterFail.attempts).toBe(1);
    expect(afterFail.published_at).toBeNull();

    // ainda em espera: nada acontece
    expect((await publisher.runOnce()).claimed).toBe(0);

    sqsUp = true;
    await Bun.sleep(150);
    expect(await publisher.runOnce()).toEqual({ claimed: 1, published: 1, failed: 0 });
    expect((await drainQueue(1)).map((b) => b.eventId)).toEqual([id]);
  });

  test('falha em uma mensagem segura as seguintes da mesma carteira, mas não as de outras', async () => {
    const walletA = randomUUID();
    const first = await seed(walletA, 3_000);
    const second = await seed(walletA, 2_000);
    const other = await seed(randomUUID(), 1_000);

    const sent: string[] = [];
    const publisher = outbox({
      publish: async (m) => {
        if (m.id === first) throw new Error('falhou');
        sent.push(m.id);
      },
    });

    expect(await publisher.runOnce()).toEqual({ claimed: 3, published: 1, failed: 1 });
    expect(sent).toEqual([other]);
    const [row] = await db.sql('select published_at from outbox_messages where id = ?', [second]);
    expect(row.published_at).toBeNull();
  });

  test('dois publicadores em paralelo enviam cada mensagem uma vez só', async () => {
    const ids = new Set<string>();
    for (let i = 0; i < 12; i++) ids.add(await seed(randomUUID(), 1_000));

    const sent: string[] = [];
    const recorder: MessagePublisher = {
      publish: async (m) => {
        await Bun.sleep(20);
        sent.push(m.id);
      },
    };

    await Promise.all([
      outbox(recorder, { batchSize: 6 }).runOnce(),
      outbox(recorder, { batchSize: 6 }).runOnce(),
    ]);

    expect(sent).toHaveLength(12);
    expect(new Set(sent)).toEqual(ids);
  });

  test('se o processo cai antes do commit, outro publicador refaz o envio sem duplicar na fila', async () => {
    const id = await seed(randomUUID(), 1_000);
    const real = new SqsMessagePublisher(sqs, queueUrl);

    // envia ao SQS mas a transação aborta antes de marcar como publicado
    await expect(
      outbox({
        publish: async (m) => {
          await real.publish(m);
          throw new Error('crash simulado');
        },
      }).runOnce(),
    ).resolves.toMatchObject({ failed: 1 });
    await db.sql('update outbox_messages set next_attempt_at = null, attempts = 0 where id = ?', [id]);

    await outbox(real).runOnce();

    expect(await drainQueue(1)).toHaveLength(1);
  });

  test('o loop publica sozinho e para limpo no stop', async () => {
    const id = await seed(randomUUID(), 1_000);
    const sent: string[] = [];
    const publisher = outbox({ publish: async (m) => void sent.push(m.id) }, { pollIntervalMs: 20 });

    publisher.start();
    for (let i = 0; i < 50 && sent.length === 0; i++) await Bun.sleep(20);
    await publisher.stop();

    expect(sent).toEqual([id]);
  });
});
