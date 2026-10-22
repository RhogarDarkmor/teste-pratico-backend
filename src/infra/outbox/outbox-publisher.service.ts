import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { SQSClient } from '@aws-sdk/client-sqs';
import { EntityManager } from '@mikro-orm/postgresql';
import { OutboxPublisher } from './outbox-publisher';
import { SqsMessagePublisher } from './sqs-message-publisher';

@Injectable()
export class OutboxPublisherService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(OutboxPublisherService.name);
  private publisher: OutboxPublisher | undefined;

  constructor(
    @Inject(EntityManager) private readonly em: EntityManager,
    @Inject(SQSClient) private readonly sqs: SQSClient,
  ) {}

  onApplicationBootstrap(): void {
    const queueUrl = process.env.OUTBOX_QUEUE_URL;
    if (!queueUrl || process.env.OUTBOX_PUBLISHER_ENABLED === 'false') {
      this.logger.warn('Outbox publisher disabled');
      return;
    }
    this.publisher = new OutboxPublisher(
      this.em,
      new SqsMessagePublisher(this.sqs, queueUrl),
      {
        batchSize: Number(process.env.OUTBOX_BATCH_SIZE ?? 20),
        pollIntervalMs: Number(process.env.OUTBOX_POLL_INTERVAL_MS ?? 500),
      },
      this.logger,
    );
    this.publisher.start();
    this.logger.log('Outbox publisher started');
  }

  async onApplicationShutdown(): Promise<void> {
    await this.publisher?.stop();
  }
}
