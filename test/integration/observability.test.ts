import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { Module } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { EntityManager } from '@mikro-orm/postgresql';
import { OpenWalletUseCase } from '../../src/application/open-wallet.use-case';
import { QueryWalletsUseCase } from '../../src/application/query-wallets.use-case';
import { SubmitWagerTransactionUseCase } from '../../src/application/submit-wager-transaction.use-case';
import { ApiExceptionFilter } from '../../src/http/api-exception.filter';
import { WageringController } from '../../src/http/wagering.controller';
import { httpObservability } from '../../src/observability/http-observability';
import { setLogSink } from '../../src/observability/logger';
import { metrics } from '../../src/observability/metrics';
import { MetricsController } from '../../src/observability/metrics.controller';
import { createTestDatabase, type TestDatabase } from '../helpers/database';

let db: TestDatabase;
let app: INestApplication;
let baseUrl: string;
let seq = 0;
let logs: Record<string, any>[] = [];

beforeAll(async () => {
  db = await createTestDatabase();
  class ObservabilityTestModule {}
  Module({
    controllers: [WageringController, MetricsController],
    providers: [
      { provide: EntityManager, useValue: db.orm.em },
      { provide: OpenWalletUseCase, useValue: new OpenWalletUseCase(db.orm.em as any) },
      { provide: SubmitWagerTransactionUseCase, useValue: new SubmitWagerTransactionUseCase(db.orm.em as any) },
      { provide: QueryWalletsUseCase, useValue: new QueryWalletsUseCase(db.orm.em as any) },
    ],
  })(ObservabilityTestModule);
  app = await NestFactory.create(ObservabilityTestModule, { logger: false });
  app.use(httpObservability);
  app.useGlobalFilters(new ApiExceptionFilter());
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
});

afterAll(async () => {
  await app.close();
  await db.drop();
});

beforeEach(() => {
  metrics.reset();
  logs = [];
  setLogSink((line) => logs.push(JSON.parse(line)));
});

afterEach(() => setLogSink(undefined));

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

async function newWallet() {
  const response = await post('/wallets', {
    playerId: `obs-${++seq}`,
    initialBalance: { amount: '100.00', currency: 'BRL' },
  });
  return (await response.json()) as { id: string; playerId: string };
}

const wager = (w: { id: string; playerId: string }, ext: string) => ({
  walletId: w.id,
  providerId: 'prov',
  externalTransactionId: ext,
  playerId: w.playerId,
  roundId: 'r1',
  gameId: 'g1',
  kind: 'BET',
  money: { amount: '12.34', currency: 'BRL' },
});

const scrape = async () => (await fetch(`${baseUrl}/metrics`)).text();

describe('observabilidade', () => {
  test('/metrics mostra transações por status, duplicatas, latência e gauges do banco', async () => {
    const w = await newWallet();
    const body = wager(w, `obs-ext-${++seq}`);
    expect((await post('/wagering/transactions', body, { 'idempotency-key': 'obs-k1' })).status).toBe(201);
    expect((await post('/wagering/transactions', body, { 'idempotency-key': 'obs-k1' })).status).toBe(201);

    const text = await scrape();
    expect(text).toContain('wagering_transactions_total{kind="BET",status="PROCESSED"} 1');
    expect(text).toContain('wagering_duplicates_total{source="idempotency"} 1');
    expect(text).toContain('wagering_processing_duration_seconds_count{origin="http"} 2');
    expect(text).toContain('http_requests_total{method="POST",route="/wagering/transactions",status="201"} 2');
    expect(text).toMatch(/outbox_pending_messages \d+/);
    expect(text).toMatch(/outbox_lag_seconds [\d.]+/);
    expect(text).toMatch(/pending_reference_transactions \d+/);
  });

  test('o outbox lag cresce com mensagens não publicadas', async () => {
    const w = await newWallet();
    await post('/wagering/transactions', wager(w, `obs-ext-${++seq}`), { 'idempotency-key': `obs-k-${++seq}` });
    await db.sql(`update outbox_messages set occurred_at = now() - interval '90 seconds' where published_at is null`);
    const lag = Number((await scrape()).match(/outbox_lag_seconds ([\d.]+)/)![1]);
    expect(lag).toBeGreaterThanOrEqual(90);
  });

  test('o correlationId do cliente volta no header e aparece nos logs, sem valores financeiros', async () => {
    const w = await newWallet();
    const response = await post('/wagering/transactions', wager(w, `obs-ext-${++seq}`), {
      'idempotency-key': `obs-k-${++seq}`,
      'x-correlation-id': 'corr-123',
    });
    expect(response.headers.get('x-correlation-id')).toBe('corr-123');

    const handled = logs.find((l) => l.message === 'wager transaction handled')!;
    expect(handled).toMatchObject({
      correlationId: 'corr-123',
      walletId: w.id,
      providerId: 'prov',
      status: 'PROCESSED',
      level: 'info',
    });
    expect(handled.transactionId).toBeString();
    const request = logs.find((l) => l.message === 'request completed' && l.route === '/wagering/transactions')!;
    expect(request).toMatchObject({ correlationId: 'corr-123', status: 201 });
    expect(JSON.stringify(logs)).not.toContain('12.34');
  });

  test('sem header, gera um correlationId novo', async () => {
    const response = await fetch(`${baseUrl}/wallets/00000000-0000-4000-8000-000000000000`);
    expect(response.headers.get('x-correlation-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('conciliação divergente conta na métrica e loga erro', async () => {
    const w = await newWallet();
    const reconcile = async () =>
      ((await (await post(`/wallets/${w.id}/reconciliation`, {})).json()) as { consistent: boolean }).consistent;
    expect(await reconcile()).toBe(true);
    expect(metrics.reconciliationDivergences.total()).toBe(0);

    await db.sql(`update wallets set balance = balance + 1 where id = ?`, [w.id]);
    expect(await reconcile()).toBe(false);

    expect(metrics.reconciliations.total()).toBe(2);
    expect(metrics.reconciliationDivergences.total()).toBe(1);
    expect(await scrape()).toContain('reconciliation_divergences_total 1');
    const error = logs.find((l) => l.message === 'wallet reconciliation divergence')!;
    expect(error).toMatchObject({ level: 'error', walletId: w.id });
  });
});
