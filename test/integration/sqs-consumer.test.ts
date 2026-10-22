import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  ChangeMessageVisibilityCommand,
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { OpenWalletUseCase } from '../../src/application/open-wallet.use-case';
import { ProcessWagerMessageUseCase } from '../../src/application/process-wager-message.use-case';
import { SubmitWagerTransactionUseCase } from '../../src/application/submit-wager-transaction.use-case';
import { SqsConsumer, type MessageProcessor } from '../../src/infra/sqs/sqs-consumer';
import { createTestDatabase, type TestDatabase } from '../helpers/database';

const silent = { log: () => {}, warn: () => {}, error: () => {} };
const endpoint = process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566';

let db: TestDatabase;
let sqs: SQSClient;
let queueUrl: string;
let dlqUrl: string;
let real: ProcessWagerMessageUseCase;
let open: OpenWalletUseCase;
let seq = 0;

async function createQueue(name: string, extra: Record<string, string> = {}) {
  const res = await sqs.send(
    new CreateQueueCommand({
      QueueName: `${name}-${randomUUID()}.fifo`,
      Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false', ...extra },
    }),
  );
  return res.QueueUrl!;
}

beforeAll(async () => {
  db = await createTestDatabase();
  sqs = new SQSClient({ region: 'us-east-1', endpoint, credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
  queueUrl = await createQueue('consumer-test', { VisibilityTimeout: '30' });
  dlqUrl = await createQueue('consumer-test-dlq');
  open = new OpenWalletUseCase(db.orm.em as any);
  real = new ProcessWagerMessageUseCase(db.orm.em as any, new SubmitWagerTransactionUseCase(db.orm.em as any));
});

afterAll(async () => {
  for (const url of [queueUrl, dlqUrl]) await sqs.send(new DeleteQueueCommand({ QueueUrl: url }));
  sqs.destroy();
  await db.drop();
});

const consumer = (processor: MessageProcessor, overrides = {}) =>
  new SqsConsumer(
    sqs,
    processor,
    { queueUrl, dlqUrl, maxAttempts: 3, waitTimeSeconds: 1, backoff: { baseMs: 1_000, maxMs: 1_000 }, ...overrides },
    silent,
  );

async function newWallet(balance = '100.00') {
  const playerId = `player-${++seq}`;
  const wallet = await open.execute({ playerId, currency: 'BRL', initialBalance: balance });
  return { walletId: wallet.walletId, playerId };
}

function wagerBody(w: { walletId: string; playerId: string }, messageId = `msg-${++seq}`) {
  return JSON.stringify({
    messageId,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: 'prov',
      externalTransactionId: `ext-${messageId}`,
      idempotencyKey: `idem-${messageId}`,
      walletId: w.walletId,
      playerId: w.playerId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
    },
  });
}

const send = (body: string, group: string) =>
  sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: body,
      MessageGroupId: group,
      MessageDeduplicationId: randomUUID(),
    }),
  );

async function counts(url: string) {
  const res = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: url,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );
  return {
    visible: Number(res.Attributes!.ApproximateNumberOfMessages),
    hidden: Number(res.Attributes!.ApproximateNumberOfMessagesNotVisible),
  };
}

async function readDlq() {
  const res = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: dlqUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 2,
      MessageAttributeNames: ['All'],
    }),
  );
  return res.Messages ?? [];
}

const balanceOf = async (walletId: string) =>
  (await db.sql('select balance::text as balance from wallets where id = ?', [walletId]))[0].balance;

describe('SqsConsumer', () => {
  test('processa a mensagem, só dá ack depois do commit e a fila esvazia', async () => {
    const w = await newWallet();
    await send(wagerBody(w), w.walletId);

    expect(await consumer(real).pollOnce()).toBe(1);

    expect(await balanceOf(w.walletId)).toBe('90.00');
    expect(await counts(queueUrl)).toEqual({ visible: 0, hidden: 0 });
  });

  test('mensagem reentregue (ack perdido) não duplica o efeito', async () => {
    const w = await newWallet();
    await send(wagerBody(w, 'msg-redelivery'), w.walletId);
    // Simula ack perdido, seguido de redelivery.
    const lostAck = new Proxy(sqs, {
      get(target, prop, receiver) {
        if (prop !== 'send') return Reflect.get(target, prop, receiver);
        return async (command: any, options?: any) => {
          if (command.constructor.name !== 'DeleteMessageCommand') return target.send(command, options);
          await target.send(
            new ChangeMessageVisibilityCommand({
              QueueUrl: queueUrl,
              ReceiptHandle: command.input.ReceiptHandle,
              VisibilityTimeout: 0,
            }),
          );
          throw new Error('ack perdido');
        };
      },
    });
    const outcomes: string[] = [];
    const spy: MessageProcessor = {
      execute: async (body) => {
        const outcome = await real.execute(body);
        outcomes.push(outcome.kind);
        return outcome;
      },
    };
    const config = { queueUrl, dlqUrl, maxAttempts: 3, waitTimeSeconds: 1, backoff: { baseMs: 1_000, maxMs: 1_000 } };

    await new SqsConsumer(lostAck, spy, config, silent).pollOnce();
    expect(await balanceOf(w.walletId)).toBe('90.00');

    await new SqsConsumer(sqs, spy, config, silent).pollOnce();

    expect(outcomes).toEqual(['processed', 'duplicate']);
    expect(await balanceOf(w.walletId)).toBe('90.00');
    expect(await counts(queueUrl)).toEqual({ visible: 0, hidden: 0 });
  });

  test('erro permanente vai direto para a DLQ com o motivo e some da fila', async () => {
    const ghost = { walletId: randomUUID(), playerId: 'ghost' };
    await send(wagerBody(ghost), ghost.walletId);

    await consumer(real).pollOnce();

    expect(await counts(queueUrl)).toEqual({ visible: 0, hidden: 0 });
    const dlq = await readDlq();
    expect(dlq).toHaveLength(1);
    expect(dlq[0]!.MessageAttributes?.failureReason?.StringValue).toContain('not found');
  });

  test('mensagem malformada vai para a DLQ sem derrubar o consumidor', async () => {
    await send('isso nao e json', randomUUID());

    await consumer(real).pollOnce();

    expect((await readDlq()).map((m) => m.Body)).toContain('isso nao e json');
    expect(await counts(queueUrl)).toEqual({ visible: 0, hidden: 0 });
  });

  test('erro transitório não dá ack, volta com backoff e é processado na nova tentativa', async () => {
    const w = await newWallet();
    await send(wagerBody(w, 'msg-transient'), w.walletId);
    let calls = 0;
    const flaky: MessageProcessor = {
      execute: async (body) => {
        if (++calls === 1) throw Object.assign(new Error('banco fora'), { code: 'ECONNREFUSED' });
        return real.execute(body);
      },
    };
    const c = consumer(flaky);

    await c.pollOnce();
    expect(calls).toBe(1);
    expect(await balanceOf(w.walletId)).toBe('100.00');

    for (let i = 0; i < 6 && (await balanceOf(w.walletId)) === '100.00'; i++) await c.pollOnce();

    expect(calls).toBe(2);
    expect(await balanceOf(w.walletId)).toBe('90.00');
    expect(await counts(queueUrl)).toEqual({ visible: 0, hidden: 0 });
  }, 20_000);

  test('depois do limite de tentativas a mensagem vai para a DLQ', async () => {
    const w = await newWallet();
    await send(wagerBody(w, 'msg-always-fails'), w.walletId);
    let calls = 0;
    const broken: MessageProcessor = {
      execute: async () => {
        calls++;
        throw new Error('sempre falha');
      },
    };
    const c = consumer(broken, { maxAttempts: 2 });

    for (let i = 0; i < 8 && (await readDlqPeek()) === 0; i++) await c.pollOnce();

    expect(calls).toBe(2);
    expect(await balanceOf(w.walletId)).toBe('100.00');
  }, 25_000);

  test('mensagens da mesma carteira são processadas em ordem e uma falha segura as seguintes', async () => {
    const w = await newWallet('100.00');
    const order: string[] = [];
    const processor: MessageProcessor = {
      execute: async (body) => {
        const id = JSON.parse(body).messageId as string;
        order.push(id);
        if (id === 'ord-1') throw new Error('falha transitória');
        return real.execute(body);
      },
    };
    for (const id of ['ord-1', 'ord-2', 'ord-3']) await send(wagerBody(w, id), w.walletId);

    await consumer(processor).pollOnce();

    expect(order).toEqual(['ord-1']);
    expect(await balanceOf(w.walletId)).toBe('100.00');

    const healthy = consumer(real);
    for (let i = 0; i < 10; i++) {
      await healthy.pollOnce();
      const { visible, hidden } = await counts(queueUrl);
      if (visible + hidden === 0) break;
    }
    expect(await balanceOf(w.walletId)).toBe('70.00');
  }, 25_000);

  test('shutdown: stop espera a mensagem em andamento e não deixa nada pela metade', async () => {
    const w = await newWallet();
    await send(wagerBody(w, 'msg-shutdown'), w.walletId);
    let started!: () => void;
    const inFlight = new Promise<void>((resolve) => (started = resolve));
    const slow: MessageProcessor = {
      execute: async (body) => {
        started();
        await Bun.sleep(500);
        return real.execute(body);
      },
    };
    const c = consumer(slow, { waitTimeSeconds: 1 });

    c.start();
    await inFlight;
    await c.stop();

    expect(await balanceOf(w.walletId)).toBe('90.00');
    expect(await counts(queueUrl)).toEqual({ visible: 0, hidden: 0 });
  });
});

async function readDlqPeek() {
  const res = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['ApproximateNumberOfMessages'] }),
  );
  return Number(res.Attributes!.ApproximateNumberOfMessages);
}
