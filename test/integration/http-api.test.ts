import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { OpenWalletUseCase } from '../../src/application/open-wallet.use-case';
import { QueryWalletsUseCase } from '../../src/application/query-wallets.use-case';
import { SubmitWagerTransactionUseCase } from '../../src/application/submit-wager-transaction.use-case';
import { ApiExceptionFilter } from '../../src/http/api-exception.filter';
import { WageringController } from '../../src/http/wagering.controller';
import { createTestDatabase, type TestDatabase } from '../helpers/database';

let db: TestDatabase;
let app: INestApplication;
let baseUrl: string;
let seq = 0;

beforeAll(async () => {
  db = await createTestDatabase();
  const openWallet = new OpenWalletUseCase(db.orm.em as any);
  const submitTransaction = new SubmitWagerTransactionUseCase(db.orm.em as any);
  const queries = new QueryWalletsUseCase(db.orm.em as any);
  class ApiTestModule {}
  Module({
    controllers: [WageringController],
    providers: [
      { provide: OpenWalletUseCase, useValue: openWallet },
      { provide: SubmitWagerTransactionUseCase, useValue: submitTransaction },
      { provide: QueryWalletsUseCase, useValue: queries },
    ],
  })(ApiTestModule);
  app = await NestFactory.create(ApiTestModule, { logger: false });
  app.useGlobalFilters(new ApiExceptionFilter());
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
});

afterAll(async () => {
  await app.close();
  await db.drop();
});

async function post(path: string, body: unknown, headers?: Record<string, string>) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function newWallet(balance = '100.00') {
  const response = await post('/wallets', {
    playerId: `api-player-${++seq}`,
    initialBalance: { amount: balance, currency: 'BRL' },
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string; playerId: string };
}

function wager(wallet: { id: string; playerId: string }, overrides: Record<string, unknown> = {}) {
  return {
    providerId: 'api-provider',
    externalTransactionId: `api-ext-${++seq}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'api-round',
    gameId: 'api-game',
    kind: 'BET',
    money: { amount: '10.00', currency: 'BRL' },
    ...overrides,
  };
}

describe('HTTP API', () => {
  test('cria e consulta carteira', async () => {
    const created = await post('/wallets', {
      playerId: 'http-player',
      initialBalance: { amount: '20.00', currency: 'BRL' },
    });
    expect(created.status).toBe(201);
    const wallet = (await created.json()) as { id: string; balance: { amount: string }; version: number };
    expect(wallet.balance.amount).toBe('20.00');
    expect(wallet.version).toBe(1);

    const read = await fetch(`${baseUrl}/wallets/${wallet.id}`);
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({
      id: wallet.id,
      playerId: 'http-player',
      balance: { amount: '20.00', currency: 'BRL' },
      version: 1,
    });
  });

  test('recusa chave de idempotência ausente e payload inválido', async () => {
    const wallet = await newWallet();
    const missingKey = await post('/wagering/transactions', wager(wallet));
    expect(missingKey.status).toBe(400);
    expect((await json<{ code: string }>(missingKey)).code).toBe('IDEMPOTENCY_KEY_REQUIRED');

    const invalid = await post(
      '/wagering/transactions',
      wager(wallet, { kind: 'OPENING' }),
      { 'Idempotency-Key': 'invalid-kind' },
    );
    expect(invalid.status).toBe(400);
  });

  test('recusa walletId que não é UUID com 400, sem estourar 500', async () => {
    const wallet = await newWallet();
    const response = await post(
      '/wagering/transactions',
      wager(wallet, { walletId: 'not-a-uuid' }),
      { 'Idempotency-Key': 'bad-wallet-id' },
    );
    expect(response.status).toBe(400);
  });

  test('mapeia duplicidade e parâmetros de consulta inválidos', async () => {
    const playerId = `duplicate-player-${++seq}`;
    const body = { playerId, initialBalance: { amount: '0.00', currency: 'BRL' } };
    expect((await post('/wallets', body)).status).toBe(201);
    expect((await post('/wallets', body)).status).toBe(409);

    const wallet = await newWallet();
    expect((await fetch(`${baseUrl}/wallets/${wallet.id}/ledger?limit=101`)).status).toBe(400);
    expect((await fetch(`${baseUrl}/wallets/${wallet.id}/ledger?cursor=not-a-cursor`)).status).toBe(400);
    expect((await fetch(`${baseUrl}/wallets/not-a-uuid`)).status).toBe(400);
  });

  test('processa a aposta e repete a resposta pela mesma chave', async () => {
    const wallet = await newWallet();
    const body = wager(wallet);
    const headers = { 'Idempotency-Key': `key-${seq}` };
    const first = await post('/wagering/transactions', body, headers);
    expect(first.status).toBe(201);
    const firstResult = await json<{ transactionId: string }>(first);
    const replay = await post('/wagering/transactions', body, headers);
    expect(replay.status).toBe(201);
    const replayResult = await json<{
      transactionId: string;
      balance: { amount: string; currency: string };
      idempotentReplay: boolean;
    }>(replay);
    expect(replayResult.transactionId).toBe(firstResult.transactionId);
    expect(replayResult.balance).toEqual({ amount: '90.00', currency: 'BRL' });
    expect(replayResult.idempotentReplay).toBe(true);

    const transaction = await fetch(`${baseUrl}/wagering/transactions/${firstResult.transactionId}`);
    expect(transaction.status).toBe(200);
    expect((await json<{ status: string }>(transaction)).status).toBe('PROCESSED');
    const byProvider = await fetch(
      `${baseUrl}/providers/api-provider/wagering/transactions/${body.externalTransactionId}`,
    );
    expect(byProvider.status).toBe(200);
  });

  test('separa rejeição, referência pendente e conflito de idempotência', async () => {
    const lowBalance = await newWallet('5.00');
    const rejectedBody = wager(lowBalance);
    const rejected = await post('/wagering/transactions', rejectedBody, { 'Idempotency-Key': `reject-${seq}` });
    expect(rejected.status).toBe(422);
    expect((await json<{ failureCode: string }>(rejected)).failureCode).toBe('INSUFFICIENT_FUNDS');

    const wallet = await newWallet();
    const pending = await post(
      '/wagering/transactions',
      wager(wallet, { kind: 'REFUND', referenceExternalTransactionId: 'not-here' }),
      { 'Idempotency-Key': `pending-${seq}` },
    );
    expect(pending.status).toBe(202);

    const conflictBody = wager(wallet);
    const conflictKey = `conflict-${seq}`;
    await post('/wagering/transactions', conflictBody, { 'Idempotency-Key': conflictKey });
    const conflict = await post(
      '/wagering/transactions',
      { ...conflictBody, money: { amount: '11.00', currency: 'BRL' } },
      { 'Idempotency-Key': conflictKey },
    );
    expect(conflict.status).toBe(409);
  });

  test('pagina ledger com cursor e reconcilia o saldo', async () => {
    const wallet = await newWallet('20.00');
    await post('/wagering/transactions', wager(wallet), { 'Idempotency-Key': `ledger-${seq}` });
    const first = await fetch(`${baseUrl}/wallets/${wallet.id}/ledger?limit=1`);
    expect(first.status).toBe(200);
    const firstPage = await json<{ entries: unknown[]; nextCursor: string | null }>(first);
    expect(firstPage.entries).toHaveLength(1);
    expect(firstPage.nextCursor).toEqual(expect.any(String));
    if (!firstPage.nextCursor) {
      throw new Error('expected a cursor for the second page');
    }

    const second = await fetch(
      `${baseUrl}/wallets/${wallet.id}/ledger?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor)}`,
    );
    expect((await json<{ entries: unknown[] }>(second)).entries).toHaveLength(1);

    const reconciliation = await post(`/wallets/${wallet.id}/reconciliation`, {});
    expect(reconciliation.status).toBe(201);
    expect((await json<{ consistent: boolean }>(reconciliation)).consistent).toBe(true);
  });
});
