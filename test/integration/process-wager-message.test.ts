import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { InvalidMessageError, WalletNotFoundError } from '../../src/application/errors';
import { OpenWalletUseCase } from '../../src/application/open-wallet.use-case';
import { ProcessWagerMessageUseCase } from '../../src/application/process-wager-message.use-case';
import { SubmitWagerTransactionUseCase } from '../../src/application/submit-wager-transaction.use-case';
import { createTestDatabase, type TestDatabase } from '../helpers/database';

let db: TestDatabase;
let open: OpenWalletUseCase;
let processor: ProcessWagerMessageUseCase;
let seq = 0;

beforeAll(async () => {
  db = await createTestDatabase();
  open = new OpenWalletUseCase(db.orm.em as any);
  processor = new ProcessWagerMessageUseCase(db.orm.em as any, new SubmitWagerTransactionUseCase(db.orm.em as any));
});

afterAll(async () => {
  await db.drop();
});

async function newWallet(balance = '100.00') {
  const playerId = `player-${++seq}`;
  const wallet = await open.execute({ playerId, currency: 'BRL', initialBalance: balance });
  return { walletId: wallet.walletId, playerId };
}

function message(
  w: { walletId: string; playerId: string },
  overrides: { messageId?: string; data?: Record<string, unknown> } = {},
) {
  const n = ++seq;
  return JSON.stringify({
    messageId: overrides.messageId ?? `msg-${n}`,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: 'prov',
      externalTransactionId: `ext-${n}`,
      idempotencyKey: `idem-${n}`,
      walletId: w.walletId,
      playerId: w.playerId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
      ...overrides.data,
    },
  });
}

const balanceOf = async (walletId: string) =>
  (await db.sql('select balance::text as balance from wallets where id = ?', [walletId]))[0].balance;
const inboxCount = async (messageId: string) =>
  (await db.sql('select count(*)::int as n from inbox_messages where message_id = ?', [messageId]))[0].n;

describe('ProcessWagerMessageUseCase', () => {
  test('processa a mensagem, grava a inbox como processada e gera outbox', async () => {
    const w = await newWallet();
    const outcome = await processor.execute(message(w, { messageId: 'msg-ok' }));

    expect(outcome.kind).toBe('processed');
    expect(await balanceOf(w.walletId)).toBe('90.00');
    const [inbox] = await db.sql('select processed_at from inbox_messages where message_id = ?', ['msg-ok']);
    expect(inbox.processed_at).not.toBeNull();
    const [events] = await db.sql(
      `select count(*)::int as n from outbox_messages where event_type = 'WagerTransactionProcessed' and aggregate_id = ?`,
      [w.walletId],
    );
    expect(events.n).toBeGreaterThanOrEqual(1);
  });

  test('a mesma mensagem entregue de novo vira duplicada e não mexe no saldo', async () => {
    const w = await newWallet();
    const body = message(w, { messageId: 'msg-dup' });

    expect((await processor.execute(body)).kind).toBe('processed');
    expect((await processor.execute(body)).kind).toBe('duplicate');
    expect(await balanceOf(w.walletId)).toBe('90.00');
  });

  test('entregas simultâneas da mesma mensagem aplicam o efeito uma vez só', async () => {
    const w = await newWallet();
    const body = message(w, { messageId: 'msg-race' });

    const outcomes = await Promise.all(Array.from({ length: 6 }, () => processor.execute(body)));

    expect(outcomes.filter((o) => o.kind === 'processed')).toHaveLength(1);
    expect(outcomes.filter((o) => o.kind === 'duplicate')).toHaveLength(5);
    expect(await balanceOf(w.walletId)).toBe('90.00');
  });

  test('mesmo messageId com conteúdo diferente é recusado', async () => {
    const w = await newWallet();
    await processor.execute(message(w, { messageId: 'msg-reuse' }));

    await expect(processor.execute(message(w, { messageId: 'msg-reuse' }))).rejects.toThrow(InvalidMessageError);
    expect(await balanceOf(w.walletId)).toBe('90.00');
  });

  test('rejeição de negócio é resultado, a inbox fica processada e o saldo não muda', async () => {
    const w = await newWallet('5.00');
    const outcome = await processor.execute(message(w, { messageId: 'msg-poor' }));

    expect(outcome).toMatchObject({ kind: 'processed', result: { status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS' } });
    expect(await balanceOf(w.walletId)).toBe('5.00');
    expect(await inboxCount('msg-poor')).toBe(1);
  });

  test('se o caso de uso falha, a inbox também é desfeita (tudo ou nada)', async () => {
    const ghost = { walletId: '0192f291-27dd-7d3f-8071-5f8685deef37', playerId: 'ghost' };

    await expect(processor.execute(message(ghost, { messageId: 'msg-ghost' }))).rejects.toThrow(WalletNotFoundError);
    expect(await inboxCount('msg-ghost')).toBe(0);
  });
});
