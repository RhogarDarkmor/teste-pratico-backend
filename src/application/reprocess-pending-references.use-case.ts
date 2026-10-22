import type { EntityManager } from '@mikro-orm/postgresql';
import type { EventContext, IntegrationEvent } from '../domain/events/integration-event';
import {
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../domain/events/wagering-events';
import { FailureCode } from '../domain/wagering/failure-code';
import { applyWager } from '../domain/wagering/wager-processor';
import { withRetry } from '../infra/database/retry';
import { backoffDelayMs, type BackoffOptions } from '../domain/events/backoff';
import { WageringRepository } from '../infra/persistence/wagering.repository';
import { newId } from '../shared/ids';
import { createLogger } from '../observability/logger';
import { metrics } from '../observability/metrics';

export interface ReprocessOptions {
  batchSize: number;
  // passou do TTL ou do limite, rejeita
  ttlMs: number;
  maxAttempts: number;
  backoff: BackoffOptions;
}

export const DEFAULT_REPROCESS_OPTIONS: ReprocessOptions = {
  batchSize: 20,
  ttlMs: 10 * 60_000,
  // o TTL limita a espera e o limite de tentativas evita loop infinito
  maxAttempts: 40,
  // com a referência disponível, liquida em no máximo ~30s
  backoff: { baseMs: 2_000, maxMs: 30_000 },
};

export type ReprocessResult = 'processed' | 'rejected' | 'waiting' | 'expired' | 'skipped';

export interface ReprocessSummary {
  claimed: number;
  processed: number;
  rejected: number;
  waiting: number;
  expired: number;
  skipped: number;
}

export class ReprocessPendingReferencesUseCase {
  private readonly options: ReprocessOptions;

  constructor(
    private readonly em: EntityManager,
    options: Partial<ReprocessOptions> = {},
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.options = { ...DEFAULT_REPROCESS_OPTIONS, ...options };
  }

  async runOnce(): Promise<ReprocessSummary> {
    const due = await new WageringRepository(this.em.fork()).findDuePendingReferences(this.options.batchSize);
    const summary: ReprocessSummary = { claimed: due.length, processed: 0, rejected: 0, waiting: 0, expired: 0, skipped: 0 };
    for (const item of due) {
      const result = await this.reprocess(item.id, item.walletId);
      summary[result]++;
    }
    return summary;
  }

  async reprocess(transactionId: string, walletId: string): Promise<ReprocessResult> {
    const result = await withRetry(() =>
      this.em.fork().transactional((tem) => this.run(new WageringRepository(tem), transactionId, walletId)),
    );
    metrics.pendingReprocessed.inc({ result });
    if (result !== 'skipped') {
      createLogger('ReprocessPendingReferences').info('pending reference reprocessed', { transactionId, walletId, result });
    }
    return result;
  }

  private async run(repo: WageringRepository, transactionId: string, walletId: string): Promise<ReprocessResult> {
    // mesma ordem de lock do envio, senão dá deadlock
    const wallet = await repo.lockWallet(walletId);
    if (!wallet) return 'skipped';
    const locked = await repo.lockPendingTransaction(transactionId);
    if (!locked) return 'skipped';

    const { transaction: tx, attempts } = locked;
    const now = this.clock();
    const providerId = tx.providerId;
    const referenceId = tx.referenceExternalTransactionId;

    const reference = referenceId ? await repo.findByExternalId(providerId, referenceId) : undefined;
    const alreadyReversed = reference ? await repo.hasProcessedReversal(reference.id) : false;

    const expectedVersion = wallet.version;
    const outcome = applyWager(tx, { wallet, reference, alreadyReversed, entryId: newId(), now });

    const correlationId = newId();
    const ctx = (): EventContext => ({ eventId: newId(), correlationId, causationId: tx.id, occurredAt: now });
    const events: IntegrationEvent<unknown>[] = [];
    let result: ReprocessResult;

    if (outcome.status === 'processed') {
      if (outcome.entry) {
        await repo.insertLedgerEntry(outcome.entry);
        await repo.updateWalletBalance(wallet, expectedVersion);
        events.push(WalletBalanceChanged.from(wallet, outcome.entry, ctx()));
      }
      events.push(WagerTransactionProcessed.from(tx, wallet, ctx()));
      result = 'processed';
    } else if (outcome.status === 'rejected') {
      events.push(WagerTransactionRejected.from(tx, ctx()));
      result = 'rejected';
    } else {
      const nextAttempts = attempts + 1;
      const expired =
        now.getTime() - tx.createdAt.getTime() >= this.options.ttlMs || nextAttempts >= this.options.maxAttempts;
      if (!expired) {
        await repo.scheduleReprocess(tx.id, nextAttempts, backoffDelayMs(nextAttempts, this.options.backoff));
        return 'waiting';
      }
      tx.reject(reference ? FailureCode.ReferenceNotProcessed : FailureCode.ReferenceNotFound);
      events.push(WagerTransactionRejected.from(tx, ctx()));
      result = 'expired';
    }

    await repo.updateTransactionOutcome(tx, wallet.balance);
    for (const event of events) {
      await repo.insertOutbox(event);
    }
    return result;
  }
}
