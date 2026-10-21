import { InsufficientFundsError } from '../errors/wallet.errors';
import { InvalidTransactionStateError } from '../errors/wager.errors';
import { LedgerDirection, WalletLedgerEntry } from '../ledger/wallet-ledger-entry';
import { Wallet } from '../wallet/wallet';
import { FailureCode } from './failure-code';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from './wager-transaction';

export interface ApplyWagerContext {
  wallet: Wallet;
  reference: WagerTransaction | undefined;
  alreadyReversed: boolean;
  entryId: string;
  now: Date;
}

export type WagerOutcome =
  | { status: 'processed'; entry: WalletLedgerEntry | undefined }
  | { status: 'pending_reference' }
  | { status: 'rejected'; code: FailureCode };

const K = WagerTransactionKind;

const ALLOWED_REFERENCES: Partial<Record<WagerTransactionKind, WagerTransactionKind[]>> = {
  [K.Win]: [K.Bet],
  [K.Loss]: [K.Bet],
  [K.Refund]: [K.Bet],
  [K.Rollback]: [K.Bet, K.Win, K.Refund],
};

export function applyWager(tx: WagerTransaction, ctx: ApplyWagerContext): WagerOutcome {
  const { wallet, now } = ctx;

  if (tx.isTerminal()) {
    throw new InvalidTransactionStateError(`Transaction ${tx.id} is already ${tx.status}`);
  }
  if (wallet.id !== tx.walletId) {
    throw new Error(`Transaction ${tx.id} does not belong to wallet ${wallet.id}`);
  }
  if (tx.money.currency !== wallet.currency) {
    return reject(tx, FailureCode.CurrencyMismatch);
  }

  const reference = ctx.reference;
  if (tx.referenceExternalTransactionId !== undefined) {
    if (!reference) {
      tx.markPendingReference();
      return { status: 'pending_reference' };
    }
    const problem = checkReference(tx, reference, ctx.alreadyReversed);
    if (problem === 'waiting') {
      tx.markPendingReference();
      return { status: 'pending_reference' };
    }
    if (problem) {
      return reject(tx, problem);
    }
  }

  if (!tx.affectsBalance()) {
    tx.markProcessed(reference?.id, now);
    return { status: 'processed', entry: undefined };
  }

  const movement = { amount: tx.money, transactionId: tx.id, entryId: ctx.entryId, at: now };
  const direction = tx.ledgerDirectionFor(reference);

  try {
    const entry = direction === LedgerDirection.Debit ? wallet.debit(movement) : wallet.credit(movement);
    tx.markProcessed(reference?.id, now);
    return { status: 'processed', entry };
  } catch (error) {
    if (error instanceof InsufficientFundsError) {
      const code = tx.kind === K.Bet ? FailureCode.InsufficientFunds : FailureCode.ReversalWouldOverdraw;
      return reject(tx, code);
    }
    throw error;
  }
}

function reject(tx: WagerTransaction, code: FailureCode): WagerOutcome {
  tx.reject(code);
  return { status: 'rejected', code };
}

function isReversal(tx: WagerTransaction): boolean {
  return tx.kind === K.Refund || tx.kind === K.Rollback;
}

function checkReference(
  tx: WagerTransaction,
  ref: WagerTransaction,
  alreadyReversed: boolean,
): FailureCode | 'waiting' | undefined {
  const sameContext =
    ref.providerId === tx.providerId &&
    ref.playerId === tx.playerId &&
    ref.walletId === tx.walletId &&
    ref.roundId === tx.roundId &&
    ref.money.currency === tx.money.currency;
  if (!sameContext) {
    return FailureCode.ReferenceMismatch;
  }

  if (!ALLOWED_REFERENCES[tx.kind]?.includes(ref.kind)) {
    return FailureCode.ReferenceInvalidKind;
  }

  if (ref.status === WagerTransactionStatus.Pending || ref.status === WagerTransactionStatus.PendingReference) {
    return 'waiting';
  }
  if (ref.status !== WagerTransactionStatus.Processed) {
    return FailureCode.ReferenceNotProcessed;
  }

  if (isReversal(tx)) {
    if (!tx.money.equals(ref.money)) {
      return FailureCode.ReferenceAmountMismatch;
    }
    // vale pra refund e rollback juntos, senão a bet voltava duas vezes
    if (alreadyReversed) {
      return FailureCode.AlreadyReversed;
    }
  }
  return undefined;
}
