import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { SQSClient } from '@aws-sdk/client-sqs';
import { ProcessWagerMessageUseCase } from '../../application/process-wager-message.use-case';
import { SqsConsumer } from './sqs-consumer';

// a DLQ do docker-compose segue o nome da fila principal
export function defaultDlqUrl(queueUrl: string): string {
  return queueUrl.replace(/\.fifo$/, '-dlq.fifo');
}

// Sobe o consumidor junto com a aplicação. Sem SQS_QUEUE_URL (ou com SQS_CONSUMER_ENABLED=false) fica desligado.
@Injectable()
export class SqsConsumerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(SqsConsumerService.name);
  private consumer: SqsConsumer | undefined;

  constructor(
    @Inject(SQSClient) private readonly sqs: SQSClient,
    @Inject(ProcessWagerMessageUseCase) private readonly processor: ProcessWagerMessageUseCase,
  ) {}

  onApplicationBootstrap(): void {
    const queueUrl = process.env.SQS_QUEUE_URL;
    if (!queueUrl || process.env.SQS_CONSUMER_ENABLED === 'false') {
      this.logger.warn('SQS consumer disabled');
      return;
    }
    this.consumer = new SqsConsumer(
      this.sqs,
      this.processor,
      {
        queueUrl,
        dlqUrl: process.env.SQS_DLQ_URL ?? defaultDlqUrl(queueUrl),
        maxAttempts: Number(process.env.SQS_MAX_ATTEMPTS ?? 5),
        waitTimeSeconds: Number(process.env.SQS_WAIT_TIME_SECONDS ?? 5),
        backoff: { baseMs: 1_000, maxMs: 60_000 },
      },
      this.logger,
    );
    this.consumer.start();
    this.logger.log('SQS consumer started');
  }

  async onApplicationShutdown(): Promise<void> {
    await this.consumer?.stop();
  }
}
