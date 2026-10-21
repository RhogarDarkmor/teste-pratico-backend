import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { OpenWalletUseCase } from '../../src/application/open-wallet.use-case';
import { ReprocessPendingReferencesUseCase } from '../../src/application/reprocess-pending-references.use-case';
import {
  type SubmitWagerCommand,
  SubmitWagerTransactionUseCase,
} from '../../src/application/submit-wager-transaction.use-case';
import { FailureCode } from '../../src/domain/wagering/failure-code';
import { WagerTransactionKind as K, WagerTransactionStatus as S } from '../../src/domain/wagering/wager-transaction';
import { createTestDatabase, type TestDatabase } from '../helpers/database';

let db: TestDatabase;
let open: OpenWalletUseCase;
let submit: SubmitWagerTransactionUseCase;
let reprocess: ReprocessPendingReferencesUseCase;
let seq = 0;

beforeAll(async () => {
  db = await createTestDatabase();
  open = new OpenWalletUseCase(db.orm.em as any);
  submit = new SubmitWagerTransactionUseCase(db.orm.em as any);
  reprocess = new ReprocessPendingReferencesUseCase(db.orm.em as any);
});

afterAll(async () => {
  await db.drop();
});

async function newWallet(balance = '100.00') {
  const playerId = `player-${++seq}`;
  const wallet = await open.execute({ playerId, currency: 'BRL', initialBalance: balance });
  return { walletId: wallet.walletId, playerId };
}

function cmd(w: { walletId: string; playerId: string }, overrides: Partial<SubmitWagerCommand> = {}): SubmitWagerCommand {
  const n = ++seq;
  return {
    providerId: 'prov',
    externalTransactionId: `ext-${n}`,
    idempotencyKey: `idem-${n}`,
    walletId: w.walletId,
    playerId: w.playerId,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: K.Bet,
    amount: '10.00',
    currency: 'BRL',
    ...overrides,
  };
}

const balanceOf = async (id: string) => (await db.sql('select balance::text as b from wallets where id = ?', [id]))[0].b;
const row = async (id: string) =>
  (await db.sql('select status, failure_code, reprocess_attempts, observed_balance::text as ob from wager_transactions where id = ?', [id]))[0];
const events = async (txId: string) =>
  (await db.sql(`select event_type from outbox_messages where payload::text like ? order by occurred_at, id`, [`%${txId}%`])).map(
    (r) => r.event_type as string,
  );
const makeDue = (id: string) => db.sql(`update wager_transactions set next_reprocess_at = now() - interval '1 second' where id = ?`, [id]);

async function pendingRefund(w: { walletId: string; playerId: string }, betExt: string, kind: K = K.Refund) {
  const refund = await submit.execute(cmd(w, { kind, referenceExternalTransactionId: betExt }));
  expect(refund.status).toBe(S.PendingReference);
  return refund.transactionId;
}

describe('reprocessamento de PENDING_REFERENCE', () => {
  test('quando a referência chega, a transação é processada com ledger, saldo e evento', async () => {
    const w = await newWallet('100.00');
    const betExt = `bet-late-${++seq}`;
    const refundId = await pendingRefund(w, betExt);

    await submit.execute(cmd(w, { externalTransactionId: betExt }));
    expect(await balanceOf(w.walletId)).toBe('90.00');

    const summary = await reprocess.runOnce();
    expect(summary.processed).toBeGreaterThanOrEqual(1);

    expect((await row(refundId)).status).toBe(S.Processed);
    expect(await balanceOf(w.walletId)).toBe('100.00');
    expect((await row(refundId)).ob).toBe('100.00');
    const ledger = await db.sql('select count(*)::int as n from wallet_ledger_entries where transaction_id = ?', [refundId]);
    expect(ledger[0].n).toBe(1);
    expect(await events(refundId)).toContain('WagerTransactionProcessed');
  });

  test('sem a referência, agenda nova tentativa com backoff e não mexe no saldo', async () => {
    const w = await newWallet('100.00');
    const refundId = await pendingRefund(w, `never-${++seq}`);

    const first = await reprocess.reprocess(refundId, w.walletId);
    expect(first).toBe('waiting');
    const after = await row(refundId);
    expect(after.status).toBe(S.PendingReference);
    expect(after.reprocess_attempts).toBe(1);
    expect(await balanceOf(w.walletId)).toBe('100.00');

    // ainda não venceu, então o ciclo não pega
    const due = await db.sql(`select 1 from wager_transactions where id = ? and next_reprocess_at <= now()`, [refundId]);
    expect(due).toHaveLength(0);
  });

  test('passou do TTL: rejeita com REFERENCE_NOT_FOUND e emite o evento', async () => {
    const w = await newWallet('100.00');
    const refundId = await pendingRefund(w, `gone-${++seq}`);
    const later = new ReprocessPendingReferencesUseCase(db.orm.em as any, { ttlMs: 1_000 }, () => new Date(Date.now() + 60_000));

    expect(await later.reprocess(refundId, w.walletId)).toBe('expired');
    const final = await row(refundId);
    expect(final.status).toBe(S.Rejected);
    expect(final.failure_code).toBe(FailureCode.ReferenceNotFound);
    expect(await events(refundId)).toContain('WagerTransactionRejected');
  });

  test('estoura o máximo de tentativas: rejeita', async () => {
    const w = await newWallet('100.00');
    const refundId = await pendingRefund(w, `gone-${++seq}`);
    const strict = new ReprocessPendingReferencesUseCase(db.orm.em as any, { maxAttempts: 2 });

    expect(await strict.reprocess(refundId, w.walletId)).toBe('waiting');
    expect(await strict.reprocess(refundId, w.walletId)).toBe('expired');
    expect((await row(refundId)).failure_code).toBe(FailureCode.ReferenceNotFound);
  });

  test('referência que nunca saiu do pendente expira como REFERENCE_NOT_PROCESSED', async () => {
    const w = await newWallet('100.00');
    const ghost = `ghost-${++seq}`;
    const waitingBet = await submit.execute(cmd(w, { kind: K.Win, externalTransactionId: ghost, referenceExternalTransactionId: 'nope' }));
    expect(waitingBet.status).toBe(S.PendingReference);
    const refundId = await pendingRefund(w, ghost, K.Rollback);
    const later = new ReprocessPendingReferencesUseCase(db.orm.em as any, { ttlMs: 1_000 }, () => new Date(Date.now() + 60_000));

    await later.reprocess(refundId, w.walletId);
    expect((await row(refundId)).failure_code).toBe(FailureCode.ReferenceNotProcessed);
  });

  test('referência de tipo inválido é rejeitada quando chega', async () => {
    const w = await newWallet('100.00');
    const betExt = `bet-kind-${++seq}`;
    const winExt = `win-kind-${++seq}`;
    const refundId = await pendingRefund(w, winExt);
    await submit.execute(cmd(w, { externalTransactionId: betExt }));
    await submit.execute(cmd(w, { kind: K.Win, externalTransactionId: winExt, referenceExternalTransactionId: betExt }));

    expect(await reprocess.reprocess(refundId, w.walletId)).toBe('rejected');
    expect((await row(refundId)).failure_code).toBe(FailureCode.ReferenceInvalidKind);
  });

  test('dois workers ao mesmo tempo não aplicam a mesma transação duas vezes', async () => {
    const w = await newWallet('100.00');
    const betExt = `bet-race-${++seq}`;
    const refundId = await pendingRefund(w, betExt);
    await submit.execute(cmd(w, { externalTransactionId: betExt }));

    const results = await Promise.all(Array.from({ length: 6 }, () => reprocess.reprocess(refundId, w.walletId)));
    expect(results.filter((r) => r === 'processed')).toHaveLength(1);
    expect(await balanceOf(w.walletId)).toBe('100.00');
    const ledger = await db.sql('select count(*)::int as n from wallet_ledger_entries where transaction_id = ?', [refundId]);
    expect(ledger[0].n).toBe(1);
  });

  test('segundo estorno da mesma bet vira ALREADY_REVERSED quando a bet chega', async () => {
    const w = await newWallet('100.00');
    const betExt = `bet-twice-${++seq}`;
    const first = await pendingRefund(w, betExt);
    const second = await pendingRefund(w, betExt);
    await submit.execute(cmd(w, { externalTransactionId: betExt }));

    await reprocess.reprocess(first, w.walletId);
    await reprocess.reprocess(second, w.walletId);

    expect((await row(first)).status).toBe(S.Processed);
    expect((await row(second)).failure_code).toBe(FailureCode.AlreadyReversed);
    expect(await balanceOf(w.walletId)).toBe('100.00');
  });

  test('reenviar a transação já resolvida devolve o resultado final (replay)', async () => {
    const w = await newWallet('100.00');
    const betExt = `bet-replay-${++seq}`;
    const refundCmd = cmd(w, { kind: K.Refund, referenceExternalTransactionId: betExt });
    await submit.execute(refundCmd);
    await submit.execute(cmd(w, { externalTransactionId: betExt }));
    await makeDue((await db.sql(`select id from wager_transactions where idempotency_key = ?`, [refundCmd.idempotencyKey]))[0].id);
    await reprocess.runOnce();

    const replay = await submit.execute(refundCmd);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.status).toBe(S.Processed);
    expect(replay.balance.toString()).toBe('100.00');
  });
});
