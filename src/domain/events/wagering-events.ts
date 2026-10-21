import { LedgerDirection, WalletLedgerEntry } from '../ledger/wallet-ledger-entry';
import type { MoneyProps } from '../money/money';
import { FailureCode } from '../wagering/failure-code';
import type { WagerTransaction } from '../wagering/wager-transaction';
import type { Wallet } from '../wallet/wallet';
import { type EventContext, IntegrationEvent } from './integration-event';

interface TransactionData {
  transactionId: string;
  walletId: string;
  providerId: string;
  externalTransactionId: string;
  kind: string;
}

function transactionData(tx: WagerTransaction): TransactionData {
  return {
    transactionId: tx.id,
    walletId: tx.walletId,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    kind: tx.kind,
  };
}

function base(tx: WagerTransaction, ctx: EventContext) {
  return {
    eventId: ctx.eventId,
    aggregateId: tx.walletId,
    correlationId: ctx.correlationId,
    ...(ctx.causationId !== undefined && { causationId: ctx.causationId }),
    occurredAt: ctx.occurredAt,
  };
}

export interface WagerTransactionProcessedData extends TransactionData {
  money: MoneyProps;
  balance: MoneyProps;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(tx: WagerTransaction, wallet: Wallet, ctx: EventContext) {
    return new WagerTransactionProcessed({
      ...base(tx, ctx),
      data: { ...transactionData(tx), money: tx.money.toJSON(), balance: wallet.balance.toJSON() },
    });
  }
}

export interface WagerTransactionRejectedData extends TransactionData {
  failureCode: FailureCode;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext) {
    return new WagerTransactionRejected({
      ...base(tx, ctx),
      data: { ...transactionData(tx), failureCode: tx.failureCode ?? FailureCode.InternalError },
    });
  }
}

export interface WagerTransactionPendingReferenceData extends TransactionData {
  referenceExternalTransactionId: string | undefined;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext) {
    return new WagerTransactionPendingReference({
      ...base(tx, ctx),
      data: { ...transactionData(tx), referenceExternalTransactionId: tx.referenceExternalTransactionId },
    });
  }
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext) {
    return new WalletBalanceChanged({
      eventId: ctx.eventId,
      aggregateId: wallet.id,
      correlationId: ctx.correlationId,
      ...(ctx.causationId !== undefined && { causationId: ctx.causationId }),
      occurredAt: ctx.occurredAt,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      },
    });
  }
}
