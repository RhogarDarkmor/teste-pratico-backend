import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { OutboxMessage } from '../../domain/events/outbox-message';

export interface MessagePublisher {
  publish(message: OutboxMessage): Promise<void>;
}

// O ID deduplica eventos; a carteira mantém a ordem na fila FIFO.
export class SqsMessagePublisher implements MessagePublisher {
  constructor(
    private readonly sqs: Pick<SQSClient, 'send'>,
    private readonly queueUrl: string,
  ) {}

  async publish(message: OutboxMessage): Promise<void> {
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(message.payload),
        MessageGroupId: message.aggregateId,
        MessageDeduplicationId: message.id,
        MessageAttributes: {
          eventType: { DataType: 'String', StringValue: message.eventType },
        },
      }),
    );
  }
}
