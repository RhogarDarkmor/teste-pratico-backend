import { describe, expect, test } from 'bun:test';
import { LedgerDirection } from '../../src/domain/ledger/wallet-ledger-entry';
import { Money } from '../../src/domain/money/money';
import { FailureCode } from '../../src/domain/wagering/failure-code';
import { applyWager, type WagerOutcome } from '../../src/domain/wagering/wager-processor';
import {
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../../src/domain/wagering/wager-transaction';
import { Wallet } from '../../src/domain/wallet/wallet';
import { brl, makeTx, now } from '../helpers/wager';

const openWallet = (balance = '100.00') => Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: brl(balance) });

let seq = 0;
function run(
  wallet: Wallet,
  tx: WagerTransaction,
  extra: { reference?: WagerTransaction; alreadyReversed?: boolean } = {},
): WagerOutcome {
  return applyWager(tx, {
    wallet,
    reference: extra.reference,
    alreadyReversed: extra.alreadyReversed ?? false,
    entryId: `e${++seq}`,
    now,
  });
}

function processedBet(wallet: Wallet, amount = '25.00') {
  const bet = makeTx({ id: 'bet', externalTransactionId: 'bet-ext', money: brl(amount) });
  run(wallet, bet);
  return bet;
}

const reversal = (kind: Kind.Refund | Kind.Rollback, overrides = {}) =>
  makeTx({
    id: 'rev',
    externalTransactionId: 'rev-ext',
    kind,
    referenceExternalTransactionId: 'bet-ext',
    ...overrides,
  });

describe('applyWager', () => {
  describe('BET', () => {
    test('debita e gera um lançamento DEBIT', () => {
      const wallet = openWallet();
      const tx = makeTx();
      const outcome = run(wallet, tx);
      expect(outcome.status).toBe('processed');
      if (outcome.status === 'processed') {
        expect(outcome.entry?.direction).toBe(LedgerDirection.Debit);
        expect(outcome.entry?.transactionId).toBe('t1');
      }
      expect(wallet.balance.toString()).toBe('75.00');
      expect(tx.status).toBe(Status.Processed);
    });

    test('sem saldo: rejeita, sem lançamento e sem mexer no saldo', () => {
      const wallet = openWallet('10.00');
      const tx = makeTx();
      expect(run(wallet, tx)).toEqual({ status: 'rejected', code: FailureCode.InsufficientFunds });
      expect(tx.status).toBe(Status.Rejected);
      expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
      expect(wallet.balance.toString()).toBe('10.00');
      expect(wallet.version).toBe(1);
    });

    test('cenário do desafio: 100,00 e duas apostas de 80,00', () => {
      const wallet = openWallet();
      const first = makeTx({ id: 'a', externalTransactionId: 'a', money: brl('80.00') });
      const second = makeTx({ id: 'b', externalTransactionId: 'b', money: brl('80.00') });
      expect(run(wallet, first).status).toBe('processed');
      expect(run(wallet, second).status).toBe('rejected');
      expect(wallet.balance.toString()).toBe('20.00');
    });

    test('moeda diferente da wallet é rejeitada', () => {
      const wallet = openWallet();
      const tx = makeTx({ money: Money.from({ amount: '5.00', currency: 'USD' }) });
      expect(run(wallet, tx)).toEqual({ status: 'rejected', code: FailureCode.CurrencyMismatch });
      expect(wallet.balance.toString()).toBe('100.00');
    });

    test('transação de outra wallet é erro de programação', () => {
      expect(() => run(openWallet(), makeTx({ walletId: 'outra' }))).toThrow();
    });
  });

  describe('WIN e LOSS', () => {
    test('WIN credita', () => {
      const wallet = openWallet();
      const tx = makeTx({ kind: Kind.Win, money: brl('50.00') });
      expect(run(wallet, tx).status).toBe('processed');
      expect(wallet.balance.toString()).toBe('150.00');
    });

    test('WIN pode referenciar a BET da rodada', () => {
      const wallet = openWallet();
      const bet = processedBet(wallet);
      const win = makeTx({ id: 'win', kind: Kind.Win, referenceExternalTransactionId: 'bet-ext', money: brl('60.00') });
      expect(run(wallet, win, { reference: bet }).status).toBe('processed');
      expect(win.referenceTransactionId).toBe('bet');
      expect(wallet.balance.toString()).toBe('135.00');
    });

    test('LOSS fica PROCESSED sem lançamento e sem alterar saldo nem versão', () => {
      const wallet = openWallet();
      const outcome = run(wallet, makeTx({ kind: Kind.Loss, money: brl('0.00') }));
      expect(outcome).toEqual({ status: 'processed', entry: undefined });
      expect(wallet.balance.toString()).toBe('100.00');
      expect(wallet.version).toBe(1);
    });
  });

  describe('REFUND', () => {
    test('devolve o valor da BET', () => {
      const wallet = openWallet();
      const bet = processedBet(wallet);
      const refund = reversal(Kind.Refund);
      const outcome = run(wallet, refund, { reference: bet });
      expect(outcome.status).toBe('processed');
      expect(wallet.balance.toString()).toBe('100.00');
      expect(refund.referenceTransactionId).toBe('bet');
    });

    test('sem a referência fica PENDING_REFERENCE e não mexe no saldo', () => {
      const wallet = openWallet();
      const refund = reversal(Kind.Refund);
      expect(run(wallet, refund)).toEqual({ status: 'pending_reference' });
      expect(refund.status).toBe(Status.PendingReference);
      expect(wallet.balance.toString()).toBe('100.00');
    });

    test('quando a referência chega, a mesma transação pendente é reprocessada', () => {
      const wallet = openWallet();
      const refund = reversal(Kind.Refund);
      run(wallet, refund);
      const bet = processedBet(wallet);
      expect(run(wallet, refund, { reference: bet }).status).toBe('processed');
      expect(wallet.balance.toString()).toBe('100.00');
    });

    test('referência ainda pendente continua esperando', () => {
      const wallet = openWallet();
      const bet = makeTx({ id: 'bet', externalTransactionId: 'bet-ext' });
      const refund = reversal(Kind.Refund);
      expect(run(wallet, refund, { reference: bet })).toEqual({ status: 'pending_reference' });
    });

    test('referência rejeitada não pode ser revertida', () => {
      const wallet = openWallet('10.00');
      const bet = processedBet(wallet);
      expect(bet.status).toBe(Status.Rejected);
      const refund = reversal(Kind.Refund);
      expect(run(wallet, refund, { reference: bet })).toEqual({
        status: 'rejected',
        code: FailureCode.ReferenceNotProcessed,
      });
    });

    test('só referencia BET', () => {
      const wallet = openWallet();
      const win = makeTx({ id: 'win', externalTransactionId: 'bet-ext', kind: Kind.Win });
      run(wallet, win);
      const refund = reversal(Kind.Refund);
      expect(run(wallet, refund, { reference: win })).toEqual({
        status: 'rejected',
        code: FailureCode.ReferenceInvalidKind,
      });
    });

    test('valor diferente do da BET é rejeitado', () => {
      const wallet = openWallet();
      const bet = processedBet(wallet);
      const refund = reversal(Kind.Refund, { money: brl('10.00') });
      expect(run(wallet, refund, { reference: bet })).toEqual({
        status: 'rejected',
        code: FailureCode.ReferenceAmountMismatch,
      });
      expect(wallet.balance.toString()).toBe('75.00');
    });

    test('não reverte duas vezes', () => {
      const wallet = openWallet();
      const bet = processedBet(wallet);
      const refund = reversal(Kind.Refund);
      expect(run(wallet, refund, { reference: bet, alreadyReversed: true })).toEqual({
        status: 'rejected',
        code: FailureCode.AlreadyReversed,
      });
      expect(wallet.balance.toString()).toBe('75.00');
    });

    test.each([
      ['provider', { providerId: 'provider-b' }],
      ['player', { playerId: 'p2' }],
      ['rodada', { roundId: 'r2' }],
    ])('referência de outro %s é rejeitada', (_name, diff) => {
      const wallet = openWallet();
      const bet = processedBet(wallet);
      const refund = reversal(Kind.Refund, diff);
      expect(run(wallet, refund, { reference: bet })).toEqual({
        status: 'rejected',
        code: FailureCode.ReferenceMismatch,
      });
    });
  });

  describe('ROLLBACK', () => {
    test('de uma BET devolve o valor', () => {
      const wallet = openWallet();
      const bet = processedBet(wallet);
      expect(run(wallet, reversal(Kind.Rollback), { reference: bet }).status).toBe('processed');
      expect(wallet.balance.toString()).toBe('100.00');
    });

    test('de uma WIN debita de volta', () => {
      const wallet = openWallet();
      const win = makeTx({ id: 'win', externalTransactionId: 'bet-ext', kind: Kind.Win, money: brl('40.00') });
      run(wallet, win);
      const outcome = run(wallet, reversal(Kind.Rollback, { money: brl('40.00') }), { reference: win });
      expect(outcome.status).toBe('processed');
      if (outcome.status === 'processed') {
        expect(outcome.entry?.direction).toBe(LedgerDirection.Debit);
      }
      expect(wallet.balance.toString()).toBe('100.00');
    });

    test('de uma WIN já gasta é rejeitado com código próprio e sem saldo negativo', () => {
      const wallet = openWallet('0.00');
      const win = makeTx({ id: 'win', externalTransactionId: 'bet-ext', kind: Kind.Win, money: brl('40.00') });
      run(wallet, win);
      run(wallet, makeTx({ id: 'spend', externalTransactionId: 'spend', money: brl('30.00') }));
      const rollback = reversal(Kind.Rollback, { money: brl('40.00') });
      expect(run(wallet, rollback, { reference: win })).toEqual({
        status: 'rejected',
        code: FailureCode.ReversalWouldOverdraw,
      });
      expect(wallet.balance.toString()).toBe('10.00');
      expect(rollback.status).toBe(Status.Rejected);
    });

    test('de um REFUND debita de volta', () => {
      const wallet = openWallet();
      const bet = processedBet(wallet);
      const refund = reversal(Kind.Refund);
      run(wallet, refund, { reference: bet });
      const rollback = makeTx({
        id: 'rb',
        externalTransactionId: 'rb-ext',
        kind: Kind.Rollback,
        referenceExternalTransactionId: 'rev-ext',
      });
      expect(run(wallet, rollback, { reference: refund }).status).toBe('processed');
      expect(wallet.balance.toString()).toBe('75.00');
    });

    test('não pode referenciar LOSS nem outro ROLLBACK', () => {
      const wallet = openWallet();
      const loss = makeTx({ id: 'loss', externalTransactionId: 'bet-ext', kind: Kind.Loss, money: brl('25.00') });
      run(wallet, loss);
      expect(run(wallet, reversal(Kind.Rollback), { reference: loss })).toEqual({
        status: 'rejected',
        code: FailureCode.ReferenceInvalidKind,
      });
    });

    test('BET já reembolsada não pode sofrer ROLLBACK (evita crédito em dobro)', () => {
      const wallet = openWallet();
      const bet = processedBet(wallet);
      expect(run(wallet, reversal(Kind.Rollback), { reference: bet, alreadyReversed: true })).toEqual({
        status: 'rejected',
        code: FailureCode.AlreadyReversed,
      });
    });
  });

  test('transação terminal não pode ser aplicada de novo', () => {
    const wallet = openWallet();
    const tx = makeTx();
    run(wallet, tx);
    expect(() => run(wallet, tx)).toThrow();
    expect(wallet.balance.toString()).toBe('75.00');
  });
});
