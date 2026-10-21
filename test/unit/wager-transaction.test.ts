import { describe, expect, test } from 'bun:test';
import { InvalidTransactionStateError, InvalidWagerError } from '../../src/domain/errors/wager.errors';
import { LedgerDirection } from '../../src/domain/ledger/wallet-ledger-entry';
import { FailureCode } from '../../src/domain/wagering/failure-code';
import { computePayloadHash } from '../../src/domain/wagering/payload-hash';
import {
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../../src/domain/wagering/wager-transaction';
import { brl, makeTx, now } from '../helpers/wager';

describe('WagerTransaction', () => {
  test('nasce PENDING', () => {
    const tx = makeTx();
    expect(tx.status).toBe(Status.Pending);
    expect(tx.isTerminal()).toBe(false);
  });

  test('OPENING não pode ser criado por create, só por opening', () => {
    expect(() => makeTx({ kind: Kind.Opening })).toThrow(InvalidWagerError);
    const opening = WagerTransaction.opening({
      id: 't0',
      providerId: 'internal',
      externalTransactionId: 'open-1',
      idempotencyKey: 'open-1',
      walletId: 'w1',
      playerId: 'p1',
      roundId: 'opening',
      gameId: 'opening',
      money: brl('1000.00'),
      now,
    });
    expect(opening.kind).toBe(Kind.Opening);
    expect(opening.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });

  test('REFUND e ROLLBACK exigem referência', () => {
    expect(() => makeTx({ kind: Kind.Refund })).toThrow(InvalidWagerError);
    expect(() => makeTx({ kind: Kind.Rollback })).toThrow(InvalidWagerError);
    expect(makeTx({ kind: Kind.Refund, referenceExternalTransactionId: 'ext-0' }).requiresReference()).toBe(true);
  });

  test('BET não pode ter referência', () => {
    expect(() => makeTx({ referenceExternalTransactionId: 'ext-0' })).toThrow(InvalidWagerError);
  });

  test('valor zero só é aceito em LOSS', () => {
    expect(() => makeTx({ money: brl('0.00') })).toThrow(InvalidWagerError);
    expect(makeTx({ kind: Kind.Loss, money: brl('0.00') }).affectsBalance()).toBe(false);
  });

  test('direção do ledger por tipo', () => {
    expect(makeTx().ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(makeTx({ kind: Kind.Win }).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(
      makeTx({ kind: Kind.Refund, referenceExternalTransactionId: 'x' }).ledgerDirectionFor(),
    ).toBe(LedgerDirection.Credit);
    expect(() => makeTx({ kind: Kind.Loss }).ledgerDirectionFor()).toThrow(InvalidWagerError);
  });

  test('ROLLBACK inverte a direção da referência', () => {
    const rollback = makeTx({ kind: Kind.Rollback, referenceExternalTransactionId: 'x' });
    expect(rollback.ledgerDirectionFor(makeTx())).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(makeTx({ kind: Kind.Win }))).toBe(LedgerDirection.Debit);
    expect(() => rollback.ledgerDirectionFor()).toThrow(InvalidWagerError);
  });

  describe('transições', () => {
    test('PENDING -> PROCESSED guarda referência e data', () => {
      const tx = makeTx();
      tx.markProcessed('ref-1', now);
      expect(tx.status).toBe(Status.Processed);
      expect(tx.referenceTransactionId).toBe('ref-1');
      expect(tx.processedAt).toEqual(now);
    });

    test('PENDING_REFERENCE só vale para quem tem referência', () => {
      expect(() => makeTx().markPendingReference()).toThrow(InvalidTransactionStateError);
      const refund = makeTx({ kind: Kind.Refund, referenceExternalTransactionId: 'x' });
      refund.markPendingReference();
      refund.markPendingReference();
      expect(refund.status).toBe(Status.PendingReference);
    });

    test('PENDING_REFERENCE ainda pode ser rejeitada', () => {
      const refund = makeTx({ kind: Kind.Refund, referenceExternalTransactionId: 'x' });
      refund.markPendingReference();
      refund.reject(FailureCode.ReferenceNotFound);
      expect(refund.status).toBe(Status.Rejected);
      expect(refund.failureCode).toBe(FailureCode.ReferenceNotFound);
    });

    test.each([
      ['PROCESSED', (t: WagerTransaction) => t.markProcessed(undefined, now)],
      ['REJECTED', (t: WagerTransaction) => t.reject(FailureCode.InsufficientFunds)],
      ['FAILED', (t: WagerTransaction) => t.fail(FailureCode.InternalError)],
    ])('%s é terminal e não aceita nenhuma transição', (_name, finish) => {
      const tx = makeTx({ kind: Kind.Win });
      finish(tx);
      expect(tx.isTerminal()).toBe(true);
      expect(() => tx.markProcessed(undefined, now)).toThrow(InvalidTransactionStateError);
      expect(() => tx.reject(FailureCode.InsufficientFunds)).toThrow(InvalidTransactionStateError);
      expect(() => tx.fail(FailureCode.InternalError)).toThrow(InvalidTransactionStateError);
      expect(() => tx.markPendingReference()).toThrow(InvalidTransactionStateError);
    });
  });

  describe('payload hash', () => {
    test('mesma entrada gera o mesmo hash, mesmo com 25 em vez de 25.00', () => {
      expect(makeTx().payloadHash).toBe(makeTx({ money: brl('25') }).payloadHash);
    });

    test('a idempotency key e o id interno não entram no hash', () => {
      expect(makeTx().payloadHash).toBe(makeTx({ id: 'outro', idempotencyKey: 'outra' }).payloadHash);
    });

    test('qualquer campo de negócio diferente muda o hash', () => {
      const base = makeTx();
      expect(base.matchesPayload(makeTx({ money: brl('25.01') }).payloadHash)).toBe(false);
      expect(base.matchesPayload(makeTx({ roundId: 'r2' }).payloadHash)).toBe(false);
      expect(base.matchesPayload(makeTx({ kind: Kind.Win }).payloadHash)).toBe(false);
      expect(base.matchesPayload(makeTx().payloadHash)).toBe(true);
    });

    test('é estável: independe da ordem das chaves', () => {
      const fields = {
        providerId: 'a',
        externalTransactionId: 'b',
        playerId: 'c',
        walletId: 'd',
        roundId: 'e',
        gameId: 'f',
        kind: 'BET',
        money: brl('1.00'),
        referenceExternalTransactionId: undefined,
      };
      const reordered = Object.fromEntries(Object.entries(fields).reverse()) as typeof fields;
      expect(computePayloadHash(fields)).toBe(computePayloadHash(reordered));
      expect(computePayloadHash(fields)).toMatch(/^[0-9a-f]{64}$/);
    });
  });
});
