import os from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { OpenWalletUseCase } from '../src/application/open-wallet.use-case';
import { createTestDatabase, type TestDatabase } from './helpers/database';

const INSTANCE_COUNT = 3;
const REQUEST_COUNT = Number(process.env.LOAD_REQUESTS ?? 300);
const CONCURRENCY = Number(process.env.LOAD_CONCURRENCY ?? 24);
const PORT_BASE = process.env.LOAD_BASE_PORT === undefined ? undefined : Number(process.env.LOAD_BASE_PORT);
const API_READY_TIMEOUT_MS = 60_000;
const OUTBOX_DRAIN_TIMEOUT_MS = 120_000;
const AWS_ENDPOINT = process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566';

type ApiInstance = {
  port: number;
  process: ReturnType<typeof Bun.spawn>;
};

type RequestResult = {
  durationMs: number;
  status: number;
  transportError?: string;
};

function percentile(values: number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil(percentileValue * sorted.length) - 1;
  return sorted[Math.max(0, index)]!;
}

function metricValue(text: string, name: string): number {
  const line = text.split('\n').find((entry) => entry.startsWith(`${name} `));
  return line ? Number(line.slice(name.length + 1)) : 0;
}

function metricTotal(text: string, name: string): number {
  return text
    .split('\n')
    .filter((line) => line.startsWith(`${name}{`))
    .reduce((sum, line) => sum + Number(line.slice(line.lastIndexOf(' ') + 1)), 0);
}

async function createQueue(sqs: SQSClient, name: string): Promise<string> {
  const response = await sqs.send(
    new CreateQueueCommand({
      QueueName: `${name}-${randomUUID()}.fifo`,
      Attributes: {
        FifoQueue: 'true',
        ContentBasedDeduplication: 'false',
      },
    }),
  );
  if (!response.QueueUrl) throw new Error(`SQS did not return a URL for ${name}`);
  return response.QueueUrl;
}

async function reservePort(): Promise<number> {
  const server = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: { data() {} },
  });
  const port = server.port;
  server.stop(true);
  return port;
}

function startInstance(port: number, databaseUrl: string, inputQueue: string, outboxQueue: string) {
  return Bun.spawn([process.execPath, 'run', 'src/main.ts'], {
    cwd: process.cwd(),
    stdout: 'ignore',
    stderr: 'ignore',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      DATABASE_URL: databaseUrl,
      AWS_ENDPOINT_URL: AWS_ENDPOINT,
      AWS_REGION: process.env.AWS_REGION ?? 'us-east-1',
      AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID ?? 'test',
      AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
      SQS_QUEUE_URL: inputQueue,
      OUTBOX_QUEUE_URL: outboxQueue,
      SQS_CONSUMER_ENABLED: 'false',
      PENDING_REFERENCE_WORKER_ENABLED: 'false',
      OUTBOX_PUBLISHER_ENABLED: 'true',
    },
  });
}

async function waitUntilReady(instance: ApiInstance): Promise<void> {
  const deadline = Date.now() + API_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (instance.process.exitCode !== null) {
      throw new Error(`API process on port ${instance.port} exited during startup`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${instance.port}/health/ready`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return;
    } catch {
      // The instance may still be starting.
    }
    await Bun.sleep(250);
  }
  throw new Error(`API instance on port ${instance.port} did not become ready`);
}

async function readMetrics(instances: ApiInstance[]): Promise<string[]> {
  return Promise.all(
    instances.map(async ({ port }) => {
      const response = await fetch(`http://127.0.0.1:${port}/metrics`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (!response.ok) throw new Error(`Could not read metrics from port ${port}: HTTP ${response.status}`);
      return response.text();
    }),
  );
}

async function submit(
  instance: ApiInstance,
  walletId: string,
  playerId: string,
  index: number,
): Promise<RequestResult> {
  const startedAt = performance.now();
  try {
    const response = await fetch(`http://127.0.0.1:${instance.port}/wagering/transactions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': `load-${index}`,
      },
      body: JSON.stringify({
        providerId: 'load-test',
        externalTransactionId: `load-${index}`,
        playerId,
        walletId,
        roundId: 'load-test',
        gameId: 'load-test',
        kind: 'BET',
        money: { amount: '0.01', currency: 'BRL' },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    await response.arrayBuffer();
    return { durationMs: performance.now() - startedAt, status: response.status };
  } catch (error) {
    return {
      durationMs: performance.now() - startedAt,
      status: 0,
      transportError: error instanceof Error ? error.message : String(error),
    };
  }
}

async function runPool<T>(
  count: number,
  concurrency: number,
  task: (index: number) => Promise<T>,
): Promise<T[]> {
  const results = new Array<T>(count);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(count, concurrency) }, async () => {
      while (true) {
        const index = next++;
        if (index >= count) return;
        results[index] = await task(index);
      }
    }),
  );
  return results;
}

async function waitForOutboxToDrain(
  instances: ApiInstance[],
  initialLagSeconds: number,
): Promise<{ maxLagSeconds: number; finalLagSeconds: number }> {
  let maxLagSeconds = initialLagSeconds;
  const deadline = Date.now() + OUTBOX_DRAIN_TIMEOUT_MS;
  let finalLagSeconds = 0;

  while (Date.now() < deadline) {
    const metrics = await readMetrics(instances);
    const lag = Math.max(...metrics.map((text) => metricValue(text, 'outbox_lag_seconds')));
    const pending = Math.max(...metrics.map((text) => metricValue(text, 'outbox_pending_messages')));
    maxLagSeconds = Math.max(maxLagSeconds, lag);
    finalLagSeconds = lag;
    if (pending === 0) return { maxLagSeconds, finalLagSeconds };
    await Bun.sleep(250);
  }

  throw new Error(`Outbox did not drain within ${OUTBOX_DRAIN_TIMEOUT_MS / 1_000} seconds`);
}

async function main(): Promise<void> {
  if (!Number.isInteger(REQUEST_COUNT) || REQUEST_COUNT < 1 || REQUEST_COUNT > 5_000) {
    throw new Error('LOAD_REQUESTS must be an integer between 1 and 5000');
  }
  if (!Number.isInteger(CONCURRENCY) || CONCURRENCY < 1 || CONCURRENCY > REQUEST_COUNT) {
    throw new Error('LOAD_CONCURRENCY must be an integer between 1 and LOAD_REQUESTS');
  }
  if (
    PORT_BASE !== undefined &&
    (!Number.isInteger(PORT_BASE) || PORT_BASE < 1 || PORT_BASE + INSTANCE_COUNT - 1 > 65_535)
  ) {
    throw new Error('LOAD_BASE_PORT must be a valid base port for three API instances');
  }

  let db: TestDatabase | undefined;
  const instances: ApiInstance[] = [];
  const queueUrls: string[] = [];
  const sqs = new SQSClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
    endpoint: AWS_ENDPOINT,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
    },
  });

  try {
    db = await createTestDatabase();
    const inputQueue = await createQueue(sqs, 'wager-load-input');
    queueUrls.push(inputQueue);
    const outboxQueue = await createQueue(sqs, 'wager-load-events');
    queueUrls.push(outboxQueue);
    const databaseUrl = db.orm.config.get('clientUrl') as string;

    for (let i = 0; i < INSTANCE_COUNT; i++) {
      const port = PORT_BASE === undefined ? await reservePort() : PORT_BASE + i;
      const child = startInstance(port, databaseUrl, inputQueue, outboxQueue);
      instances.push({ port, process: child });
    }
    await Promise.all(instances.map(waitUntilReady));

    const wallet = await new OpenWalletUseCase(db.orm.em).execute({
      playerId: `load-player-${randomUUID()}`,
      currency: 'BRL',
      initialBalance: (REQUEST_COUNT / 100 + 1).toFixed(2),
    });
    const walletId = wallet.walletId;
    const playerId = wallet.playerId;
    const baselineMetrics = await readMetrics(instances);
    const lockConflictsBefore = baselineMetrics.reduce(
      (sum, text) => sum + metricTotal(text, 'wagering_lock_conflicts_total'),
      0,
    );

    let nextInstance = 0;
    const startedAt = performance.now();
    const results = await runPool(REQUEST_COUNT, CONCURRENCY, (index) => {
      const instance = instances[nextInstance++ % instances.length]!;
      return submit(instance, walletId, playerId, index);
    });
    const requestDurationSeconds = (performance.now() - startedAt) / 1_000;

    const metricsAtEndOfLoad = await readMetrics(instances);
    const lagAtEndOfLoad = Math.max(
      ...metricsAtEndOfLoad.map((text) => metricValue(text, 'outbox_lag_seconds')),
    );
    const outbox = await waitForOutboxToDrain(instances, lagAtEndOfLoad);
    const finalMetrics = await readMetrics(instances);
    const lockConflictsAfter = finalMetrics.reduce(
      (sum, text) => sum + metricTotal(text, 'wagering_lock_conflicts_total'),
      0,
    );
    const technicalErrors = results.filter((result) => result.status < 200 || result.status >= 500);
    const unexpectedStatuses = results.filter((result) => result.status !== 201);
    const latencies = results.map((result) => result.durationMs);
    const totals = await db.sql(
      `select w.balance::text as balance,
              (select coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end), 0)::text
                 from wallet_ledger_entries l where l.wallet_id = w.id) as ledger_balance,
              (select count(*)::int from wager_transactions t where t.wallet_id = w.id) as transactions,
              (select count(*)::int from wallet_ledger_entries l where l.wallet_id = w.id) as ledger_entries
         from wallets w
        where w.id = ?`,
      [walletId],
    );
    const walletTotals = totals[0];
    const invariants = {
      walletMatchesLedger: Boolean(walletTotals && walletTotals.balance === walletTotals.ledger_balance),
      transactionCountMatches: walletTotals?.transactions === REQUEST_COUNT + 1,
      ledgerEntryCountMatches: walletTotals?.ledger_entries === REQUEST_COUNT + 1,
    };
    const report = {
      date: new Date().toISOString(),
      environment: {
        os: `${os.platform()} ${os.release()}`,
        architecture: os.arch(),
        cpuCores: os.cpus().length,
        memoryGiB: Number((os.totalmem() / 1024 ** 3).toFixed(1)),
        bun: Bun.version,
        postgres: (await db.sql('select version() as version'))[0].version.split(' ').slice(0, 2).join(' '),
        localstack: 'Docker Compose: localstack/localstack:3.8',
      },
      methodology: {
        apiInstances: INSTANCE_COUNT,
        requests: REQUEST_COUNT,
        concurrency: CONCURRENCY,
        walletCount: 1,
        operation: 'HTTP BET of 0.01 BRL with unique idempotency key per request',
        outbox: 'dedicated FIFO queue; lag sampled after the request burst and until all messages are published',
      },
      results: {
        throughputRequestsPerSecond: Number((REQUEST_COUNT / requestDurationSeconds).toFixed(2)),
        requestDurationSeconds: Number(requestDurationSeconds.toFixed(2)),
        latencyMs: {
          p50: Number(percentile(latencies, 0.5).toFixed(2)),
          p95: Number(percentile(latencies, 0.95).toFixed(2)),
          p99: Number(percentile(latencies, 0.99).toFixed(2)),
        },
        technicalErrors: technicalErrors.length,
        technicalErrorRatePercent: Number(((technicalErrors.length / REQUEST_COUNT) * 100).toFixed(2)),
        unexpectedHttpStatuses: unexpectedStatuses.length,
        transportErrors: results.filter((result) => result.transportError !== undefined).length,
        httpStatusCounts: results.reduce<Record<string, number>>((counts, result) => {
          const status = String(result.status);
          counts[status] = (counts[status] ?? 0) + 1;
          return counts;
        }, {}),
        lockConflicts: lockConflictsAfter - lockConflictsBefore,
        maxSampledOutboxLagSeconds: Number(outbox.maxLagSeconds.toFixed(2)),
        finalOutboxLagSeconds: Number(outbox.finalLagSeconds.toFixed(2)),
        walletBalance: walletTotals?.balance ?? null,
        ledgerBalance: walletTotals?.ledger_balance ?? null,
        ledgerEntries: walletTotals?.ledger_entries ?? null,
      },
      invariants,
    };
    console.log(JSON.stringify(report, null, 2));
    if (
      technicalErrors.length > 0 ||
      unexpectedStatuses.length > 0 ||
      Object.values(invariants).some((passed) => !passed)
    ) {
      process.exitCode = 1;
    }
  } finally {
    await Promise.all(
      instances.map(async ({ process: child }) => {
        child.kill();
        await child.exited;
      }),
    );
    for (const queueUrl of queueUrls) {
      await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
    }
    sqs.destroy();
    await db?.drop();
  }
}

await main();
