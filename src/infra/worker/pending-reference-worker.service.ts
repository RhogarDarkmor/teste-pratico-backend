import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { ReprocessPendingReferencesUseCase } from '../../application/reprocess-pending-references.use-case';
import { PendingReferenceWorker } from './pending-reference-worker';

// Reprocessa transações que esperam a referência chegar. PENDING_REFERENCE_WORKER_ENABLED=false desliga.
@Injectable()
export class PendingReferenceWorkerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(PendingReferenceWorkerService.name);
  private worker: PendingReferenceWorker | undefined;

  constructor(@Inject(EntityManager) private readonly em: EntityManager) {}

  onApplicationBootstrap(): void {
    if (process.env.PENDING_REFERENCE_WORKER_ENABLED === 'false') {
      this.logger.warn('Pending reference worker disabled');
      return;
    }
    const useCase = new ReprocessPendingReferencesUseCase(this.em, {
      batchSize: Number(process.env.PENDING_REFERENCE_BATCH_SIZE ?? 20),
      ttlMs: Number(process.env.PENDING_REFERENCE_TTL_MS ?? 10 * 60_000),
      maxAttempts: Number(process.env.PENDING_REFERENCE_MAX_ATTEMPTS ?? 40),
    });
    this.worker = new PendingReferenceWorker(
      useCase,
      Number(process.env.PENDING_REFERENCE_POLL_INTERVAL_MS ?? 2_000),
      this.logger,
    );
    this.worker.start();
    this.logger.log('Pending reference worker started');
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.stop();
  }
}
