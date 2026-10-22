import type { EntityManager } from '@mikro-orm/postgresql';
import type { EventContext, IntegrationEvent } from '../domain/events/integration-event';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../domain/events/wagering-events';
import { Money } from '../domain/money/money';
import type { FailureCode } from '../domain/wagering/failure-code';
import { applyWager } from '../domain/wagering/wager-processor';
import {
  WagerTransaction,
  type WagerTransactionKind,
  type WagerTransactionStatus,
} from '../domain/wagering/wager-transaction';
import { withRetry } from '../infra/database/retry';
import { type StoredTransaction, WageringRepository } from '../infra/persistence/wagering.repository';
import { newId } from '../shared/ids';
import { createLogger } from '../observability/logger';
import { metrics } from '../observability/metrics';
import { IdempotencyConflictError, WalletNotFoundError } from './errors';

export interface SubmitWagerCommand {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  amount: string;
  currency: string;
  referenceExternalTransactionId?: string;
  correlationId?: string;
}

export interface SubmitWagerResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: Money;
  failureCode?: FailureCode;
  idempotentReplay: boolean;
}

const logger = createLogger('SubmitWagerTransaction');

// só mede o que foi confirmado
export function observeSubmitted(
  origin: 'http' | 'sqs',
  command: SubmitWagerCommand,
  result: SubmitWagerResult,
  startedAt: number,
  messageId?: string,
): void {
  const seconds = (performance.now() - startedAt) / 1000;
  metrics.processingDuration.observe(seconds, { origin });
  if (result.idempotentReplay) {
    metrics.duplicates.inc({ source: 'idempotency' });
  } else {
    metrics.transactions.inc({ status: result.status, kind: command.kind });
  }
  logger.info('wager transaction handled', {
    origin,
    correlationId: command.correlationId,
    messageId,
    transactionId: result.transactionId,
    walletId: command.walletId,
    providerId: command.providerId,
    kind: command.kind,
    status: result.status,
    failureCode: result.failureCode,
    replay: result.idempotentReplay,
    durationMs: Math.round(seconds * 1000),
  });
}

export class SubmitWagerTransactionUseCase {
  constructor(
    private readonly em: EntityManager,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async execute(command: SubmitWagerCommand): Promise<SubmitWagerResult> {
    const startedAt = performance.now();
    const result = await withRetry(() => this.em.transactional((tem) => this.run(new WageringRepository(tem), command)));
    observeSubmitted('http', command, result, startedAt);
    return result;
  }

  // usado pelo consumer pra gravar a inbox na mesma transação
  executeWithin(tem: Pick<EntityManager, 'execute'>, command: SubmitWagerCommand): Promise<SubmitWagerResult> {
    return this.run(new WageringRepository(tem), command);
  }

  private async run(repo: WageringRepository, command: SubmitWagerCommand): Promise<SubmitWagerResult> {
    const money = Money.from({ amount: command.amount, currency: command.currency });
    const wallet = await repo.lockWallet(command.walletId);
    if (!wallet) {
      throw new WalletNotFoundError(`Wallet ${command.walletId} not found`);
    }

    // criado depois do lock pra respeitar a ordem da carteira
    const now = this.clock();
    const tx = WagerTransaction.create({
      id: newId(),
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      walletId: command.walletId,
      playerId: command.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money,
      referenceExternalTransactionId: command.referenceExternalTransactionId,
      now,
    });

    const existing = await repo.findByIdempotency(tx.idempotencyKey, tx.providerId, tx.externalTransactionId);
    if (existing.length > 0) {
      return this.replay(existing, tx, wallet.balance);
    }

    const reference = tx.referenceExternalTransactionId
      ? await repo.findByExternalId(tx.providerId, tx.referenceExternalTransactionId)
      : undefined;
    const alreadyReversed = reference ? await repo.hasProcessedReversal(reference.id) : false;

    const expectedVersion = wallet.version;
    const outcome = applyWager(tx, { wallet, reference, alreadyReversed, entryId: newId(), now });

    await repo.insertTransaction(tx, wallet.balance);

    const correlationId = command.correlationId ?? newId();
    const ctx = (): EventContext => ({ eventId: newId(), correlationId, causationId: tx.id, occurredAt: now });
    const events: IntegrationEvent<unknown>[] = [];

    if (outcome.status === 'processed') {
      if (outcome.entry) {
        await repo.insertLedgerEntry(outcome.entry);
        await repo.updateWalletBalance(wallet, expectedVersion);
        events.push(WalletBalanceChanged.from(wallet, outcome.entry, ctx()));
      }
      events.push(WagerTransactionProcessed.from(tx, wallet, ctx()));
    } else if (outcome.status === 'rejected') {
      events.push(WagerTransactionRejected.from(tx, ctx()));
    } else {
      events.push(WagerTransactionPendingReference.from(tx, ctx()));
    }
    for (const event of events) {
      await repo.insertOutbox(event);
    }

    return {
      transactionId: tx.id,
      status: tx.status,
      balance: wallet.balance,
      ...(tx.failureCode && { failureCode: tx.failureCode }),
      idempotentReplay: false,
    };
  }

  private replay(existing: StoredTransaction[], incoming: WagerTransaction, currentBalance: Money): SubmitWagerResult {
    const match = existing.find((row) => row.transaction.idempotencyKey === incoming.idempotencyKey);
    if (!match || match.transaction.payloadHash !== incoming.payloadHash) {
      throw new IdempotencyConflictError(
        `Idempotency key or external id already used with a different payload (${incoming.idempotencyKey})`,
      );
    }
    const stored = match.transaction;
    return {
      transactionId: stored.id,
      status: stored.status,
      balance: match.observedBalance ?? currentBalance,
      ...(stored.failureCode && { failureCode: stored.failureCode }),
      idempotentReplay: true,
    };
  }
}
