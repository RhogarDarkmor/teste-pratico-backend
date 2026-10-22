import type { EntityManager } from '@mikro-orm/postgresql';
import { withRetry } from '../database/retry';
import { metrics } from '../../observability/metrics';
import { OutboxRepository } from '../persistence/outbox.repository';
import { DEFAULT_BACKOFF, type BackoffOptions } from '../../domain/events/backoff';
import type { MessagePublisher } from './sqs-message-publisher';

export interface OutboxPublisherOptions {
  batchSize: number;
  pollIntervalMs: number;
  backoff: BackoffOptions;
}

export const DEFAULT_PUBLISHER_OPTIONS: OutboxPublisherOptions = {
  batchSize: 20,
  pollIntervalMs: 500,
  backoff: DEFAULT_BACKOFF,
};

export interface PublishRunResult {
  claimed: number;
  published: number;
  failed: number;
}

export interface PublisherLogger {
  warn(message: string): void;
  error(message: string): void;
}

export class OutboxPublisher {
  private readonly options: OutboxPublisherOptions;
  private running = false;
  private loop: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  constructor(
    private readonly em: EntityManager,
    private readonly publisher: MessagePublisher,
    options: Partial<OutboxPublisherOptions> = {},
    private readonly logger: PublisherLogger = console,
  ) {
    this.options = { ...DEFAULT_PUBLISHER_OPTIONS, ...options };
  }

  // Um ciclo: pega um lote, envia e marca, tudo na mesma transação. Se o processo cair no meio,
  // o lock some e outro publicador refaz o lote (o id de deduplicação evita duplicar na fila).
  async runOnce(): Promise<PublishRunResult> {
    return withRetry(() =>
      this.em.fork().transactional(async (tem) => {
        const repo = new OutboxRepository(tem);
        const batch = await repo.claimPending(this.options.batchSize);
        const result: PublishRunResult = { claimed: batch.length, published: 0, failed: 0 };
        // se uma mensagem falha, as seguintes da mesma carteira esperam para não furar a ordem
        const blocked = new Set<string>();

        for (const message of batch) {
          if (blocked.has(message.aggregateId)) continue;
          try {
            await this.publisher.publish(message);
          } catch (error) {
            message.scheduleRetry(new Date(), this.options.backoff);
            await repo.markFailed(message);
            metrics.outboxFailures.inc();
            blocked.add(message.aggregateId);
            result.failed++;
            this.logger.warn(
              `Outbox message ${message.id} failed (attempt ${message.attempts}), retry at ${message.nextAttemptAt?.toISOString()}: ${(error as Error).message}`,
            );
            continue;
          }
          message.markPublished(new Date());
          await repo.markPublished(message);
          metrics.outboxPublished.inc();
          result.published++;
        }
        return result;
      }),
    );
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  // espera o ciclo em andamento terminar, para o shutdown não cortar um envio no meio
  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loop;
  }

  private async run(): Promise<void> {
    while (this.running) {
      let idle = true;
      try {
        const result = await this.runOnce();
        idle = result.claimed === 0;
      } catch (error) {
        this.logger.error(`Outbox publisher cycle failed: ${(error as Error).message}`);
      }
      if (this.running && idle) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, this.options.pollIntervalMs);
          this.wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        this.wake = undefined;
      }
    }
  }
}
