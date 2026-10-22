import { createHash } from 'node:crypto';
import type { EntityManager } from '@mikro-orm/postgresql';
import { InboxMessage } from '../domain/events/inbox-message';
import { withRetry } from '../infra/database/retry';
import { InboxRepository } from '../infra/persistence/inbox.repository';
import { InvalidMessageError } from './errors';
import { createLogger } from '../observability/logger';
import { metrics } from '../observability/metrics';
import { observeSubmitted } from './submit-wager-transaction.use-case';
import type { SubmitWagerResult, SubmitWagerTransactionUseCase } from './submit-wager-transaction.use-case';
import { parseWagerMessage } from './wager-message';

export const WAGER_CONSUMER_NAME = 'wager-transactions-consumer';

export type ProcessMessageOutcome =
  | { kind: 'processed'; result: SubmitWagerResult }
  | { kind: 'duplicate' };

export class ProcessWagerMessageUseCase {
  constructor(
    private readonly em: EntityManager,
    private readonly submit: SubmitWagerTransactionUseCase,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  // Inbox e efeitos financeiros são confirmados juntos; o ack vem depois.
  async execute(body: string): Promise<ProcessMessageOutcome> {
    const startedAt = performance.now();
    const { messageId, command } = parseWagerMessage(body);
    const payloadHash = createHash('sha256').update(body).digest('hex');

    const outcome = await withRetry(() =>
      this.em.transactional(async (tem): Promise<ProcessMessageOutcome> => {
        const inbox = new InboxRepository(tem);
        const received = InboxMessage.receive({
          messageId,
          consumerName: WAGER_CONSUMER_NAME,
          payloadHash,
          now: this.clock(),
        });
        const { inserted, stored } = await inbox.receive(received);

        if (!inserted) {
          if (stored.payloadHash !== payloadHash) {
            throw new InvalidMessageError(`messageId ${messageId} was already used with a different payload`);
          }
          return { kind: 'duplicate' };
        }

        const result = await this.submit.executeWithin(tem, command);
        received.markProcessed(this.clock());
        await inbox.markProcessed(received);
        return { kind: 'processed', result };
      }),
    );

    if (outcome.kind === 'duplicate') {
      metrics.duplicates.inc({ source: 'inbox' });
      metrics.sqsMessages.inc({ outcome: 'duplicate' });
      createLogger('ProcessWagerMessage').info('duplicate message ignored', {
        messageId,
        correlationId: command.correlationId,
        walletId: command.walletId,
        providerId: command.providerId,
      });
    } else {
      metrics.sqsMessages.inc({ outcome: 'processed' });
      observeSubmitted('sqs', command, outcome.result, startedAt, messageId);
    }
    return outcome;
  }
}
