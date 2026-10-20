import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError } from '../../src/domain/errors/money.errors';
import {
  InsufficientFundsError,
  InvalidMovementError,
  UnbalancedLedgerEntryError,
} from '../../src/domain/errors/wallet.errors';
import { LedgerDirection, WalletLedgerEntry } from '../../src/domain/ledger/wallet-ledger-entry';
import { Money } from '../../src/domain/money/money';
import { Wallet } from '../../src/domain/wallet/wallet';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-01-01T00:00:00Z');

const openWallet = (initial = '100.00') => Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: brl(initial) });
const move = (amount: string, n = 1) => ({ amount: brl(amount), transactionId: `t${n}`, entryId: `e${n}`, at });

describe('Wallet', () => {
  test('abre com a versão 1 e o saldo inicial', () => {
    const wallet = openWallet();
    expect(wallet.version).toBe(1);
    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.currency).toBe('BRL');
  });

  test('não abre com saldo negativo', () => {
    expect(() => openWallet('0.00').balance.negate()).not.toThrow();
    expect(() =>
      Wallet.open({ id: 'w', playerId: 'p', initialBalance: Money.fromPersisted({ amount: '-1.00', currency: 'BRL' }) }),
    ).toThrow(InvalidMoneyError);
  });

  test('débito reduz o saldo, sobe a versão e gera ledger coerente', () => {
    const wallet = openWallet();
    const entry = wallet.debit(move('25.00'));
    expect(wallet.balance.toString()).toBe('75.00');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.toString()).toBe('100.00');
    expect(entry.balanceAfter.toString()).toBe('75.00');
    expect(entry.isBalanced()).toBe(true);
  });

  test('crédito aumenta o saldo e sobe a versão', () => {
    const wallet = openWallet();
    const entry = wallet.credit(move('10.50'));
    expect(wallet.balance.toString()).toBe('110.50');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Credit);
  });

  test('pode gastar exatamente todo o saldo', () => {
    const wallet = openWallet();
    wallet.debit(move('100.00'));
    expect(wallet.balance.isZero()).toBe(true);
  });

  test('saldo insuficiente: lança erro e não altera nada', () => {
    const wallet = openWallet();
    expect(() => wallet.debit(move('100.01'))).toThrow(InsufficientFundsError);
    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.version).toBe(1);
  });

  test('cenário do desafio: 100 com duas apostas de 80, só a primeira passa', () => {
    const wallet = openWallet();
    wallet.debit(move('80.00', 1));
    expect(() => wallet.debit(move('80.00', 2))).toThrow(InsufficientFundsError);
    expect(wallet.balance.toString()).toBe('20.00');
  });

  test('moeda diferente da wallet é rejeitada', () => {
    const wallet = openWallet();
    const usd = { ...move('1.00'), amount: Money.from({ amount: '1.00', currency: 'USD' }) };
    expect(() => wallet.debit(usd)).toThrow(CurrencyMismatchError);
    expect(() => wallet.credit(usd)).toThrow(CurrencyMismatchError);
    expect(wallet.version).toBe(1);
  });

  test('valor zero ou negativo não movimenta', () => {
    const wallet = openWallet();
    expect(() => wallet.debit(move('0.00'))).toThrow(InvalidMovementError);
    expect(() => wallet.credit(move('0.00'))).toThrow(InvalidMovementError);
    expect(() => wallet.credit({ ...move('1.00'), amount: brl('1.00').negate() })).toThrow(InvalidMovementError);
    expect(wallet.version).toBe(1);
  });

  test('rehydrate reconstrói sem alterar o estado', () => {
    const wallet = Wallet.rehydrate({
      id: 'w1',
      playerId: 'p1',
      currency: 'BRL',
      balance: brl('7.00'),
      version: 9,
      createdAt: at,
      updatedAt: at,
    });
    expect(wallet.version).toBe(9);
    expect(wallet.balance.toString()).toBe('7.00');
  });
});

describe('WalletLedgerEntry', () => {
  const base = {
    id: 'e1',
    walletId: 'w1',
    transactionId: 't1',
    money: brl('10.00'),
    createdAt: at,
  };

  test('create rejeita aritmética inconsistente', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Debit,
        balanceBefore: brl('100.00'),
        balanceAfter: brl('95.00'),
      }),
    ).toThrow(UnbalancedLedgerEntryError);
  });

  test('rehydrate não revalida (estado já persistido)', () => {
    const entry = WalletLedgerEntry.rehydrate({
      ...base,
      direction: LedgerDirection.Credit,
      balanceBefore: brl('1.00'),
      balanceAfter: brl('999.00'),
    });
    expect(entry.isBalanced()).toBe(false);
  });
});
