import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { OpenWalletUseCase } from '../../src/application/open-wallet.use-case';
import { createTestDatabase, type TestDatabase } from '../helpers/database';

// Cinco processos disputam as carteiras por HTTP e SQS, com duplicatas e uma queda durante a carga.
const INSTANCES = 5;
const BASE_PORT = 3410;
const WALLETS = 4;
const BETS_PER_WALLET = 160; // 80 por HTTP e 80 por SQS, cada uma enviada duas vezes
const INITIAL_BALANCE = 100; // só 100 das 160 apostas de 1.00 cabem
const REFUND_PAIRS = 10;

const endpoint = process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566';

type Instance = { index: number; port: number; proc: ReturnType<typeof Bun.spawn> | undefined };

let db: TestDatabase;
let sqs: SQSClient;
let open: OpenWalletUseCase;
let inputUrl: string;
let dlqUrl: string;
let eventsUrl: string;
const instances: Instance[] = [];
let seq = 0;

async function createQueue(name: string, attributes: Record<string, string> = {}) {
  const res = await sqs.send(
    new CreateQueueCommand({
      QueueName: `${name}-${randomUUID()}.fifo`,
      Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false', ...attributes },
    }),
  );
  return res.QueueUrl!;
}

function spawnInstance(instance: Instance): void {
  instance.proc = Bun.spawn([process.execPath, 'run', 'src/main.ts'], {
    cwd: process.cwd(),
    stdout: 'ignore',
    stderr: 'ignore',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(instance.port),
      DATABASE_URL: db.orm.config.get('clientUrl') as string,
      AWS_ENDPOINT_URL: endpoint,
      AWS_ACCESS_KEY_ID: 'test',
      AWS_SECRET_ACCESS_KEY: 'test',
      SQS_QUEUE_URL: inputUrl,
      SQS_DLQ_URL: dlqUrl,
      OUTBOX_QUEUE_URL: eventsUrl,
      SQS_WAIT_TIME_SECONDS: '1',
      PENDING_REFERENCE_POLL_INTERVAL_MS: '500',
    },
  });
}

async function waitReady(instance: Instance, timeoutMs = 40_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${instance.port}/health/ready`);
      if (res.status === 200) return;
    } catch {
      // A instância pode ainda estar iniciando.
    }
    await Bun.sleep(300);
  }
  throw new Error(`instance ${instance.index} did not become ready`);
}

async function kill(instance: Instance): Promise<void> {
  instance.proc?.kill();
  await instance.proc?.exited;
  instance.proc = undefined;
}

beforeAll(async () => {
  db = await createTestDatabase();
  sqs = new SQSClient({ region: 'us-east-1', endpoint, credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
  open = new OpenWalletUseCase(db.orm.em as any);
  // Reduz a espera pela redelivery após a queda.
  inputUrl = await createQueue('multi-input', { VisibilityTimeout: '5' });
  dlqUrl = await createQueue('multi-dlq');
  eventsUrl = await createQueue('multi-events');

  for (let i = 0; i < INSTANCES; i++) {
    const instance: Instance = { index: i, port: BASE_PORT + i, proc: undefined };
    instances.push(instance);
    spawnInstance(instance);
  }
  await Promise.all(instances.map((instance) => waitReady(instance)));
}, 120_000);

afterAll(async () => {
  await Promise.all(instances.map(kill));
  for (const url of [inputUrl, dlqUrl, eventsUrl]) await sqs.send(new DeleteQueueCommand({ QueueUrl: url }));
  sqs.destroy();
  await db.drop();
});

async function pool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < items.length) await fn(items[next++]!);
    }),
  );
}

// Tenta outra instância com a mesma chave se uma não responder.
async function postTransaction(startAt: number, key: string, body: unknown): Promise<number> {
  for (let attempt = 0; attempt < INSTANCES * 3; attempt++) {
    const instance = instances[(startAt + attempt) % INSTANCES]!;
    try {
      const res = await fetch(`http://127.0.0.1:${instance.port}/wagering/transactions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': key },
        body: JSON.stringify(body),
      });
      await res.text();
      if (res.status < 500) return res.status;
    } catch {
      // Tenta a próxima instância.
    }
    await Bun.sleep(200);
  }
  return 599;
}

const sendMessage = (walletId: string, body: unknown) =>
  sqs.send(
    new SendMessageCommand({
      QueueUrl: inputUrl,
      MessageBody: JSON.stringify(body),
      MessageGroupId: walletId,
      MessageDeduplicationId: randomUUID(),
    }),
  );

interface Wallet {
  walletId: string;
  playerId: string;
}

const betFields = (w: Wallet, ext: string, kind = 'BET', amount = '1.00', reference?: string) => ({
  providerId: 'prov',
  externalTransactionId: ext,
  idempotencyKey: `idem-${ext}`,
  walletId: w.walletId,
  playerId: w.playerId,
  roundId: 'round-1',
  gameId: 'game-1',
  kind,
  money: { amount, currency: 'BRL' },
  ...(reference && { referenceExternalTransactionId: reference }),
});

const sqsEnvelope = (data: object, messageId: string) => ({
  messageId,
  type: 'WagerTransactionRequested',
  occurredAt: new Date().toISOString(),
  data,
});

async function queueDepth(url: string): Promise<number> {
  const res = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: url,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );
  return Number(res.Attributes!.ApproximateNumberOfMessages) + Number(res.Attributes!.ApproximateNumberOfMessagesNotVisible);
}

async function value(sql: string, params: unknown[] = []): Promise<number> {
  return Number((await db.sql(sql, params))[0].v);
}

describe('várias instâncias reais', () => {
  test(`${INSTANCES} instâncias, HTTP + SQS, duplicatas, estorno antes da aposta e uma instância morta no meio`, async () => {
    const wallets: Wallet[] = [];
    for (let i = 0; i < WALLETS + 1; i++) {
      const playerId = `multi-player-${++seq}`;
      const created = await open.execute({
        playerId,
        currency: 'BRL',
        initialBalance: i < WALLETS ? INITIAL_BALANCE.toFixed(2) : '100.00',
      });
      wallets.push({ walletId: created.walletId, playerId });
    }
    const loadWallets = wallets.slice(0, WALLETS);
    const refundWallet = wallets[WALLETS]!;

    const lateBets = Array.from({ length: REFUND_PAIRS }, (_, i) => `late-bet-${i}`);
    const refundStatuses: number[] = [];
    await pool(lateBets, 5, async (betExt) => {
      const body = betFields(refundWallet, `refund-of-${betExt}`, 'REFUND', '10.00', betExt);
      refundStatuses.push(await postTransaction(seq++, `idem-refund-of-${betExt}`, body));
    });
    expect(refundStatuses.every((status) => status === 202)).toBe(true);

    const jobs: (() => Promise<void>)[] = [];
    const httpStatuses: number[] = [];
    for (const w of loadWallets) {
      for (let n = 0; n < BETS_PER_WALLET; n++) {
        const ext = `bet-${w.walletId}-${n}`;
        if (n % 2 === 0) {
          const body = betFields(w, ext);
          for (let copy = 0; copy < 2; copy++) {
            jobs.push(async () => void httpStatuses.push(await postTransaction(seq++, `idem-${ext}`, body)));
          }
        } else {
          const envelope = sqsEnvelope(betFields(w, ext), `msg-${ext}`);
          for (let copy = 0; copy < 2; copy++) jobs.push(async () => void (await sendMessage(w.walletId, envelope)));
        }
      }
    }
    for (const betExt of lateBets) {
      const envelope = sqsEnvelope(betFields(refundWallet, betExt, 'BET', '10.00'), `msg-${betExt}`);
      jobs.push(async () => void (await sendMessage(refundWallet.walletId, envelope)));
    }
    jobs.sort(() => Math.random() - 0.5);

    const victim = instances[0]!;
    const chaos = (async () => {
      await Bun.sleep(1_500);
      await kill(victim);
      await Bun.sleep(3_000);
      spawnInstance(victim);
      await waitReady(victim);
    })();

    await Promise.all([pool(jobs, 24, (job) => job()), chaos]);
    expect(httpStatuses.filter((status) => status >= 500)).toEqual([]);

    const uniqueTransactions = WALLETS * BETS_PER_WALLET + REFUND_PAIRS * 2 + wallets.length; // + a transação OPENING de cada carteira
    const deadline = Date.now() + 120_000;
    let state = {};
    let settled = false;
    while (Date.now() < deadline && !settled) {
      const total = await value(`select count(*)::int as v from wager_transactions`);
      const open_ = await value(
        `select count(*)::int as v from wager_transactions where status in ('PENDING','PENDING_REFERENCE')`,
      );
      const unpublished = await value(`select count(*)::int as v from outbox_messages where published_at is null`);
      const inFlight = await queueDepth(inputUrl);
      state = { total, expected: uniqueTransactions, open: open_, unpublished, inFlight };
      settled = total === uniqueTransactions && open_ === 0 && unpublished === 0 && inFlight === 0;
      if (!settled) await Bun.sleep(500);
    }
    if (!settled) {
      const detail = await db.sql(
        `select wallet_id, kind, status, coalesce(failure_code,'') as fc, count(*)::int as n
           from wager_transactions group by 1,2,3,4 order by 1,2,3,4`,
      );
      console.log(JSON.stringify({ detail }));
    }
    expect(state).toEqual({ total: uniqueTransactions, expected: uniqueTransactions, open: 0, unpublished: 0, inFlight: 0 });

    expect(await value(`select count(*)::int as v from wager_transactions`)).toBe(uniqueTransactions);
    expect(
      await value(`select count(*)::int as v from (select idempotency_key from wager_transactions group by 1 having count(*) > 1) d`),
    ).toBe(0);
    expect(await value(`select count(*)::int as v from inbox_messages`)).toBe((WALLETS * BETS_PER_WALLET) / 2 + REFUND_PAIRS);

    for (const w of loadWallets) {
      const processed = await value(
        `select count(*)::int as v from wager_transactions where wallet_id = ? and kind = 'BET' and status = 'PROCESSED'`,
        [w.walletId],
      );
      const rejected = await db.sql(
        `select failure_code, count(*)::int as n from wager_transactions where wallet_id = ? and status = 'REJECTED' group by 1`,
        [w.walletId],
      );
      expect(processed).toBe(INITIAL_BALANCE);
      expect(rejected).toEqual([{ failure_code: 'INSUFFICIENT_FUNDS', n: BETS_PER_WALLET - INITIAL_BALANCE }]);

      const wallet = (await db.sql(`select balance::text as b from wallets where id = ?`, [w.walletId]))[0];
      expect(wallet.b).toBe('0.00');
      const ledger = (
        await db.sql(
          `select coalesce(sum(case direction when 'CREDIT' then amount else -amount end), 0)::text as s, count(*)::int as n
             from wallet_ledger_entries where wallet_id = ?`,
          [w.walletId],
        )
      )[0];
      expect(ledger.s).toBe(wallet.b); // o ledger (incluindo o crédito inicial) fecha com o saldo
      expect(ledger.n).toBe(INITIAL_BALANCE + 1);
    }

    const refunded = await db.sql(`select status, count(*)::int as n from wager_transactions where wallet_id = ? group by 1`, [
      refundWallet.walletId,
    ]);
    expect(refunded).toEqual([{ status: 'PROCESSED', n: REFUND_PAIRS * 2 + 1 }]); // + OPENING
    expect((await db.sql(`select balance::text as b from wallets where id = ?`, [refundWallet.walletId]))[0].b).toBe('100.00');

    expect(
      await value(`select count(*)::int as v from (select transaction_id from wallet_ledger_entries group by 1 having count(*) > 1) d`),
    ).toBe(0);
    expect(await value(`select count(*)::int as v from wallets where balance < 0`)).toBe(0);
    expect(await queueDepth(dlqUrl)).toBe(0);

    const events = await value(`select count(*)::int as v from outbox_messages`);
    expect(events).toBeGreaterThan(uniqueTransactions);
    expect(await value(`select count(*)::int as v from outbox_messages where published_at is null`)).toBe(0);

    for (const w of wallets) {
      const res = await fetch(`http://127.0.0.1:${instances[1]!.port}/wallets/${w.walletId}/reconciliation`, { method: 'POST' });
      expect(((await res.json()) as { consistent: boolean }).consistent).toBe(true);
    }

    let active = 0;
    for (const instance of instances) {
      const text = await (await fetch(`http://127.0.0.1:${instance.port}/metrics`)).text();
      if (/wagering_transactions_total\{[^}]*\} [1-9]/.test(text)) active++;
    }
    expect(active).toBeGreaterThanOrEqual(3);
  }, 300_000);
});
