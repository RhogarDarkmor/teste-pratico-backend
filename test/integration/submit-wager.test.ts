import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { OpenWalletUseCase } from '../../src/application/open-wallet.use-case';
import {
  type SubmitWagerCommand,
  SubmitWagerTransactionUseCase,
} from '../../src/application/submit-wager-transaction.use-case';
import { IdempotencyConflictError, WalletAlreadyExistsError, WalletNotFoundError } from '../../src/application/errors';
import { FailureCode } from '../../src/domain/wagering/failure-code';
import { WagerTransactionKind, WagerTransactionStatus as S } from '../../src/domain/wagering/wager-transaction';
import { createTestDatabase, type TestDatabase } from '../helpers/database';

let db: TestDatabase;
let open: OpenWalletUseCase;
let submit: SubmitWagerTransactionUseCase;
let seq = 0;

beforeAll(async () => {
  db = await createTestDatabase();
  open = new OpenWalletUseCase(db.orm.em as any);
  submit = new SubmitWagerTransactionUseCase(db.orm.em as any);
});

afterAll(async () => {
  await db.drop();
});

async function newWallet(balance = '100.00') {
  const playerId = `player-${++seq}`;
  const wallet = await open.execute({ playerId, currency: 'BRL', initialBalance: balance });
  return { walletId: wallet.walletId, playerId };
}

function cmd(
  w: { walletId: string; playerId: string },
  overrides: Partial<SubmitWagerCommand> = {},
): SubmitWagerCommand {
  const n = ++seq;
  return {
    providerId: 'prov',
    externalTransactionId: `ext-${n}`,
    idempotencyKey: `idem-${n}`,
    walletId: w.walletId,
    playerId: w.playerId,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Bet,
    amount: '10.00',
    currency: 'BRL',
    ...overrides,
  };
}

async function balanceOf(walletId: string): Promise<string> {
  const rows = await db.sql('select balance::text as b from wallets where id = ?', [walletId]);
  return rows[0].b;
}

async function ledgerSum(walletId: string): Promise<string> {
  const rows = await db.sql(
    `select coalesce(sum(case direction when 'CREDIT' then amount else -amount end), 0)::text as s
       from wallet_ledger_entries where wallet_id = ?`,
    [walletId],
  );
  return rows[0].s;
}

describe('open wallet', () => {
  test('abre com saldo e registra OPENING + ledger + outbox', async () => {
    const w = await newWallet('50.00');
    expect(await balanceOf(w.walletId)).toBe('50.00');
    expect(await ledgerSum(w.walletId)).toBe('50.00');
    const outbox = await db.sql('select event_type from outbox_messages where aggregate_id = ?', [w.walletId]);
    expect(outbox.map((r) => r.event_type)).toEqual(['WalletBalanceChanged']);
  });

  test('saldo zero não gera ledger', async () => {
    const w = await newWallet('0.00');
    expect(await ledgerSum(w.walletId)).toBe('0');
  });

  test('mesmo jogador e moeda duas vezes dá conflito', async () => {
    const w = await newWallet();
    await expect(open.execute({ playerId: w.playerId, currency: 'BRL', initialBalance: '1.00' })).rejects.toBeInstanceOf(
      WalletAlreadyExistsError,
    );
  });
});

describe('submit wager', () => {
  test('BET debita e WIN credita', async () => {
    const w = await newWallet('100.00');
    const bet = await submit.execute(cmd(w, { externalTransactionId: 'bet-a', amount: '30.00' }));
    expect(bet.status).toBe(S.Processed);
    expect(bet.balance.toString()).toBe('70.00');

    const win = await submit.execute(
      cmd(w, { kind: WagerTransactionKind.Win, amount: '50.00', referenceExternalTransactionId: 'bet-a' }),
    );
    expect(win.balance.toString()).toBe('120.00');
    expect(await ledgerSum(w.walletId)).toBe('120.00');
  });

  test('carteira inexistente', async () => {
    const w = { walletId: '018f0000-0000-7000-8000-000000000000', playerId: 'x' };
    await expect(submit.execute(cmd(w))).rejects.toBeInstanceOf(WalletNotFoundError);
  });

  test('replay devolve o saldo da primeira resposta, mesmo com saldo já alterado', async () => {
    const w = await newWallet('100.00');
    const first = cmd(w, { amount: '10.00' });
    const r1 = await submit.execute(first);
    await submit.execute(cmd(w, { amount: '20.00' }));

    const r2 = await submit.execute(first);
    expect(r2.idempotentReplay).toBe(true);
    expect(r2.transactionId).toBe(r1.transactionId);
    expect(r2.balance.toString()).toBe('90.00');
    expect(await balanceOf(w.walletId)).toBe('70.00');
  });

  test('mesma chave com payload diferente é conflito', async () => {
    const w = await newWallet();
    const first = cmd(w);
    await submit.execute(first);
    await expect(submit.execute({ ...first, amount: '11.00' })).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  test('saldo insuficiente rejeita sem mexer na carteira', async () => {
    const w = await newWallet('5.00');
    const r = await submit.execute(cmd(w, { amount: '10.00' }));
    expect(r.status).toBe(S.Rejected);
    expect(r.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(await balanceOf(w.walletId)).toBe('5.00');
  });

  test('REFUND antes da BET fica aguardando referência', async () => {
    const w = await newWallet();
    const r = await submit.execute(
      cmd(w, { kind: WagerTransactionKind.Refund, referenceExternalTransactionId: 'nao-chegou' }),
    );
    expect(r.status).toBe(S.PendingReference);
    expect(await balanceOf(w.walletId)).toBe('100.00');
  });

  test('segunda reversão da mesma bet é rejeitada', async () => {
    const w = await newWallet();
    await submit.execute(cmd(w, { externalTransactionId: 'bet-r', amount: '10.00' }));
    const refund = await submit.execute(
      cmd(w, { kind: WagerTransactionKind.Refund, amount: '10.00', referenceExternalTransactionId: 'bet-r' }),
    );
    expect(refund.status).toBe(S.Processed);
    const again = await submit.execute(
      cmd(w, { kind: WagerTransactionKind.Rollback, amount: '10.00', referenceExternalTransactionId: 'bet-r' }),
    );
    expect(again.failureCode).toBe(FailureCode.AlreadyReversed);
    expect(await balanceOf(w.walletId)).toBe('100.00');
  });
});

describe('concorrência', () => {
  test('50 requisições idênticas em paralelo debitam uma vez só', async () => {
    const w = await newWallet('100.00');
    const same = cmd(w, { amount: '10.00' });
    const results = await Promise.all(Array.from({ length: 50 }, () => submit.execute(same)));

    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    expect(results.filter((r) => !r.idempotentReplay).length).toBe(1);
    expect(await balanceOf(w.walletId)).toBe('90.00');
    const rows = await db.sql('select count(*)::int as c from wager_transactions where wallet_id = ?', [w.walletId]);
    expect(rows[0].c).toBe(2); // OPENING + BET
  });

  test('duas apostas de 80 com saldo 100: uma passa, outra é rejeitada', async () => {
    const w = await newWallet('100.00');
    const results = await Promise.all([
      submit.execute(cmd(w, { amount: '80.00' })),
      submit.execute(cmd(w, { amount: '80.00' })),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([S.Processed, S.Rejected]);
    expect(await balanceOf(w.walletId)).toBe('20.00');
  });

  test('carteira quente com muitas chaves diferentes mantém o saldo igual ao ledger', async () => {
    const w = await newWallet('1000.00');
    const results = await Promise.all(Array.from({ length: 60 }, () => submit.execute(cmd(w, { amount: '10.00' }))));
    expect(results.every((r) => r.status === S.Processed)).toBe(true);
    expect(await balanceOf(w.walletId)).toBe('400.00');
    expect(await ledgerSum(w.walletId)).toBe('400.00');
  });

  test('carteiras diferentes em paralelo não se atrapalham', async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, () => newWallet('100.00')));
    await Promise.all(wallets.map((w) => submit.execute(cmd(w, { amount: '25.00' }))));
    for (const w of wallets) {
      expect(await balanceOf(w.walletId)).toBe('75.00');
    }
  });
});
