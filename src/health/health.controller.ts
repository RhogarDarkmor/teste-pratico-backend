import { Controller, Get, Inject, Logger, ServiceUnavailableException } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { GetQueueAttributesCommand, GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';

@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    @Inject(EntityManager) private readonly em: EntityManager,
    @Inject(SQSClient) private readonly sqs: SQSClient,
  ) {}

  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready() {
    const queueName = process.env.SQS_QUEUE_NAME ?? 'wager-transactions.fifo';
    const queueUrl = process.env.SQS_QUEUE_URL;
    const [database, queue] = await Promise.allSettled([
      this.em.execute('select 1'),
      queueUrl
        ? this.sqs.send(
            new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['QueueArn'] }),
            { abortSignal: AbortSignal.timeout(2000) },
          )
        : this.sqs.send(new GetQueueUrlCommand({ QueueName: queueName }), {
            abortSignal: AbortSignal.timeout(2000),
          }),
    ]);
    const checks = {
      postgres: database.status === 'fulfilled' ? 'ok' : 'unavailable',
      sqs:
        queue.status === 'fulfilled' &&
        (('QueueUrl' in queue.value && Boolean(queue.value.QueueUrl)) ||
          ('Attributes' in queue.value && Boolean(queue.value.Attributes?.QueueArn)))
          ? 'ok'
          : 'unavailable',
    } as const;

    if (database.status === 'rejected') {
      this.logger.warn('Readiness check failed for PostgreSQL');
    }
    if (checks.sqs !== 'ok') {
      this.logger.warn(`Readiness check failed for SQS queue ${queueName}`);
    }
    if (checks.postgres !== 'ok' || checks.sqs !== 'ok') {
      throw new ServiceUnavailableException({ status: 'not_ready', checks });
    }
    return { status: 'ready', checks };
  }
}
