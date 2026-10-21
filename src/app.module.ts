import { Module } from '@nestjs/common';
import { DatabaseModule } from './infra/database/database.module';
import { HealthController } from './health/health.controller';
import { APP_FILTER } from '@nestjs/core';
import { SQSClient } from '@aws-sdk/client-sqs';
import { ApiExceptionFilter } from './http/api-exception.filter';
import { WageringModule } from './http/wagering.module';
import { OutboxPublisherService } from './infra/outbox/outbox-publisher.service';
import { PendingReferenceWorkerService } from './infra/worker/pending-reference-worker.service';
import { EntityManager } from '@mikro-orm/postgresql';
import { ProcessWagerMessageUseCase } from './application/process-wager-message.use-case';
import { SubmitWagerTransactionUseCase } from './application/submit-wager-transaction.use-case';
import { SqsConsumerService } from './infra/sqs/sqs-consumer.service';

@Module({
  imports: [DatabaseModule, WageringModule],
  controllers: [HealthController],
  providers: [
    OutboxPublisherService,
    PendingReferenceWorkerService,
    {
      provide: ProcessWagerMessageUseCase,
      inject: [EntityManager, SubmitWagerTransactionUseCase],
      useFactory: (em: EntityManager, submit: SubmitWagerTransactionUseCase) =>
        new ProcessWagerMessageUseCase(em, submit),
    },
    SqsConsumerService,
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
    {
      provide: SQSClient,
      useFactory: () => {
        const endpoint = process.env.SQS_ENDPOINT ?? process.env.AWS_ENDPOINT_URL;
        return new SQSClient({
          region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1',
          ...(endpoint && {
            endpoint,
            credentials: {
              accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
              secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
            },
          }),
        });
      },
    },
  ],
})
export class AppModule {}
